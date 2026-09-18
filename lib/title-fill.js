/**
 * 归档元数据兜底：从会话日志里找回标题（title）。
 *
 * 为什么需要它：
 *   归档区列表的标题只来自 manifest —— 归档那一刻从投影缓存（session_projcache）快照一次，
 *   读不到就存 null。投影缓存文件随时可能被清理，会话一旦移进归档区也不会再刷新，
 *   于是条目永久退化成「session-xxxx-…」这种 id 串。
 *   而归档目录里的会话日志（session*.jsonl.zstd）本身带着 dsh 写入的
 *   `session/title` 事件，这是与日志同生共死的权威来源。
 *
 * 取最后一条而不是第一条：
 *   日志里会反复出现 session/title —— 先是 source.kind=fallback（截取首条用户消息），
 *   之后可能是 provider（模型生成）或 user（用户手改）。只有**最后一条**是最终标题；
 *   只取第一条会把「打开项目进行测试」当成「万界」的标题。因此扫完预算内的所有帧再定。
 *
 * 性能与安全：
 *   会话日志可达数百 MB，所以只读文件头部 MAX_HEAD_BYTES 的压缩字节，
 *   逐帧解压并在累计解压量超过 MAX_DECOMPRESSED_BYTES 时停止 —— 绝不全量读入内存。
 *   解压失败（头部截断导致的半帧）即停止，已扫到的帧仍然有效。
 *   调用方应把结果写入 manifest（titleSource）后不再重试，避免每次列表面板都扫一遍。
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { scanZstdFrames, findSessionLogFile } from "./session-header.js";

/** 最多读取的压缩字节（文件头部） */
const MAX_HEAD_BYTES = 32 * 1024 * 1024;
/** 最多解压出的字节总量 */
const MAX_DECOMPRESSED_BYTES = 192 * 1024 * 1024;
/** 最多扫描的 zstd 帧数 */
const MAX_FRAMES = 20000;

/**
 * 从会话目录里的日志提取标题与头信息。
 * @param {string} dir 会话目录（活跃目录或归档目录均可）
 * @returns {{title: string|null, cwd: string|null, createdAt: number|null, framesScanned: number, bytesDecompressed: number, truncated: boolean}|null}
 */
export function readMetaFromLog(dir) {
  const file = findSessionLogFile(dir);
  if (!file) return null;

  let buf = null;
  let size = 0;
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    size = fs.fstatSync(fd).size;
    const cap = Math.min(size, MAX_HEAD_BYTES);
    if (cap <= 0) return null;
    buf = Buffer.alloc(cap);
    fs.readSync(fd, buf, 0, cap, 0);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  let frames = [];
  try { frames = scanZstdFrames(buf).frames || []; } catch { return null; }

  const out = {
    title: null, titleKind: null, cwd: null, createdAt: null,
    framesScanned: 0, bytesDecompressed: 0, truncated: buf.length < size
  };
  let spent = 0;
  for (let i = 0; i < frames.length && i < MAX_FRAMES; i++) {
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(frames[i].start, frames[i].end)).toString("utf8"); }
    catch { break; } // 头部截断产生的半帧：停在这里，前面的帧照用
    spent += text.length;
    out.framesScanned = i + 1;
    out.bytesDecompressed = spent;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev || typeof ev.type !== "string") continue;
      if (ev.type === "session") {
        if (!out.cwd && typeof ev.cwd === "string" && ev.cwd) out.cwd = ev.cwd;
        if (out.createdAt === null && Number.isFinite(ev.createdAt)) out.createdAt = ev.createdAt;
      } else if (ev.type === "session/title") {
        // 覆盖式取值：只有最后一条才是最终标题（fallback -> provider -> user）
        const t = ev.data && ev.data.title;
        if (typeof t === "string" && t.trim() !== "") {
          out.title = t.trim().slice(0, 120);
          out.titleKind = (ev.data && ev.data.source && ev.data.source.kind) || "unknown";
        }
      }
    }
    if (spent > MAX_DECOMPRESSED_BYTES) break;
  }
  if (!out.title && !out.cwd && out.framesScanned === 0) return null;
  return out;
}
