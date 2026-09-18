/**
 * dsh-session-archiver — Host half.
 * 安全归档 / 恢复 / 移动 / 删除 dsh 会话（真正移出 sessions 目录）。
 * 安全保证：原子 rename、活跃检测、sha256 校验、manifest 台账、默认进回收站。
 * 新增：子会话识别（目录无 session- 前缀 / 投影含 subagent 字段）、超阈值自动维护（归档冷会话 / 清回收站 / 可选清超龄归档）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { decodeWorkspace, findSessionLogFile, rewriteSessionCwd } from "./session-header.js";
import { readMetaFromLog } from "./title-fill.js";
import { normalizeLockPath, probeSessionLive, selfLockPaths } from "./live-lock.js";

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const SESSIONS_DIR = path.join(DSH_HOME, "sessions");
const PROJCACHE_DIR = path.join(DSH_HOME, "storages", "session_projcache", "sessions");
const ARCHIVE_DIR = process.env.DSH_SESSION_ARCHIVE || path.join(os.homedir(), "dsh-session-archive");
const MANIFEST_PATH = path.join(ARCHIVE_DIR, "manifest.json");
const CONFIG_PATH = path.join(ARCHIVE_DIR, "config.json");
const OPLOG_PATH = path.join(ARCHIVE_DIR, "operations.log");
const TRASH_DIR = path.join(ARCHIVE_DIR, ".trash");
const HEADER_BACKUP_DIR = path.join(ARCHIVE_DIR, ".header-backups");
const WORKSPACE_JSON = process.env.DSH_WORKSPACE_JSON || path.join(DSH_HOME, "storages", "workspace.json");
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const API_PREFIX = "/session-archiver/api";

/** 自动维护默认值：默认关闭；archiveRetentionDays=0 表示归档区永不自动删除。 */
const AUTO_DEFAULTS = {
  enabled: false,
  checkIntervalMinutes: 60,
  libraryLimitMB: 500,
  maxIdleDays: 7,
  archiveRetentionDays: 0,
  trashRetentionDays: 7,
  lastRunAt: null,
  lastResult: null
};

export const name = "dsh-session-archiver";
export const inject = ["webServer"];

/**
 * dsh 的 sessions 服务（运行期查询，不写进 inject —— 声明进去会变成硬依赖）。
 * 插件的 host 侧就跑在 dsh 进程里，所以这是判断「会话是否仍被 dsh 加载」最权威、最便宜、
 * 且跨平台的一手信息；取不到时再退回操作系统层面的 session.lock 探测（见 live-lock.js）。
 */
let hostCtx = null;
function sessionsService() {
  try { return hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("sessions") : undefined; }
  catch { return undefined; }
}

async function exists(p) { try { await fs.stat(p); return true; } catch { return false; } }
async function ensureDirs() { await fs.mkdir(ARCHIVE_DIR, { recursive: true }); }

async function logOp(op, detail) {
  try {
    await ensureDirs();
    await fs.appendFile(OPLOG_PATH, new Date().toISOString() + "\t" + op + "\t" + detail + "\n", "utf8");
  } catch { /* ignore */ }
}

