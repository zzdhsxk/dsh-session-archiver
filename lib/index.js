/**
 * dsh-session-archiver — Host half.
 * 在 dsh web 里安全地归档 / 恢复 / 移动 / 删除会话（真正移出 sessions 目录，减轻 dsh 扫描与读写负担）。
 * 安全保证：原子 rename、活跃检测、sha256 完整性校验、manifest 台账、默认进回收站；列表带会话标题（读投影缓存）。
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
const TRASH_DIR = path.join(ARCHIVE_DIR, ".trash");
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const API_PREFIX = "/session-archiver/api";

export const name = "dsh-session-archiver";
export const inject = ["webServer"];

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function ensureDirs() {
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
}

async function readManifest() {
  try {
    const m = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
    if (!Array.isArray(m.entries)) m.entries = [];
    return m;
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeManifest(m) {
  await ensureDirs();
  const tmp = MANIFEST_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(m, null, 2), "utf8");
  await fs.rename(tmp, MANIFEST_PATH);
}

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
  const buf = await fs.readFile(fp);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function scanDir(dir) {
  const files = await walkFiles(dir);
  let size = 0;
  let lastWrite = 0;
  for (const f of files) {
    try {
      const st = await fs.stat(f);
      size += st.size;
      lastWrite = Math.max(lastWrite, st.mtimeMs);
    } catch { /* ignore */ }
  }
  return { files, size, lastWrite };
}


/** 读取 dsh 的会话投影缓存，取出人类可读信息（标题 / cwd / 轮次）。 */
async function readProjection(sessionId) {
  const p = path.join(PROJCACHE_DIR, sessionId + ".json");
  try {
    const j = JSON.parse(await fs.readFile(p, "utf8"));
    const rec = j.record || {};
    const rows = rec.rows || {};
    const ident = rec.identity || {};
    const unwrap = (x) => (x && typeof x === "object" && Object.prototype.hasOwnProperty.call(x, "val")) ? x.val : x;
    const title = unwrap(rows.title);
    const input = unwrap(rows.titleInput);
    const stats = unwrap(rows.sessionStats) || {};
    let fallback = null;
    if (input && input.first && typeof input.first.text === "string") fallback = input.first.text;
    return {
      title: (typeof title === "string" && title.trim() !== "") ? title.trim() : (fallback ? String(fallback).trim().slice(0, 60) : null),
      cwd: ident.cwd || null,
      createdAt: ident.createdAt || null,
      turns: typeof stats.turns === "number" ? stats.turns : null,
      steps: typeof stats.steps === "number" ? stats.steps : null
    };
  } catch {
    return null;
  }
}

/** 由 cwd 推导 dsh 的工作区目录名（已验证规则：空格 -> ~0020，/ -> -，前后各补 -）。 */
function encodeWorkspace(cwd) {
  const s = String(cwd || "").split(" ").join("~0020").split("/").join("-");
  return "-" + s + "--";
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
      const sp = path.join(wsPath, s.name);
      const info = await scanDir(sp);
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
        turns: proj ? proj.turns : null
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
    const p = path.join(ARCHIVE_DIR, e.workspace, e.session);
    items.push({
      sessionId: e.session,
      workspace: e.workspace,
      size: e.size || 0,
      archivedAt: e.archivedAt || "",
      title: e.title || null,
      cwd: e.cwd || null,
      turns: typeof e.turns === "number" ? e.turns : null,
      exists: await exists(p)
    });
  }
  items.sort((a, b) => b.size - a.size);
  return items;
}

/** 可用工作区：现有目录 + 投影缓存里出现过的 cwd 推导。 */
async function listWorkspaces() {
  const map = new Map();
  const sessions = await listSessionsOnDisk();
  let wsEntries = [];
  try { wsEntries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true }); } catch { /* ignore */ }
  for (const ws of wsEntries) {
    if (!ws.isDirectory()) continue;
    map.set(ws.name, { encoded: ws.name, cwd: null, count: 0, virtual: false });
  }
  for (const s of sessions) {
    const e = map.get(s.workspace);
    if (e) e.count += 1;
  }
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

async function archiveSession(sessionId, force) {
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
  for (const f of info.files) {
    manifestFiles.push({ path: path.relative(src, f).split(path.sep).join("/"), sha256: await sha256File(f) });
  }
  await ensureDirs();
  await fs.mkdir(destDir, { recursive: true });
  await fs.rename(src, dest);
  const m = await readManifest();
  m.entries = m.entries.filter((e) => !(e.session === hit.sessionId && e.workspace === hit.workspace));
  m.entries.push({
    session: hit.sessionId,
    workspace: hit.workspace,
    archivedAt: new Date().toISOString(),
    size: hit.size,
    title: hit.title || null,
    cwd: hit.cwd || null,
    turns: hit.turns || null,
    files: manifestFiles
  });
  await writeManifest(m);
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
    try {
      const h2 = await sha256File(fp);
      if (h2 !== f.sha256) bad.push(f.path + "(校验和不符)");
    } catch {
      bad.push(f.path + "(缺失)");
    }
  }
  if (bad.length > 0) throw new Error("完整性校验失败，已中止恢复: " + bad.slice(0, 3).join(", "));
  await fs.mkdir(destDir, { recursive: true });
  await fs.rename(src, dest);
  const m2 = await readManifest();
  m2.entries = m2.entries.filter((x) => !(x.session === e.session && x.workspace === e.workspace));
  await writeManifest(m2);
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
    return { sessionId, purged: true, size: hit.size };
  }
  const destDir = path.join(TRASH_DIR, hit.workspace);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, hit.sessionId + "-" + Date.now());
  await fs.rename(src, dest);
  return { sessionId, trashed: true, trashPath: dest, size: hit.size };
}

async function stats() {
  const sessions = await listSessionsOnDisk();
  const archived = await listArchived();
  return {
    sessionCount: sessions.length,
    sessionBytes: sessions.reduce((a, s) => a + s.size, 0),
    archivedCount: archived.length,
    archivedBytes: archived.reduce((a, s) => a + s.size, 0),
    sessionsDir: SESSIONS_DIR,
    archiveDir: ARCHIVE_DIR,
    activeWindowMinutes: ACTIVE_WINDOW_MS / 60000
  };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** 用一个小工具函数生成本文件头部（避免模板字符串里的插值符号）。 */
export function apply(ctx) {
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
          const sessions = await listSessionsOnDisk();
          const archived = await listArchived();
          const workspaces = await listWorkspaces();
          return send(res, 200, { ok: true, result: { sessions, archived, workspaces, stats: await stats() } });
        }
        if (req.method === "GET" && sub === "/workspaces") {
          return send(res, 200, { ok: true, result: { workspaces: await listWorkspaces() } });
        }
        if (req.method === "POST" && sub === "/archive") {
          if (!sessionId) return send(res, 400, { ok: false, error: "sessionId 必填" });
          return send(res, 200, { ok: true, result: await archiveSession(sessionId, body.force === true) });
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
