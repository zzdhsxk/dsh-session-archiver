/**
 * 回归测试：会话「仍被 dsh 持有」时的归档闸门、归档集合同步、旧字段兼容。
 *
 * 全程在 mkdtemp 沙箱里跑（DSH_HOME / 归档区都指向临时目录），绝不触碰真实 ~/.dsh。
 * 运行：node test/live-archive.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

// ── 沙箱 ────────────────────────────────────────────────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-archiver-test-"));
const HOME = path.join(sandbox, "dsh");
const ARCHIVE = path.join(sandbox, "archive");
const SESSIONS = path.join(HOME, "sessions");
const WORKSPACE_JSON = path.join(HOME, "storages", "workspace.json");

process.env.DSH_HOME = HOME;
process.env.DSH_SESSION_ARCHIVE = ARCHIVE;
delete process.env.DSH_WORKSPACE_JSON;

const WS = "--Users-tester-proj--";
const CWD = "/Users/tester/proj";

// ── 夹具 ────────────────────────────────────────────────────────────────────
function makeLog(cwd, title) {
  const frames = [
    zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", id: "x", cwd, createdAt: 1700000000000 }) + "\n"), CHECKSUM_OPTIONS)
  ];
  if (title) frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "session/title", data: { title, source: { kind: "provider" } } }) + "\n"), CHECKSUM_OPTIONS));
  return Buffer.concat(frames);
}

const AGE_MS = 2 * 86400000; // 2 天前：mtime 闸门（10 分钟）放行，隔离出「被持有」闸门

/**
 * 模拟 dsh 持有会话：打开 session.lock 并保持 fd，同时把 mtime 做旧
 * —— 真实 dsh 也是这样：锁一直开着，但日志可能几十分钟没写。
 */
function holdLock(dir) {
  const lock = path.join(dir, "session.lock");
  const fd = fs.openSync(lock, "w");
  const old = new Date(Date.now() - AGE_MS);
  fs.utimesSync(lock, old, old);
  return fd;
}

function makeSession(id, { title = null, padBytes = 0 } = {}) {
  const dir = path.join(SESSIONS, WS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.v3.jsonl.zstd"), makeLog(CWD, title));
  fs.writeFileSync(path.join(dir, "session.lock"), "");
  if (padBytes > 0) fs.writeFileSync(path.join(dir, "pad.bin"), Buffer.alloc(padBytes));
  // 把所有文件改成「很久没写」，让 mtime 判据认为它闲置
  const old = new Date(Date.now() - AGE_MS);
  for (const n of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, n), old, old);
  fs.utimesSync(dir, old, old);
  return dir;
}

const LIVE_ID = "session-live-0001-0000-0000-000000000001";
const IDLE_ID = "session-idle-0002-0000-0000-000000000002";

makeSession(LIVE_ID, { title: "被 dsh 加载的会话" });
makeSession(IDLE_ID, { title: "闲置会话" });

fs.mkdirSync(path.dirname(WORKSPACE_JSON), { recursive: true });
function writeWorkspace(state) { fs.writeFileSync(WORKSPACE_JSON, JSON.stringify(state, null, 2)); }
writeWorkspace({
  unit: { name: "workspace", version: 2 },
  global: { initialized: true, workspaceIds: ["ws-1"], archivedSessionIds: [] },
  tables: { workspaces: { "ws-1": { path: CWD, title: "proj", sessionIds: [LIVE_ID, IDLE_ID], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } } }
});
function readWorkspace() { return JSON.parse(fs.readFileSync(WORKSPACE_JSON, "utf8")); }

// ── 装配 host 侧（假 ctx）──────────────────────────────────────────────────
const mod = await import("../lib/index.js");
const liveLock = await import("../lib/live-lock.js");

let handler = null;
const disposers = [];
let fakeSessions = null; // 需要时注入「进程内 sessions 服务」
const fakeCtx = {
  effect: (fn) => { const d = fn(); if (typeof d === "function") disposers.push(d); },
  webServer: { register: (route) => { handler = route.handler; return () => {}; } },
  get: (name) => (name === "sessions" && fakeSessions ? fakeSessions : undefined),
  logger: { info() {}, warn() {}, error() {} }
};
mod.apply(fakeCtx);

async function api(method, sub, body) {
  const req = {
    method,
    url: "/session-archiver/api" + sub,
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); }
  };
  let out = null;
  const res = { code: 0, writeHead(c) { this.code = c; }, end(t) { out = { code: this.code, json: JSON.parse(t) }; } };
  await handler(req, res);
  return out;
}

// ── 断言 ────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log("  ✅ " + name); }
  else { fail += 1; console.log("  ❌ " + name + (extra !== undefined ? "  → " + extra : "")); }
}
const findSession = (list, id) => list.find((s) => s.sessionId === id);