async function writeJsonAtomic(file, obj) {
  await ensureDirs();
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function readManifest() {
  try {
    const m = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
    if (!Array.isArray(m.entries)) m.entries = [];
    // 早期版本把归档时间写成 archived_at，新版本写 archivedAt：读取时统一，
    // 否则旧记录的「归档时间」在界面上永远是空（接口只认 camelCase）。
    for (const e of m.entries) if (e && !e.archivedAt && e.archived_at) e.archivedAt = e.archived_at;
    return m;
  } catch { return { version: 1, entries: [] }; }
}

/** 取归档时间，兼容旧的 archived_at 写法。 */
function entryArchivedAt(e) {
  return (e && (e.archivedAt || e.archived_at)) || "";
}
async function writeManifest(m) { await writeJsonAtomic(MANIFEST_PATH, m); }

async function readConfig() {
  try {
    const c = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    return { version: 1, auto: Object.assign({}, AUTO_DEFAULTS, c.auto || {}) };
  } catch { return { version: 1, auto: Object.assign({}, AUTO_DEFAULTS) }; }
}
async function writeConfig(c) { await writeJsonAtomic(CONFIG_PATH, c); }

async function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries = [];
    try { entries = await fs.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out.sort();
}

async function sha256File(fp) {
  return crypto.createHash("sha256").update(await fs.readFile(fp)).digest("hex");
}

async function scanDir(dir) {
  const files = await walkFiles(dir);
  let size = 0, lastWrite = 0;
  for (const f of files) {
    try { const st = await fs.stat(f); size += st.size; lastWrite = Math.max(lastWrite, st.mtimeMs); } catch { /* ignore */ }
  }
  return { files, size, lastWrite };
}

/** 目录名不带 session- 前缀 => dsh 的 subagent 子会话（内部会话）。 */
function isSubagentByDir(dirName) { return !String(dirName || "").startsWith("session-"); }

/** 读 dsh 投影缓存：标题 / cwd / 轮次 / 是否子会话。 */
async function readProjection(sessionId) {
  try {
    const j = JSON.parse(await fs.readFile(path.join(PROJCACHE_DIR, sessionId + ".json"), "utf8"));
    const rec = j.record || {}, rows = rec.rows || {}, ident = rec.identity || {};
    const unwrap = (x) => (x && typeof x === "object" && Object.prototype.hasOwnProperty.call(x, "val")) ? x.val : x;
    const title = unwrap(rows.title);
    const input = unwrap(rows.titleInput);
    const stats = unwrap(rows.sessionStats) || {};
    let fallback = null;
    if (input && input.first && typeof input.first.text === "string") fallback = input.first.text;
    // 子会话的唯一可靠标识：rows.subagent 带 identity（主会话是 {} 或 null）
    const subVal = unwrap(rows.subagent);
    const subIdent = (subVal && typeof subVal === "object") ? subVal.identity : null;
    const subagent = Boolean(subIdent && (subIdent.label || subIdent.mode));
    const subagentLabel = subagent ? String(subIdent.label || subIdent.mode).trim().slice(0, 80) : null;
    let titleText = (typeof title === "string" && title.trim() !== "") ? title.trim() : (fallback ? String(fallback).trim().slice(0, 60) : null);
    if (!titleText && subagentLabel) titleText = subagentLabel;
    return {
      title: titleText,
      cwd: ident.cwd || null,
      createdAt: ident.createdAt || null,
      turns: typeof stats.turns === "number" ? stats.turns : null,
      subagent: subagent,
      subagentLabel: subagentLabel,
      parentSessionId: ident.parentSessionId || null
    };
  } catch { return null; }
}

/** 由 cwd 推导工作区目录名（空格 -> ~0020，/ -> -，前后各补 -）。 */
function encodeWorkspace(cwd) {
  return "-" + String(cwd || "").split(" ").join("~0020").split("/").join("-") + "--";
}

/**
 * 一次扫描共用的「是否仍被 dsh 持有」判据：
 * 进程内 sessions 服务（权威、免费）+ 一份本进程锁路径快照（带 3s 缓存的单次 lsof）。
 */
async function liveIndicators() {
  const self = await selfLockPaths();
  const selfSet = self.ok ? new Set([...self.paths].map((p) => normalizeLockPath(p))) : null;
  return { svc: sessionsService(), selfSet, selfOk: self.ok };
}

function heldByIndicators(ind, sessionId, lockPath) {
  if (ind.svc) {
    try {
      const v = ind.svc.get(sessionId);
      if (v !== undefined && v !== null) return true;
    } catch { /* 服务查询异常时退回锁判据 */ }
  }
  if (ind.selfSet && lockPath) return ind.selfSet.has(normalizeLockPath(lockPath));
  return false;
}

async function listSessionsOnDisk() {
  const out = [];
  const ind = await liveIndicators();
  let wsEntries = [];
  try { wsEntries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const ws of wsEntries) {
    if (!ws.isDirectory()) continue;
    const wsPath = path.join(SESSIONS_DIR, ws.name);
    let sessEntries = [];
    try { sessEntries = await fs.readdir(wsPath, { withFileTypes: true }); } catch { continue; }
    for (const s of sessEntries) {
      if (!s.isDirectory()) continue;
      const dir = path.join(wsPath, s.name);
      const info = await scanDir(dir);
      const proj = await readProjection(s.name);
      out.push({
        sessionId: s.name,
        workspace: ws.name,
        size: info.size,
        lastWrite: info.lastWrite,
        active: (Date.now() - info.lastWrite) < ACTIVE_WINDOW_MS,
        // 「活跃」= 最近被写入；「live」= 仍被 dsh 加载在内存里。两者都不该被动。
        live: heldByIndicators(ind, s.name, path.join(dir, "session.lock")),
        title: proj ? proj.title : null,
        cwd: proj ? proj.cwd : null,
        createdAt: proj ? proj.createdAt : null,
        turns: proj ? proj.turns : null,
        subagent: isSubagentByDir(s.name) || Boolean(proj && proj.subagent),
        subagentLabel: proj ? (proj.subagentLabel || null) : null,
        parentSessionId: proj ? proj.parentSessionId : null
      });
    }
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

/**
 * 归档区元数据懒回填（兼容历史数据 + 投影缓存缺失）。
 *
 * 背景：manifest 里的 title/cwd 只是「归档那一刻」的快照。早期版本没记 title，
 * 或归档时投影缓存里还没生成标题 —— 这些条目在界面上就只剩一串 session id。
 * 归档目录里的会话日志带着 dsh 写入的 session/title（其中最后一条才是最终标题），
 * 所以这里补读一次并写回 manifest；用 titleSource 标记来源，有标记就不再重试，
 * 避免每次打开面板都去扫日志。
 */
const FILL_BATCH = 5; // 单轮最多回填条数：扫日志是同步 IO，避免一次性卡住列表接口

async function fillArchivedMeta() {
  const m = await readManifest();
  if (!Array.isArray(m.entries) || m.entries.length === 0) return { filled: 0, pending: 0, handled: 0 };
  let changed = false, filled = 0, handled = 0, pending = 0;
  for (const e of m.entries) {
    if (e.titleSource) continue;                                  // 已定论，不再重试
    if (handled >= FILL_BATCH) { pending += 1; continue; }        // 其余留给下一轮列表
    handled += 1;
    const dir = path.join(ARCHIVE_DIR, e.workspace, e.session);
    const dirExists = await exists(dir);
    let title = e.title || null;
    let cwd = e.cwd || null;
    let source = title ? "manifest" : null;
    // 1) 投影缓存（首选：便宜，且是 dsh 视角下的最终标题）
    if ((!title || !cwd) && dirExists) {
      const proj = await readProjection(e.session);
      if (proj) {
        if (!title && proj.title) { title = proj.title; source = "projection"; }
        if (!cwd && proj.cwd) cwd = proj.cwd;
        if (typeof e.turns !== "number" && typeof proj.turns === "number") e.turns = proj.turns;
        if (e.subagent !== true && proj.subagent === true) e.subagent = true;
        if (!e.subagentLabel && proj.subagentLabel) e.subagentLabel = proj.subagentLabel;
      }
    }
    // 2) 会话日志兜底（投影缓存被清理时唯一还能救回标题的地方）
    if (!title && dirExists) {
      const meta = readMetaFromLog(dir);
      if (meta) {
        if (meta.title) { title = meta.title; source = "log"; }
        if (!cwd && meta.cwd) cwd = meta.cwd;
        if (!e.createdAt && meta.createdAt) e.createdAt = new Date(meta.createdAt).toISOString();
      }
    }
    if (title && !e.title) { e.title = title; filled += 1; }
    if (cwd && !e.cwd) e.cwd = cwd;
    e.titleSource = title ? (source || "manifest") : "none";
    changed = true;
  }
  if (changed) await writeManifest(m);
  return { filled, pending, handled };
}

let fillInflight = null;
let fillQueued = false;
/**
 * 同一进程内并发去重：面板连点刷新时只扫一遍。
 * 待填条目多于单批上限时，把下一批排到后台继续 —— 列表接口不被扫描阻塞，
 * 用户下一次刷新就能看到补齐的标题（每轮都会写 titleSource，所以 pending 必然递减）。
 */
function ensureArchivedMeta() {
  if (!fillInflight) {
    fillInflight = fillArchivedMeta()
      .then((r) => {
        if (r && r.pending > 0 && !fillQueued) {
          fillQueued = true;
          const t = setTimeout(() => { fillQueued = false; ensureArchivedMeta().catch(() => {}); }, 250);
          if (t && typeof t.unref === "function") t.unref();
        }
        return r;
      })
      .catch(() => ({ filled: 0, pending: 0, handled: 0 }))
      .finally(() => { fillInflight = null; });
  }
  return fillInflight;
}

async function listArchived() {
  await ensureArchivedMeta();
  const m = await readManifest();
  const items = [];
  for (const e of m.entries) {
    items.push({
      sessionId: e.session,
      workspace: e.workspace,
      size: e.size || 0,
      archivedAt: entryArchivedAt(e),
      title: e.title || null,
      titleSource: e.titleSource || null,
      cwd: e.cwd || null,
      createdAt: e.createdAt || null,
      turns: typeof e.turns === "number" ? e.turns : null,
      subagent: e.subagent === true || isSubagentByDir(e.session),
      subagentLabel: e.subagentLabel || null,
      auto: e.auto === true,
      exists: await exists(path.join(ARCHIVE_DIR, e.workspace, e.session))
    });
  }
  items.sort((a, b) => b.size - a.size);
  return items;
}

async function listWorkspaces() {
  const map = new Map();
  const sessions = await listSessionsOnDisk();
  let wsEntries = [];
  try { wsEntries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true }); } catch { /* ignore */ }
  for (const ws of wsEntries) {
    if (!ws.isDirectory()) continue;
    map.set(ws.name, { encoded: ws.name, cwd: null, count: 0, virtual: false });
  }
  for (const s of sessions) { const e = map.get(s.workspace); if (e) e.count += 1; }
  let cacheFiles = [];
  try { cacheFiles = await fs.readdir(PROJCACHE_DIR); } catch { /* ignore */ }
  for (const f of cacheFiles) {
    if (!f.endsWith(".json")) continue;
    const proj = await readProjection(f.slice(0, -5));
    if (!proj || !proj.cwd) continue;
    const enc = encodeWorkspace(proj.cwd);
    if (!map.has(enc)) map.set(enc, { encoded: enc, cwd: proj.cwd, count: 0, virtual: true });
    const e = map.get(enc);
    if (!e.cwd) e.cwd = proj.cwd;
  }
  return Array.from(map.values()).sort((a, b) => (b.count - a.count) || a.encoded.localeCompare(b.encoded));
}

/** createdAt 归一化为 ISO 字符串（来源可能是 epoch ms 或已有字符串）。 */
function toIso(v) {
  if (typeof v === "string" && v !== "") return v;
  if (Number.isFinite(v)) { try { return new Date(v).toISOString(); } catch { return null; } }
  return null;
}

/** 「仍被 dsh 持有」的拒绝文案：说清后果与出路，而不是只说「不允许」。 */
function liveRefusalMessage(live) {
  const who = live.by === "os"
    ? "其它进程（PID " + live.pids.join("、") + "）"
    : "dsh 进程";
  return "该会话仍被 " + who + " 持有（已加载在内存中，session.lock 处于打开状态），已拒绝："
    + "移走文件后 dsh 的会话列表仍会显示它（看起来就像归档没生效），而且它之后再写入会让归档副本与 sessions 目录分叉。"
    + "请先重启 dsh web 释放该会话，或勾选「强制」承担风险继续。";
}

async function archiveSession(sessionId, force, byAuto) {
  const all = await listSessionsOnDisk();
  const hit = all.find((s) => s.sessionId === sessionId);
  if (!hit) throw new Error("未找到会话: " + sessionId);
  if (hit.active && !force) throw new Error("该会话 10 分钟内仍被写入，已拒绝（可勾选“强制”重试）");
  // 第二道闸：文件不新 ≠ 没人用。dsh 会把已加载的会话常驻内存，并一直持有 session.lock，
  // 这类会话只按 mtime 判断就会被误当成「闲置」——归档后文件走了、界面还在。
  const live = await probeSessionLive({
    sessionId: hit.sessionId,
    lockPath: path.join(SESSIONS_DIR, hit.workspace, hit.sessionId, "session.lock"),
    sessionsService: sessionsService()
  });
  if (live.held && !force) throw new Error(liveRefusalMessage(live));
  const src = path.join(SESSIONS_DIR, hit.workspace, hit.sessionId);
  const destDir = path.join(ARCHIVE_DIR, hit.workspace);
  const dest = path.join(destDir, hit.sessionId);
  if (await exists(dest)) throw new Error("归档区已存在同名会话: " + hit.sessionId);
  const info = await scanDir(src);
  const manifestFiles = [];
  for (const f of info.files) manifestFiles.push({ path: path.relative(src, f).split(path.sep).join("/"), sha256: await sha256File(f) });

  // 标题快照必须在 rename 之前取全：投影缓存是首选，拿不到就退回会话日志里 dsh 写入的
  // session/title —— 否则 manifest 里会永远留一个 null，归档区就只剩一串 session id。
  let title = hit.title || null;
  let titleSource = title ? "projection" : null;
  let cwd = hit.cwd || null;
  let createdAt = toIso(hit.createdAt);
  if (!title || !cwd || !createdAt) {
    const meta = readMetaFromLog(src);
    if (meta) {
      if (!title && meta.title) { title = meta.title; titleSource = "log"; }
      if (!cwd && meta.cwd) cwd = meta.cwd;
      if (!createdAt && meta.createdAt) createdAt = toIso(meta.createdAt);
    }
  }
  if (!title) titleSource = "none";

  await ensureDirs();
  await fs.mkdir(destDir, { recursive: true });
  await fs.rename(src, dest);
  const m = await readManifest();
  m.entries = m.entries.filter((e) => !(e.session === hit.sessionId && e.workspace === hit.workspace));
  m.entries.push({
    session: hit.sessionId, workspace: hit.workspace, archivedAt: new Date().toISOString(),
    size: hit.size, title: title, titleSource: titleSource, cwd: cwd, turns: hit.turns || null,
    createdAt: createdAt,
    subagent: hit.subagent === true, subagentLabel: hit.subagentLabel || null, auto: byAuto === true, files: manifestFiles
  });
  await writeManifest(m);
  // 同步 dsh 的归档集合：dsh 自己就是用这个把它从侧栏藏起来的（重启后生效）。
  const registry = await syncArchivedSessionIds(hit.sessionId, "add");
  await logOp(byAuto ? "archive:auto" : "archive", hit.workspace + "/" + hit.sessionId + " size=" + hit.size + " title=" + (title || "(无)")
    + (registry.updated ? " [archive-flag synced]" : " [archive-flag skipped: " + (registry.reason || "?") + "]"));
  return {
    sessionId: hit.sessionId, workspace: hit.workspace, size: hit.size, files: manifestFiles.length,
    title: title, titleSource: titleSource,
    forced: force === true, liveAtArchive: live.held, liveSource: live.source, liveProbe: live.probe,
    registryUpdated: !!registry.updated, registryNote: registry.updated ? null : (registry.reason || null),
    hint: registry.updated
      ? "已同步 dsh 的归档集合；重启 dsh web 后该会话会从侧栏彻底消失"
      : null
  };
}

async function restoreSession(sessionId) {
  const m = await readManifest();
  const e = m.entries.find((x) => x.session === sessionId);
  if (!e) throw new Error("归档区未找到: " + sessionId);
  const src = path.join(ARCHIVE_DIR, e.workspace, e.session);
  if (!(await exists(src))) throw new Error("归档文件不存在: " + src);
  const destDir = path.join(SESSIONS_DIR, e.workspace);
  const dest = path.join(destDir, e.session);
  if (await exists(dest)) throw new Error("目标位置已存在同名会话，请先处理: " + e.session);
  const bad = [];
  for (const f of (e.files || [])) {
    const fp = path.join(src, f.path);
    try { if ((await sha256File(fp)) !== f.sha256) bad.push(f.path + "(校验和不符)"); }
    catch { bad.push(f.path + "(缺失)"); }
  }
  if (bad.length > 0) throw new Error("完整性校验失败，已中止恢复: " + bad.slice(0, 3).join(", "));
  // 保险：确保 header.cwd 与恢复后的工作区一致
  // （归档期间工作区若被改名、或该会话归档时就已错位，直接恢复仍会让 dsh 起不来）
  const logFile = findSessionLogFile(src);
  if (logFile) {
    const targetCwd = decodeWorkspace(e.workspace);
    const fix = rewriteSessionCwd(logFile, targetCwd, { apply: true, backupDir: HEADER_BACKUP_DIR });
    if (fix.changed) await logOp("restore", e.workspace + "/" + e.session + " (cwd " + fix.from + " -> " + targetCwd + ")");
  } else {
    throw new Error("归档里没有可识别的 session 日志文件，已拒绝恢复");
  }
  await fs.mkdir(destDir, { recursive: true });
  await fs.rename(src, dest);
  const m2 = await readManifest();
  m2.entries = m2.entries.filter((x) => !(x.session === e.session && x.workspace === e.workspace));
  await writeManifest(m2);
  // 撤销归档集合登记，否则恢复后该会话在侧栏永远是隐藏的（重启后依然隐藏）。
  const registry = await syncArchivedSessionIds(e.session, "remove");
  await logOp("restore", e.workspace + "/" + e.session + (registry.updated ? " [archive-flag cleared]" : " [archive-flag: " + (registry.reason || "?") + "]"));
  return {
    sessionId: e.session, workspace: e.workspace, restoredFiles: (e.files || []).length,
    registryUpdated: !!registry.updated, registryNote: registry.updated ? null : (registry.reason || null),
    hint: registry.updated ? "已从 dsh 的归档集合移除；重启 dsh web 后该会话会重新出现在侧栏" : null
  };
}

/**
 * 同步 dsh 的工作区分组登记（workspace.json 的 tables.workspaces[].sessionIds）。
 * 只改会话文件位置与 header、却不改这份登记，会话会掉进「未分组」。
 * 注意：这是文件层面的修补，需重启 dsh web 才会反映到界面（内存里的注册表才是权威）。
 */
/** 读 dsh 的 workspace.json（补齐我们关心的几个容器，避免调用方各写一遍防御代码）。 */
async function readWorkspaceJson() {
  const j = JSON.parse(await fs.readFile(WORKSPACE_JSON, "utf8"));
  j.global = j.global || {};
  j.tables = j.tables || {};
  j.tables.workspaces = j.tables.workspaces || {};
  if (!Array.isArray(j.global.archivedSessionIds)) j.global.archivedSessionIds = [];
  return j;
}

/** 写回 workspace.json：先留 .bak 备份，再用 2 空格缩进（dsh 自己也是这个风格，便于 diff）。 */
async function writeWorkspaceJson(j) {
  await fs.copyFile(WORKSPACE_JSON, WORKSPACE_JSON + ".bak-" + Date.now());
  await fs.writeFile(WORKSPACE_JSON, JSON.stringify(j, null, 2));
}

/**
 * 同步 dsh 的「归档集合」（workspace.json 的 global.archivedSessionIds）。
 *
 * dsh 自己的归档语义就是往这里记一笔 —— 列进去的会话会从所有分组视图里隐藏。
 * 只把文件移走而不记这一笔：已经加载进内存的会话在界面上照旧可见，用户看到的就是
 * 「归档没生效」。归档时登记、恢复 / 从归档区删除时撤销，两边保持对称。
 *
 * 与 syncWorkspaceRegistry 同样是**文件层面的修补**：内存里的注册表才是权威，
 * 需要重启 dsh web 才会反映到界面（响应里会带 hint 提醒）。
 */
async function syncArchivedSessionIds(sessionId, mode) {
  try {
    if (!(await exists(WORKSPACE_JSON))) return { updated: false, reason: "没有 workspace.json" };
    const j = await readWorkspaceJson();
    const ids = j.global.archivedSessionIds;
    const key = sessionIdKey(sessionId);
    const has = ids.some((x) => sessionIdKey(x) === key);
    const want = mode === "add";
    if (want === has) return { updated: false, reason: want ? "已在归档集合中" : "不在归档集合中", noop: true };
    j.global.archivedSessionIds = want ? [...ids, sessionId] : ids.filter((x) => sessionIdKey(x) !== key);
    await writeWorkspaceJson(j);
    return { updated: true, count: j.global.archivedSessionIds.length };
  } catch (err) {
    return { updated: false, reason: err && err.message ? err.message : String(err) };
  }
}

async function syncWorkspaceRegistry(sessionId, targetWorkspacePath) {
  try {
    if (!(await exists(WORKSPACE_JSON))) return { updated: false, reason: "没有 workspace.json" };
    const j = await readWorkspaceJson();
    const list = Object.values(j.tables.workspaces);
    let target = null;
    for (const w of list) {
      if (w && w.path && path.resolve(w.path) === path.resolve(targetWorkspacePath)) target = w;
    }
    if (!target) return { updated: false, reason: "目标工作区未在注册表里" };
    const before = list.filter((w) => (w.sessionIds || []).includes(sessionId)).map((w) => w.path);
    for (const w of list) w.sessionIds = (w.sessionIds || []).filter((s) => s !== sessionId);
    target.sessionIds = (target.sessionIds || []).concat([sessionId]).filter((s, i, a) => a.indexOf(s) === i);
    target.updatedAt = new Date().toISOString();
    await writeWorkspaceJson(j);
    return { updated: true, from: before, to: targetWorkspacePath };
  } catch (err) {
    return { updated: false, reason: err && err.message ? err.message : String(err) };
  }
}

async function moveSession(sessionId, targetWorkspace) {

  if (!targetWorkspace) throw new Error("targetWorkspace 必填");
  const all = await listSessionsOnDisk();
  const hit = all.find((s) => s.sessionId === sessionId);
  if (!hit) throw new Error("未找到会话: " + sessionId);
  if (hit.active) throw new Error("该会话仍在活跃写入，已拒绝移动（请先让它静置 10 分钟）");
  const movedLive = await probeSessionLive({
    sessionId: hit.sessionId,
    lockPath: path.join(SESSIONS_DIR, hit.workspace, hit.sessionId, "session.lock"),
    sessionsService: sessionsService()
  });
  if (movedLive.held) throw new Error("该会话仍被 dsh 持有（内存中已加载），移动它会同时改 header.cwd，风险太大，已拒绝。请先重启 dsh web。");
  if (hit.workspace === targetWorkspace) throw new Error("源工作区与目标工作区相同");
  const src = path.join(SESSIONS_DIR, hit.workspace, hit.sessionId);
  const destDir = path.join(SESSIONS_DIR, targetWorkspace);
  const dest = path.join(destDir, hit.sessionId);
  if (await exists(dest)) throw new Error("目标工作区已存在同名会话");

  // 关键：会话 header 里存着 cwd，dsh 启动时会用它校验文件位置；
  // 只 rename 不改 header 会让整个 dsh web 起不来（corrupt session log）。
  const targetCwd = decodeWorkspace(targetWorkspace);
  const logFile = findSessionLogFile(src);
  let cwdFix = null;
  if (logFile) {
    cwdFix = rewriteSessionCwd(logFile, targetCwd, { apply: true, backupDir: HEADER_BACKUP_DIR });
  } else {
    throw new Error("该会话没有可识别的 session 日志文件，已拒绝移动");
  }

  await fs.mkdir(destDir, { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (err) {
    // 回滚 header，避免留下「改过 cwd 但没移动」的坏状态
    if (cwdFix && cwdFix.changed) {
      try { rewriteSessionCwd(logFile, cwdFix.from, { apply: true }); } catch (e) { /* 备份文件可手动恢复 */ }
    }
    throw err;
  }
  const registry = await syncWorkspaceRegistry(hit.sessionId, targetCwd);
  await logOp("move", hit.workspace + "/" + hit.sessionId + " -> " + targetWorkspace + " (cwd " + (cwdFix ? cwdFix.from : "?") + " -> " + targetCwd + ")" + (registry.updated ? " [registry synced]" : " [registry skipped: " + (registry.reason || "?") + "]"));
  return {
    sessionId: hit.sessionId,
    from: hit.workspace,
    to: targetWorkspace,
    cwdFrom: cwdFix ? cwdFix.from : null,
    cwdTo: targetCwd,
    headerRewritten: !!(cwdFix && cwdFix.applied),
    registryUpdated: !!registry.updated,
    registryNote: registry.updated ? null : (registry.reason || null),
    hint: "跨工作区移动后需重启 dsh web，界面上的分组变化才会生效"
  };
}

/** 会话 ID 归一化：归档记录里同时存在「带 session- 前缀」和「不带前缀」两种形态 */
function sessionIdKey(x) {
  return String(x || "").replace(/^session-/, "");
}

/**
 * 从归档区删除会话（并清掉 manifest 里的登记）。
 * 归档的会话已移出 sessions 目录，所以必须单独走这条路 —— 否则界面「已归档」页签点删除
 * 会全部报「未找到会话」。找不到时返回 null，交由调用方决定错误信息。
 */
async function purgeFromArchive(sessionId) {
  const m = await readManifest();
  const entries = m.entries || [];
  const key = sessionIdKey(sessionId);
  const e = entries.find((x) => sessionIdKey(x.session) === key);
  if (!e) return null;
  const src = path.join(ARCHIVE_DIR, e.workspace, e.session);
  // 不直接 rm：先移进归档区内的回收站（同盘 rename，瞬时），留一条退路；
  // 之后由 trashRetentionDays 自动清理。
  const destDir = path.join(TRASH_DIR, e.workspace);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, e.session + "-" + Date.now());
  try {
    await fs.rename(src, dest);
  } catch (err) {
    // 跨设备等无法 rename 时退化为复制后删除
    await fs.cp(src, dest, { recursive: true, force: true });
    await fs.rm(src, { recursive: true, force: true });
  }
  const m2 = await readManifest();
  m2.entries = (m2.entries || []).filter((x) => !(x.session === e.session && x.workspace === e.workspace));
  await writeManifest(m2);
  // 会话已经不在归档区了，登记就没必要留着（否则归档集合只增不减）。
  const registry = await syncArchivedSessionIds(e.session, "remove");
  await logOp("trash-archive", e.workspace + "/" + e.session + " -> " + dest + (registry.updated ? " [archive-flag cleared]" : ""));
  return { sessionId: e.session, workspace: e.workspace, trashedFromArchive: true, trashPath: dest, files: (e.files || []).length, registryUpdated: !!registry.updated };
}

async function deleteSession(sessionId, purge) {
  const all = await listSessionsOnDisk();
  const key = sessionIdKey(sessionId);
  const hit = all.find((s) => sessionIdKey(s.sessionId) === key);
  if (!hit) {
    // 不在活跃目录 —— 可能是归档区的会话（「已归档」页签的删除按钮走的就是这里）
    const archived = await purgeFromArchive(sessionId);
    if (archived) return archived;
    throw new Error("未找到会话（活跃目录与归档区都没有）: " + sessionId);
  }
  if (hit.active) throw new Error("该会话仍活跃（10 分钟内被写入），已拒绝删除");
  const deletedLive = await probeSessionLive({
    sessionId: hit.sessionId,
    lockPath: path.join(SESSIONS_DIR, hit.workspace, hit.sessionId, "session.lock"),
    sessionsService: sessionsService()
  });
  if (deletedLive.held) throw new Error("该会话仍被 dsh 持有（内存中已加载），直接删除它会让界面继续引用一个不存在的会话，已拒绝。请先重启 dsh web。");
  const src = path.join(SESSIONS_DIR, hit.workspace, hit.sessionId);
  if (purge) {
    await fs.rm(src, { recursive: true, force: true });
    await logOp("purge", hit.workspace + "/" + hit.sessionId + " size=" + hit.size);
    return { sessionId, purged: true, size: hit.size };
  }
  const destDir = path.join(TRASH_DIR, hit.workspace);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, hit.sessionId + "-" + Date.now());
  await fs.rename(src, dest);
  await logOp("trash", hit.workspace + "/" + hit.sessionId + " -> " + dest);
  return { sessionId, trashed: true, trashPath: dest, size: hit.size };
}

async function purgeExpiredTrash(retentionDays) {
  const removed = [];
  if (!retentionDays || retentionDays <= 0) return removed;
  const cutoff = Date.now() - retentionDays * 86400000;
  let wsDirs = [];
  try { wsDirs = await fs.readdir(TRASH_DIR, { withFileTypes: true }); } catch { return removed; }
  for (const ws of wsDirs) {
    if (!ws.isDirectory()) continue;
    const wsPath = path.join(TRASH_DIR, ws.name);
    let items = [];
    try { items = await fs.readdir(wsPath, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const ip = path.join(wsPath, it.name);
      try {
        const st = await fs.stat(ip);
        if (st.mtimeMs < cutoff) { await fs.rm(ip, { recursive: true, force: true }); removed.push(ws.name + "/" + it.name); }
      } catch { /* ignore */ }
    }
  }
  if (removed.length > 0) await logOp("trash:auto-purge", removed.length + " 项");
  return removed;
}

async function purgeExpiredArchives(retentionDays) {
  const removed = [];
  if (!retentionDays || retentionDays <= 0) return removed;
  const cutoff = Date.now() - retentionDays * 86400000;
  const m = await readManifest();
  const keep = [];
  for (const e of m.entries) {
    const p = path.join(ARCHIVE_DIR, e.workspace, e.session);
    const stamp = entryArchivedAt(e);
    let t = stamp ? Date.parse(stamp) : 0;
    try { t = (await fs.stat(p)).mtimeMs; } catch { /* keep t */ }
    if (t && t < cutoff) {
      try { await fs.rm(p, { recursive: true, force: true }); removed.push(e.workspace + "/" + e.session); }
      catch { keep.push(e); }
    } else keep.push(e);
  }
  if (removed.length > 0) { m.entries = keep; await writeManifest(m); await logOp("archive:auto-purge", removed.length + " 项"); }
  return removed;
}

/** 自动维护：会话库超限 -> 归档最旧的闲置会话；再清回收站 / 可选清超龄归档。 */
async function autoMaintain(force) {
  const cfg = await readConfig();
  const auto = cfg.auto;
  if (!auto.enabled && !force) return { skipped: "disabled" };
  const interval = (auto.checkIntervalMinutes || 60) * 60000;
  const last = auto.lastRunAt ? Date.parse(auto.lastRunAt) : 0;
  if (!force && Date.now() - last < interval) return { skipped: "not-due" };

  const result = { at: new Date().toISOString(), archived: [], trashPurged: [], archivePurged: [], reason: null };
  const sessions = await listSessionsOnDisk();
  let total = sessions.reduce((a, s) => a + s.size, 0);
  const limitBytes = (auto.libraryLimitMB || 500) * 1024 * 1024;

  if (total > limitBytes) {
    result.reason = "会话库 " + Math.round(total / 1048576) + " MB 超过阈值 " + auto.libraryLimitMB + " MB";
    const maxIdle = (auto.maxIdleDays || 7) * 86400000;
    // 注意：只挑「未被写入 且 未被 dsh 持有」的会话。自动维护绝不能走 force 绕过闸门，
    // 否则又会把内存里的会话移走，重演「归档没生效」。
    const cands = sessions
      .filter((s) => !s.active && !s.live && (Date.now() - s.lastWrite) > maxIdle)
      .sort((a, b) => a.lastWrite - b.lastWrite);
    for (const c of cands) {
      if (total <= limitBytes * 0.9) break;
      try {
        await archiveSession(c.sessionId, false, true);
        total -= c.size;
        result.archived.push({ sessionId: c.sessionId, size: c.size, subagent: c.subagent === true });
      } catch { /* skip */ }
    }
    if (result.archived.length === 0) result.reason += "（没有「未被 dsh 加载、且闲置超过 " + auto.maxIdleDays + " 天」的会话可归档）";
  }

  result.trashPurged = await purgeExpiredTrash(auto.trashRetentionDays || 0);
  result.archivePurged = await purgeExpiredArchives(auto.archiveRetentionDays || 0);

  auto.lastRunAt = result.at;
  auto.lastResult = result;
  cfg.auto = auto;
  await writeConfig(cfg);
  return result;
}

async function stats() {
  const sessions = await listSessionsOnDisk();
  const archived = await listArchived();
  const self = await selfLockPaths();
  return {
    sessionCount: sessions.length,
    sessionBytes: sessions.reduce((a, s) => a + s.size, 0),
    subagentCount: sessions.filter((s) => s.subagent).length,
    // 仍被 dsh 加载在内存里的会话数：这些在重启前无法真正「归档干净」。
    liveCount: sessions.filter((s) => s.live).length,
    liveProbe: self.ok ? "ok" : "unsupported",
    archivedCount: archived.length,
    archivedBytes: archived.reduce((a, s) => a + s.size, 0),
    sessionsDir: SESSIONS_DIR,
    archiveDir: ARCHIVE_DIR,
    activeWindowMinutes: ACTIVE_WINDOW_MS / 60000
  };
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function sanitizeAuto(input, base) {
  const out = Object.assign({}, AUTO_DEFAULTS, base || {});
  if (input && typeof input === "object") {
    if (typeof input.enabled === "boolean") out.enabled = input.enabled;
    for (const k of ["checkIntervalMinutes", "libraryLimitMB", "maxIdleDays", "archiveRetentionDays", "trashRetentionDays"]) {
      const v = Number(input[k]);
      if (Number.isFinite(v) && v >= 0) out[k] = v;
    }
  }
  if (out.checkIntervalMinutes < 5) out.checkIntervalMinutes = 5;
  if (out.libraryLimitMB < 10) out.libraryLimitMB = 10;
  return out;
}

export function apply(ctx) {
  // 记下宿主 ctx：归档判定要问 dsh「这个会话还在内存里吗」（见 sessionsService）。
  hostCtx = ctx;
  // 自动维护定时器：每分钟醒一次，真正执行与否由配置的检查间隔决定
  ctx.effect(() => {
    const timer = setInterval(() => {
      autoMaintain(false).then((r) => {
        if (r && ((r.archived && r.archived.length > 0) || (r.trashPurged && r.trashPurged.length > 0) || (r.archivePurged && r.archivePurged.length > 0))) {
          ctx.logger.info("session-archiver: 自动维护完成 archived=" + r.archived.length + " trashPurged=" + r.trashPurged.length + " archivePurged=" + r.archivePurged.length);
        }
      }).catch((e) => ctx.logger.warn("session-archiver: 自动维护失败 " + String(e && e.message ? e.message : e)));
    }, 60000);
    return () => clearInterval(timer);
  }, "session-archiver: auto maintain timer");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || "/", "http://localhost");
        const sub = url.pathname.startsWith(API_PREFIX) ? (url.pathname.slice(API_PREFIX.length) || "/") : "/";
        let body = {};
        if (req.method === "POST") {
          const raw = await readBody(req);
          if (raw.trim() !== "") {
            try { body = JSON.parse(raw); } catch { return send(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          }
        }
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";

        if (req.method === "GET" && sub === "/list") {
          const cfg = await readConfig();
          return send(res, 200, { ok: true, result: {
            sessions: await listSessionsOnDisk(),
            archived: await listArchived(),
            workspaces: await listWorkspaces(),
            stats: await stats(),
            auto: cfg.auto
          } });
        }
        if (req.method === "GET" && sub === "/workspaces") return send(res, 200, { ok: true, result: { workspaces: await listWorkspaces() } });
        if (req.method === "GET" && sub === "/config") { const cfg = await readConfig(); return send(res, 200, { ok: true, result: { auto: cfg.auto } }); }
        if (req.method === "POST" && sub === "/config") {
          const cfg = await readConfig();
          cfg.auto = sanitizeAuto(body.auto || body, cfg.auto);
          await writeConfig(cfg);
          await logOp("config", JSON.stringify(cfg.auto));
          return send(res, 200, { ok: true, result: { auto: cfg.auto } });
        }
        if (req.method === "POST" && sub === "/maintain") return send(res, 200, { ok: true, result: await autoMaintain(true) });
        if (req.method === "POST" && sub === "/archive") {
          if (!sessionId) return send(res, 400, { ok: false, error: "sessionId 必填" });
          return send(res, 200, { ok: true, result: await archiveSession(sessionId, body.force === true, false) });
        }
        if (req.method === "POST" && sub === "/restore") {
          if (!sessionId) return send(res, 400, { ok: false, error: "sessionId 必填" });
          return send(res, 200, { ok: true, result: await restoreSession(sessionId) });
        }
        if (req.method === "POST" && sub === "/move") {
          if (!sessionId) return send(res, 400, { ok: false, error: "sessionId 必填" });
          return send(res, 200, { ok: true, result: await moveSession(sessionId, String(body.targetWorkspace || "")) });
        }
        if (req.method === "POST" && sub === "/trash") {
          if (!sessionId) return send(res, 400, { ok: false, error: "sessionId 必填" });
          return send(res, 200, { ok: true, result: await deleteSession(sessionId, false) });
        }
        if (req.method === "POST" && sub === "/purge") {
          if (!sessionId) return send(res, 400, { ok: false, error: "sessionId 必填" });
          return send(res, 200, { ok: true, result: await deleteSession(sessionId, true) });
        }
        return send(res, 404, { ok: false, error: "未知端点: " + sub });
      } catch (error) {
        const msg = error && error.message ? error.message : String(error);
        ctx.logger.warn("session-archiver: api error: " + msg);
        return send(res, 500, { ok: false, error: msg });
      }
    }
  }), "session-archiver: api routes");
}

export { deleteSession, purgeFromArchive, sessionIdKey, fillArchivedMeta, listArchived, archiveSession, restoreSession };
