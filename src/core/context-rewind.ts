/**
 * 会话上下文回退（/rewind）的纯逻辑层。
 *
 * 只处理 Claude Code 的 append-only transcript（`<dataDir>/projects/<hash>/<id>.jsonl`）：
 * 按「真实用户轮次」切检查点，把文件截断到某一轮的起点，使下一次 `--resume` 读到的
 * 上下文正好是被回退后的样子。调用方负责先停掉 CLI 进程、再调用本模块，并自行做
 * 权限 / 空闲 / 远端后端等业务判定。
 */

import { closeSync, copyFileSync, openSync, readSync, statSync, truncateSync } from 'node:fs';

export interface RewindCheckpoint {
  /** 1 = 最近一轮；仅在一次扫描结果内稳定。 */
  index: number;
  /** 该轮首条用户记录在 transcript 中的字节偏移（回退目标）。 */
  offset: number;
  /** transcript 记录里的 ISO 时间戳（若有）。 */
  at?: string;
  /** 该轮用户消息的短摘要。 */
  preview: string;
  /** transcript 记录的 uuid（若有）。 */
  uuid?: string;
}

const CHUNK_BYTES = 1 << 20;
const PREVIEW_CHARS = 60;

/** 从一条 `<user_message>` / `<botmux_*>` 注入口袋里剥出人真正说的话。 */
export function summarizeUserText(text: string): string {
  let body = text;
  const m = /<user_message>([\s\S]*?)<\/user_message>/i.exec(body);
  if (m) body = m[1] ?? '';
  body = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some(block => {
    return !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result';
  });
}

/** 真实用户轮次：`type=user` 且不是工具结果回填（`tool_result`）。 */
function isRealUserTurn(record: unknown): record is {
  type: 'user';
  message?: { content?: unknown };
  timestamp?: unknown;
  uuid?: unknown;
} {
  if (!record || typeof record !== 'object') return false;
  const r = record as { type?: unknown; message?: { content?: unknown } };
  if (r.type !== 'user') return false;
  const content = r.message?.content;
  if (hasToolResult(content)) return false;
  return textOfContent(content).trim().length > 0;
}

/**
 * 扫描 transcript，按时间顺序找出最后一个真实用户轮次的起点，返回最近 `limit` 个
 * 检查点（新的在前，index=1 为最近一轮）。流式读取，不把整个文件读进内存。
 */
export function scanClaudeTranscriptCheckpoints(path: string, limit = 20): RewindCheckpoint[] {
  const fd = openSync(path, 'r');
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let pending: Buffer = Buffer.alloc(0);
  let pendingStart = 0;
  const found: Omit<RewindCheckpoint, 'index'>[] = [];

  const handleLine = (line: Buffer, offset: number) => {
    // Cheap gate: most lines are assistant/tool records; only parse user ones.
    if (!line.includes('"type":"user"')) return;
    let record: unknown;
    try {
      record = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    if (!isRealUserTurn(record)) return;
    const preview = summarizeUserText(textOfContent(record.message?.content));
    if (!preview) return;
    found.push({
      offset,
      ...(typeof record.timestamp === 'string' ? { at: record.timestamp } : {}),
      ...(typeof record.uuid === 'string' ? { uuid: record.uuid } : {}),
      preview,
    });
  };

  try {
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n <= 0) break;
      const chunk = buf.subarray(0, n);
      const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      const base = pendingStart;
      let pos = 0;
      for (;;) {
        const nl = data.indexOf(10, pos);
        if (nl < 0) break;
        handleLine(data.subarray(pos, nl), base + pos);
        pos = nl + 1;
      }
      pending = Buffer.from(data.subarray(pos));
      pendingStart = base + pos;
    }
    if (pending.length > 0) handleLine(pending, pendingStart);
  } finally {
    closeSync(fd);
  }

  const tail = found.slice(-Math.max(1, limit));
  return tail
    .map((c, i) => ({ ...c, index: tail.length - i }))
    .reverse();
}

export interface RewindResult {
  backupPath: string;
  removedBytes: number;
}

/**
 * 把 transcript 截断到 `offset`（某轮起点）。先复制一份完整备份，再原地截断；
 * 拒绝非行首偏移，避免把半行留在文件里导致 `--resume` 解析失败。
 */
export function rewindClaudeTranscript(
  path: string,
  offset: number,
  now: number = Date.now(),
): RewindResult {
  const st = statSync(path);
  if (!Number.isInteger(offset) || offset <= 0 || offset > st.size) {
    throw new Error(`invalid rewind offset ${offset} (file size ${st.size})`);
  }
  if (offset < st.size) {
    const fd = openSync(path, 'r');
    const byte = Buffer.alloc(1);
    try {
      readSync(fd, byte, 0, 1, offset - 1);
    } finally {
      closeSync(fd);
    }
    if (byte[0] !== 10) throw new Error(`rewind offset ${offset} is not at a line boundary`);
  }
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.rewind-${stamp}.bak`;
  copyFileSync(path, backupPath);
  truncateSync(path, offset);
  return { backupPath, removedBytes: st.size - offset };
}