// ── 用例 ────────────────────────────────────────────────────────────────────
console.log("\n[1] 初始 list：两个会话都未被持有");
liveLock.resetLiveCache();
let list = await api("GET", "/list");
check("list 返回 ok", list.json.ok === true, JSON.stringify(list.json).slice(0, 200));
let cur = list.json.result.sessions;
check("两个会话都在", cur.length === 2, cur.map((s) => s.sessionId).join(","));
check("LIVE 初始 live=false", findSession(cur, LIVE_ID)?.live === false);
check("统计 liveCount=0", list.json.result.stats.liveCount === 0);
check("锁探测可用 liveProbe=ok", list.json.result.stats.liveProbe === "ok", list.json.result.stats.liveProbe);

console.log("\n[2] 本进程持有 LIVE 的 session.lock 后，list 应标为 live");
const liveSessionDir = path.join(SESSIONS, WS, LIVE_ID);
const lockFd = holdLock(liveSessionDir); // 模拟 dsh：保持打开且日志很久没写
liveLock.resetLiveCache();
list = await api("GET", "/list");
cur = list.json.result.sessions;
check("LIVE live=true", findSession(cur, LIVE_ID)?.live === true);
check("IDLE live=false", findSession(cur, IDLE_ID)?.live === false);
check("统计 liveCount=1", list.json.result.stats.liveCount === 1, String(list.json.result.stats.liveCount));

console.log("\n[3] 归档被持有的会话：拒绝，且不动文件");
let res = await api("POST", "/archive", { sessionId: LIVE_ID });
check("HTTP 500", res.code === 500, String(res.code));
check("报错说明原因与出路", /仍被/.test(res.json.error) && /重启 dsh web/.test(res.json.error), res.json.error);
check("源目录仍在", fs.existsSync(path.join(SESSIONS, WS, LIVE_ID)));
check("没有进归档区", !fs.existsSync(path.join(ARCHIVE, WS, LIVE_ID)));

console.log("\n[4] 勾选强制：允许归档，并登记 dsh 的归档集合");
res = await api("POST", "/archive", { sessionId: LIVE_ID, force: true });
check("归档成功", res.json.ok === true, JSON.stringify(res.json).slice(0, 300));
check("移入归档区", fs.existsSync(path.join(ARCHIVE, WS, LIVE_ID)));
check("源目录已移走", !fs.existsSync(path.join(SESSIONS, WS, LIVE_ID)));
check("返回 liveAtArchive=true", res.json.result.liveAtArchive === true);
check("返回 registryUpdated=true", res.json.result.registryUpdated === true, JSON.stringify(res.json.result));
check("workspace.json 登记了 archivedSessionIds", readWorkspace().global.archivedSessionIds.includes(LIVE_ID));
check("workspace.json 有 .bak 备份", fs.readdirSync(path.dirname(WORKSPACE_JSON)).some((n) => n.startsWith("workspace.json.bak-")));
check("manifest 记录 archivedAt", JSON.parse(fs.readFileSync(path.join(ARCHIVE, "manifest.json"), "utf8")).entries.some((e) => e.session === LIVE_ID && e.archivedAt));

console.log("\n[5] 归档未被持有的闲置会话：正常通过");
liveLock.resetLiveCache();
res = await api("POST", "/archive", { sessionId: IDLE_ID });
check("归档成功", res.json.ok === true, JSON.stringify(res.json).slice(0, 300));
check("返回 liveAtArchive=false", res.json.result.liveAtArchive === false);

console.log("\n[6] 恢复：撤销归档集合登记");
res = await api("POST", "/restore", { sessionId: LIVE_ID });
check("恢复成功", res.json.ok === true, JSON.stringify(res.json).slice(0, 300));
check("文件回到 sessions", fs.existsSync(path.join(SESSIONS, WS, LIVE_ID)));
check("archivedSessionIds 已撤销", !readWorkspace().global.archivedSessionIds.includes(LIVE_ID), JSON.stringify(readWorkspace().global.archivedSessionIds));
// 清掉 LOCK 后重开，模拟 dsh 仍持有（restore 不改持有点）

console.log("\n[7] 删除 / 移动被持有的会话：一律拒绝");
res = await api("POST", "/trash", { sessionId: LIVE_ID });
check("trash 拒绝", res.code === 500 && /仍被 dsh 持有/.test(res.json.error), res.json.error);
res = await api("POST", "/move", { sessionId: LIVE_ID, targetWorkspace: "--Users-tester-other--" });
check("move 拒绝", res.code === 500 && /仍被 dsh 持有/.test(res.json.error), res.json.error);

console.log("\n[8] 旧 manifest 条目（archived_at 字段）也要显示归档时间");
const legacyId = "session-legacy-0003-0000-0000-000000000003";
fs.mkdirSync(path.join(ARCHIVE, WS, legacyId), { recursive: true });
fs.writeFileSync(path.join(ARCHIVE, WS, legacyId, "session.v3.jsonl.zstd"), makeLog(CWD, "旧记录"));
const mfPath = path.join(ARCHIVE, "manifest.json");
const mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));
mf.entries.push({ session: legacyId, workspace: WS, archived_at: "2026-09-01T10:00:00.000Z", size: 100, title: "旧记录", titleSource: "manifest", files: [] });
fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
list = await api("GET", "/list");
const legacy = list.json.result.archived.find((e) => e.sessionId === legacyId);
check("旧条目 archivedAt 非空", !!legacy && legacy.archivedAt === "2026-09-01T10:00:00.000Z", JSON.stringify(legacy));

