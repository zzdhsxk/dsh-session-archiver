/**
 * 会话文件头处理（dsh session.v3.jsonl.zstd）
 *
 * 为什么需要它：
 *   dsh 把会话的 header 放在 zstd 文件的第一帧里，header.cwd 决定这个会话属于哪个工作区。
 *   启动时 dsh 会用 header.cwd 重新计算期望路径与实际位置比对，不一致就直接抛错：
 *     corrupt session log "…": header id "…" and cwd identify "…"
 *   这个错误会让整个 dsh web 起不来 —— 所以「移动会话」必须同步改写 header.cwd，
 *   单纯 fs.rename 会毁掉启动。
 *
 * 文件结构：多帧 zstd 拼接（每帧带 checksum）；第一帧只含 header 一行 JSON。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = 4247762216;
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

/** 定位每个 zstd 帧的字节区间（与 dsh 的 scanZstdFrames 等价，含 checksum 4 字节） */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error("invalid zstd frame magic at byte " + offset);
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** 工作区目录名 <-> cwd 互转 */
export function encodeWorkspace(cwd) {
  return "-" + String(cwd).split(" ").join("~0020").split("/").join("-") + "--";
}
export function decodeWorkspace(dir) {
  let s = String(dir);
  if (s.startsWith("--")) s = s.slice(1);
  if (s.endsWith("--")) s = s.slice(0, -1);
  s = s.split("~0020").join(" ");
  return "/" + s.split("-").filter(Boolean).join("/");
}

/** 在会话目录里找会话日志文件（版本号可能变化，所以用模式匹配） */
export function findSessionLogFile(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const hit = names.find((n) => /^session.*\.jsonl\.zstd$/.test(n));
  return hit ? path.join(dir, hit) : null;
}

/** 读 header（只解压第一帧） */
export function readSessionHeader(file) {
  const buf = fs.readFileSync(file);
  const scan = scanZstdFrames(buf);
  if (!scan.frames.length) throw new Error("no readable zstd frame in " + file);
  const first = zlib.zstdDecompressSync(buf.subarray(scan.frames[0].start, scan.frames[0].end));
  const lines = first.toString("utf8").split("\n").filter(Boolean);
  const header = JSON.parse(lines[0]);
  return { header, extraLines: lines.length - 1, frames: scan.frames, buf, tornStart: scan.tornStart };
}

/**
 * 改写 header.cwd（其余帧逐字节保留）。
 * 安全前提：第一帧只含 header 一行、文件无残帧 —— 否则抛错拒绝，绝不冒险。
 * opts.apply=false 时只预演。
 */
export function rewriteSessionCwd(file, newCwd, opts = {}) {
  const { header, extraLines, frames, buf, tornStart } = readSessionHeader(file);
  if (extraLines > 0) throw new Error("first frame carries " + extraLines + " extra lines; refuse to rewrite");
  if (tornStart !== undefined) throw new Error("session log ends with a torn frame; refuse to rewrite");
  const oldCwd = header.cwd;
  if (oldCwd === newCwd) return { changed: false, cwd: oldCwd };
  if (!opts.apply) return { changed: true, dryRun: true, from: oldCwd, to: newCwd };
  let backup = null;
  if (opts.backupDir) {
    try { fs.mkdirSync(opts.backupDir, { recursive: true }); } catch (e) { /* ignore */ }
    backup = path.join(opts.backupDir, path.basename(file) + ".bak-" + Date.now());
  } else {
    backup = file + ".bak-" + Date.now();
  }
  fs.copyFileSync(file, backup);
  header.cwd = newCwd;
  const newFirst = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + "\n"), CHECKSUM_OPTIONS);
  fs.writeFileSync(file, Buffer.concat([newFirst, buf.subarray(frames[0].end)]));
  return { changed: true, applied: true, from: oldCwd, to: newCwd, backup };
}
