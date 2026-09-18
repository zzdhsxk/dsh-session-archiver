/**
 * dsh-session-archiver — 「会话是否仍被 dsh 持有」检测（host 侧，零依赖）。
 *
 * ## 为什么需要它
 *
 * dsh 会把**已加载的会话常驻进程内存**，并对该会话目录下的 `session.lock` 保持打开的文件描述符。
 * 这类会话即使日志几十分钟没被写入，也**依然出现在 dsh 的会话列表里** —— 因为列表 = 磁盘持久化项
 * ∪ 内存中已加载项。所以「文件 mtime」只能证明**没人正在写**，不能证明**没人持有**。
 *
 * 只按 mtime 归档这种会话的后果：
 *   1) 文件确实移走了，但 dsh 界面上照旧显示它 —— 用户看到的现象是「归档没生效」；
 *   2) 该会话之后若仍有事件写入，dsh 会按 header.cwd + id 重新计算日志路径（该路径已不存在），
 *      可能在 sessions 目录里重建空壳，与归档副本分叉，日后的 restore 会卡在 sha256 校验。
 *
 * ## 两条判据（任一命中即视为「被持有」）
 *
 *  1) **进程内（权威、跨平台、零成本）**：dsh 的 `sessions` 服务里还存在这个会话对象。
 *     本插件就跑在 dsh 进程里，所以能直接问它 —— 这也正是 dsh 自己判断 `sessionKnown()` 的方式。
 *  2) **操作系统层面（兜底、可覆盖其它 dsh 实例）**：有进程打开着该会话的 `session.lock`。
 *     Linux 走 `/proc/self/fd`，macOS/BSD 走 `lsof`。探测不到时如实返回 `unsupported`，
 *     绝不假装「没被持有」。
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** dsh 在每个会话目录里放的同名锁文件。 */
export const LOCK_NAME = "session.lock";

/** 一次扫描里对「本进程持有的锁」做短缓存，避免 list 接口每个会话都起一个 lsof。 */
const SELF_CACHE_TTL_MS = 3000;
/** 子进程探测的硬超时，防止异常环境下卡住归档请求。 */
const PROBE_TIMEOUT_MS = 5000;

let selfCache = { at: 0, ok: false, paths: new Set(), reason: null };
let inFlight = null;

/** 清空缓存（测试与「刚归档完再查一次」时需要）。 */
export function resetLiveCache() {
  selfCache = { at: 0, ok: false, paths: new Set(), reason: null };
  inFlight = null;
}

/** 会话目录 -> 会话锁文件绝对路径。 */
export function sessionLockPath(sessionDir) {
  return path.join(sessionDir, LOCK_NAME);
}

function isLockPath(p) {
  return typeof p === "string" && p.endsWith(path.sep + LOCK_NAME);
}

/**
 * 本进程当前打开着的全部 session.lock 路径。
 * @returns {Promise<{ok: boolean, paths: Set<string>, reason: string|null}>} ok=false 表示本平台探测不可用
 */
export async function selfLockPaths() {
  const now = Date.now();
  if (selfCache.at !== 0 && now - selfCache.at < SELF_CACHE_TTL_MS) return selfCache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const result = await probeSelfLockPaths();
    selfCache = { at: Date.now(), ...result };
    inFlight = null;
    return selfCache;
  })();
  return inFlight;
}

async function probeSelfLockPaths() {
  // Linux：读 /proc/self/fd 的符号链接，零子进程，最快也最可靠。
  if (process.platform === "linux") {
    const paths = new Set();
    let fds;
    try {
      fds = fs.readdirSync("/proc/self/fd");
    } catch (err) {
      return { ok: false, paths, reason: "无法读取 /proc/self/fd: " + msg(err) };
    }
    for (const fd of fds) {
      try {
        const link = fs.readlinkSync(path.join("/proc/self/fd", fd));
        // 文件被改名后 readlink 会带 " (deleted)" 后缀，归档场景里不会出现，忽略即可。
        if (isLockPath(link)) paths.add(link);
      } catch { /* fd 已关闭等竞态，跳过 */ }
    }
    return { ok: true, paths, reason: null };
  }

  // macOS / *BSD：lsof -p <自己> -Fn，输出形如 "f92" / "n/abs/path"。
  if (process.platform === "darwin" || process.platform.endsWith("bsd")) {
    const paths = new Set();
    try {
      const { stdout } = await pexecFile("lsof", ["-p", String(process.pid), "-Fn"], {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024
      });
      for (const line of String(stdout).split("\n")) {
        if (line.startsWith("n") && isLockPath(line.slice(1))) paths.add(line.slice(1));
      }
      return { ok: true, paths, reason: null };
    } catch (err) {
      return { ok: false, paths, reason: "lsof 探测失败: " + msg(err) };
    }
  }

  return { ok: false, paths: new Set(), reason: "当前平台 " + process.platform + " 不支持锁探测" };
}