console.log("\n[9] 自动维护只归档「未被持有」的会话");
// 造一个体积超阈值（>=10MB）的会话库：一个大的被持有、一个大的闲置
const BIG_LIVE = "session-biglive-0004-0000-0000-000000000004";
const BIG_IDLE = "session-bigidle-0005-0000-0000-000000000005";
makeSession(BIG_LIVE, { padBytes: 12 * 1024 * 1024 });
makeSession(BIG_IDLE, { padBytes: 6 * 1024 * 1024 });
const bigLiveFd = holdLock(path.join(SESSIONS, WS, BIG_LIVE)); // 关键：持有它
liveLock.resetLiveCache();
const cfgRes = await api("POST", "/config", { auto: { enabled: true, libraryLimitMB: 10, maxIdleDays: 1, checkIntervalMinutes: 5 } });
check("自动维护配置写入", cfgRes.json.ok === true, JSON.stringify(cfgRes.json).slice(0, 200));
const maintain = await api("POST", "/maintain", {});
const archivedIds = (maintain.json.result.archived || []).map((x) => x.sessionId);
check("超阈值被识别", /超过阈值/.test(maintain.json.result.reason || ""), maintain.json.result.reason);
check("归档了闲置的大会话", archivedIds.includes(BIG_IDLE), JSON.stringify(archivedIds));
check("没有归档被持有的会话", !archivedIds.includes(BIG_LIVE), JSON.stringify(archivedIds));
check("被持有的会话仍在 sessions", fs.existsSync(path.join(SESSIONS, WS, BIG_LIVE)));

console.log("\n[10] 从归档区删除：撤销归档集合登记");
liveLock.resetLiveCache();
const delRes = await api("POST", "/trash", { sessionId: IDLE_ID });
check("归档区删除成功", delRes.json.ok === true, JSON.stringify(delRes.json).slice(0, 300));
check("登记已清除", !readWorkspace().global.archivedSessionIds.includes(IDLE_ID), JSON.stringify(readWorkspace().global.archivedSessionIds));

console.log("\n[11] 最终 list 不崩、无残留坏数据");
liveLock.resetLiveCache();
list = await api("GET", "/list");
check("list ok", list.json.ok === true);
check("归档条目都有归档时间", list.json.result.archived.every((e) => !!e.archivedAt), JSON.stringify(list.json.result.archived.map((e) => [e.sessionId, e.archivedAt])));

console.log("\n[12] 跨工作区移动（重构过 workspace.json 写入助手，必须覆盖）");
const MOVE_ID = "session-move-0006-0000-0000-000000000006";
const OTHER_CWD = "/Users/tester/other";
const OTHER_WS = "--Users-tester-other--";
makeSession(MOVE_ID, { title: "待移动的会话" });
// 第二个工作区登记进注册表
const wsState = readWorkspace();
wsState.global.workspaceIds.push("ws-2");
wsState.tables.workspaces["ws-2"] = { path: OTHER_CWD, title: "other", sessionIds: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
wsState.tables.workspaces["ws-1"].sessionIds.push(MOVE_ID);
writeWorkspace(wsState);
liveLock.resetLiveCache();
const mvRes = await api("POST", "/move", { sessionId: MOVE_ID, targetWorkspace: OTHER_WS });
check("移动成功", mvRes.json.ok === true, JSON.stringify(mvRes.json).slice(0, 300));
check("目录已到目标工作区", fs.existsSync(path.join(SESSIONS, OTHER_WS, MOVE_ID)));
check("源目录已不存在", !fs.existsSync(path.join(SESSIONS, WS, MOVE_ID)));
check("注册表登记已迁移", (() => {
  const s = readWorkspace();
  return !s.tables.workspaces["ws-1"].sessionIds.includes(MOVE_ID) && s.tables.workspaces["ws-2"].sessionIds.includes(MOVE_ID);
})(), JSON.stringify(readWorkspace().tables.workspaces));
const headerAfter = (await import("../lib/session-header.js")).readSessionHeader(path.join(SESSIONS, OTHER_WS, MOVE_ID, "session.v3.jsonl.zstd")).header;
check("header.cwd 已改写", headerAfter.cwd === OTHER_CWD, JSON.stringify(headerAfter));

// ── 收尾 ────────────────────────────────────────────────────────────────────
fs.closeSync(lockFd);
try { fs.closeSync(bigLiveFd); } catch { /* 未定义或已关 */ }
for (const d of disposers) { try { d(); } catch { /* ignore */ } }
fs.rmSync(sandbox, { recursive: true, force: true });

console.log("\n──────────────────────────────");
console.log("通过 " + pass + " / 失败 " + fail);
process.exit(fail === 0 ? 0 : 1);
