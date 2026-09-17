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

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const SESSIONS_DIR = path.join(DSH_HOME, "sessions");
const PROJCACHE_DIR = path.join(DSH_HOME, "storages", "session_projcache", "sessions");
const ARCHIVE_DIR = process.env.DSH_SESSION_ARCHIVE || path.join(os.homedir(), "dsh-session-archive");
const MANIFEST_PATH = path.join(ARCHIVE_DIR, "manifest.json");
const CONFIG_PATH = path.join(ARCHIVE_DIR, "config.json");
const OPLOG_PATH = path.join(ARCHIVE_DIR, "operations.log");
const TRASH_DIR = path.join(ARCHIVE_DIR, ".trash");
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
    return m;
  } catch { return { version: 1, entries: [] }; }
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

async function listSessionsOnDisk() {
  const out = [];
  let wsEntries = [];
  try { wsEntries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const ws of wsEntries) {
    if (!ws.isDirectory()) continue;
    const wsPath = path.join(SESSIONS_DIR, ws.name);
    let sessEntries = [];
    try { sessEntries = await fs.readdir(wsPath, { withFileTypes: true }); } catch { continue; }
    for (const s of sessEntries) {
      if (!s.isDirectory()) continue;
      const info = await scanDir(path.join(wsPath, s.name));
      const proj = await readProjection(s.name);
      out.push({
        sessionId: s.name,
        workspace: ws.name,
        size: info.size,
        lastWrite: info.lastWrite,
        active: (Date.now() - info.lastWrite) < ACTIVE_WINDOW_MS,
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

async function listArchived() {
  const m = await readManifest();
  const items = [];
  for (const e of m.entries) {
    items.push({
      sessionId: e.session,
      workspace: e.workspace,
      size: e.size || 0,
      archivedAt: e.archivedAt || "",
      title: e.title || null,
      cwd: e.cwd || null,
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

async function archiveSession(sessionId, force, byAuto) {
  const all = await listSessionsOnDisk();
  const hit = all.find((s) => s.sessionId === sessionId);
  if (!hit) throw new Error("未找到会话: " + sessionId);
  if (hit.active && !force) throw new Error("该会话 10 分钟内仍被写入，已拒绝（可勾选“强制”重试）");
  const src = path.join(SESSIONS_DIR, hit.workspace, hit.sessionId);
  const destDir = path.join(ARCHIVE_DIR, hit.workspace);
  const dest = path.join(destDir, hit.sessionId);
  if (await exists(dest)) throw new Error("归档区已存在同名会话: " + hit.sessionId);
  const info = await scanDir(src);
  const manifestFiles = [];
  for (const f of info.files) manifestFiles.push({ path: path.relative(src, f).split(path.sep).join("/"), sha256: await sha256File(f) });
  await ensureDirs();
  await fs.mkdir(destDir, { recursive: true });
  await fs.rename(src, dest);
  const m = await readManifest();
  m.entries = m.entries.filter((e) => !(e.session === hit.sessionId && e.workspace === hit.workspace));
  m.entries.push({
    session: hit.sessionId, workspace: hit.workspace, archivedAt: new Date().toISOString(),
    size: hit.size, title: hit.title || null, cwd: hit.cwd || null, turns: hit.turns || null,
    subagent: hit.subagent === true, subagentLabel: hit.subagentLabel || null, auto: byAuto === true, files: manifestFiles
  });
  await writeManifest(m);
  await logOp(byAuto ? "archive:auto" : "archive", hit.workspace + "/" + hit.sessionId + " size=" + hit.size);
  return { sessionId: hit.sessionId, workspace: hit.workspace, size: hit.size, files: manifestFiles.length, title: hit.title || null };
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
  await fs.mkdir(destDir, { recursive: true });
  await fs.rename(src, dest);
  const m2 = await readManifest();
  m2.entries = m2.entries.filter((x) => !(x.session === e.session && x.workspace === e.workspace));
  await writeManifest(m2);
  await logOp("restore", e.workspace + "/" + e.session);
  return { sessionId: e.session, workspace: e.workspace, restoredFiles: (e.files || []).length };
}

async function moveSession(sessionId, targetWorkspace) {
  if (!targetWorkspace) throw new Error("targetWorkspace 必填");
  const all = await listSessionsOnDisk();
  const hit = all.find((s) => s.sessionId === sessionId);
  if (!hit) throw new Error("未找到会话: " + sessionId);
  if (hit.active) throw new Error("该会话仍在活跃写入，已拒绝移动（请先让它静置 10 分钟）");
  if (hit.workspace === targetWorkspace) throw new Error("源工作区与目标工作区相同");
  const src = path.join(SESSIONS_DIR, hit.workspace, hit.sessionId);
  const destDir = path.join(SESSIONS_DIR, targetWorkspace);
  const dest = path.join(destDir, hit.sessionId);
  if (await exists(dest)) throw new Error("目标工作区已存在同名会话");
  await fs.mkdir(destDir, { recursive: true });
  await fs.rename(src, dest);
  await logOp("move", hit.workspace + "/" + hit.sessionId + " -> " + targetWorkspace);
  return { sessionId: hit.sessionId, from: hit.workspace, to: targetWorkspace };
}

async function deleteSession(sessionId, purge) {
  const all = await listSessionsOnDisk();
  const hit = all.find((s) => s.sessionId === sessionId);
  if (!hit) throw new Error("未找到会话: " + sessionId);
  if (hit.active) throw new Error("该会话仍活跃（10 分钟内被写入），已拒绝删除");
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
    let t = e.archivedAt ? Date.parse(e.archivedAt) : 0;
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
    const cands = sessions
      .filter((s) => !s.active && (Date.now() - s.lastWrite) > maxIdle)
      .sort((a, b) => a.lastWrite - b.lastWrite);
    for (const c of cands) {
      if (total <= limitBytes * 0.9) break;
      try {
        await archiveSession(c.sessionId, true, true);
        total -= c.size;
        result.archived.push({ sessionId: c.sessionId, size: c.size, subagent: c.subagent === true });
      } catch { /* skip */ }
    }
    if (result.archived.length === 0) result.reason += "（没有「非活跃且闲置超过 " + auto.maxIdleDays + " 天」的会话可归档）";
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
  return {
    sessionCount: sessions.length,
    sessionBytes: sessions.reduce((a, s) => a + s.size, 0),
    subagentCount: sessions.filter((s) => s.subagent).length,
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