/**
 * 是否有**任意进程**打开着这个锁文件（覆盖「另一个 dsh 实例」的情况）。
 * @returns {Promise<{supported: boolean, held: boolean, pids: string[]}>}
 */
export async function lockHolders(lockPath) {
  if (process.platform === "win32") return { supported: false, held: false, pids: [] };
  try {
    const { stdout } = await pexecFile("lsof", ["-t", "--", lockPath], { timeout: PROBE_TIMEOUT_MS });
    const pids = String(stdout).split("\n").map((s) => s.trim()).filter(Boolean);
    return { supported: true, held: pids.length > 0, pids };
  } catch (err) {
    // lsof 无匹配时以退出码 1 结束 —— 这是「没人持有」，不是失败。
    if (err && err.code === "ENOENT") return { supported: false, held: false, pids: [] };
    if (err && typeof err.code === "number") return { supported: true, held: false, pids: [] };
    return { supported: false, held: false, pids: [] };
  }
}

/**
 * 综合判断一个会话是否仍被 dsh 持有。
 *
 * @param {object} opts
 * @param {string} opts.sessionId 会话 id
 * @param {string} opts.lockPath 该会话的 session.lock 绝对路径
 * @param {any} [opts.sessionsService] dsh 的 sessions 服务（ctx.get("sessions")），可缺省
 * @returns {Promise<{held: boolean, by: "process"|"os"|null, pids: string[], source: string, probe: "ok"|"unsupported"|"error", reason: string|null}>}
 */
export async function probeSessionLive({ sessionId, lockPath, sessionsService }) {
  let probe = "ok";
  let reason = null;

  // 判据 1：进程内的 sessions 服务（权威）
  const inProcess = sessionsServiceGet(sessionsService, sessionId);
  if (inProcess.ok && inProcess.value !== undefined && inProcess.value !== null) {
    return { held: true, by: "process", pids: [String(process.pid)], source: "sessions-service", probe, reason };
  }
  if (!inProcess.ok && inProcess.reason) reason = inProcess.reason;

  // 判据 2：本进程持有的锁（缓存，便宜）
  if (lockPath) {
    const self = await selfLockPaths();
    if (self.ok) {
      const normalized = normalizePath(lockPath);
      for (const p of self.paths) {
        if (normalizePath(p) === normalized) {
          return { held: true, by: "process", pids: [String(process.pid)], source: "self-fd", probe, reason };
        }
      }
    } else {
      probe = "unsupported";
      if (!reason) reason = self.reason;
    }

    // 判据 3：任意进程持有的锁（其它 dsh 实例）
    const holders = await lockHolders(lockPath);
    if (holders.held) {
      return { held: true, by: "os", pids: holders.pids, source: "os-lock", probe: "ok", reason: null };
    }
    if (!holders.supported && probe === "ok") probe = "unsupported";
  }

  return { held: false, by: null, pids: [], source: "none", probe, reason };
}

/** 安全调用 sessions.get(id)，把「服务不在」和「查询抛错」区分开。 */
function sessionsServiceGet(service, sessionId) {
  if (!service) return { ok: false, value: undefined, reason: "sessions 服务未挂载" };
  try {
    if (typeof service.get !== "function") return { ok: false, value: undefined, reason: "sessions 服务没有 get()" };
    return { ok: true, value: service.get(sessionId) };
  } catch (err) {
    return { ok: false, value: undefined, reason: "sessions 查询失败: " + msg(err) };
  }
}

/** 路径归一化（解析软链接，例如 macOS 的 /tmp -> /private/tmp），供调用方比对锁路径。 */
export function normalizeLockPath(p) {
  return normalizePath(p);
}

function normalizePath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function msg(err) {
  return err && err.message ? err.message : String(err);
}
