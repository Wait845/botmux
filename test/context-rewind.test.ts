import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findCheckpoint,
  rewindClaudeTranscript,
  scanClaudeTranscriptCheckpoints,
  summarizeUserText,
  waitForTranscriptQuiet,
} from '../src/core/context-rewind.js';

const dirs: string[] = [];

function fixture(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-rewind-'));
  dirs.push(dir);
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.map(line => `${JSON.stringify(line)}\n`).join(''));
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const userTurn = (text: string, uuid: string, at = '2026-10-31T01:00:00.000Z') => ({
  type: 'user',
  message: { role: 'user', content: `<user_message>\n${text}\n</user_message>` },
  uuid,
  timestamp: at,
});
const assistant = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
const toolResult = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
};

describe('scanClaudeTranscriptCheckpoints', () => {
  it('只把真实用户轮次当检查点，返回从新到旧并带行首偏移', () => {
    const path = fixture([userTurn('第一轮', 'u1'), assistant, toolResult, userTurn('第二轮', 'u2'), assistant]);

    const checkpoints = scanClaudeTranscriptCheckpoints(path, 10);
    expect(checkpoints.map(cp => [cp.index, cp.preview, cp.uuid])).toEqual([[1, '第二轮', 'u2'], [2, '第一轮', 'u1']]);
    const raw = readFileSync(path);
    expect(checkpoints[1]!.offset).toBe(0);
    expect(raw[checkpoints[0]!.offset - 1]).toBe(0x0a);
    expect(raw.subarray(checkpoints[0]!.offset).toString()).toMatch(/^\{"type":"user".*第二轮/);
  });

  it('isMeta / compact 摘要 / sidechain / 斜杠命令包装 / 任务通知都不算轮次起点', () => {
    const path = fixture([
      userTurn('真的一轮', 'u1'),
      { ...userTurn('meta', 'm1'), isMeta: true },
      { ...userTurn('summary', 's1'), isCompactSummary: true },
      { ...userTurn('side', 'sc1'), isSidechain: true },
      { type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/compact</command-name>' } },
      { type: 'user', uuid: 'n1', message: { role: 'user', content: '<task-notification>done</task-notification>' } },
    ]);
    expect(scanClaudeTranscriptCheckpoints(path).map(cp => cp.uuid)).toEqual(['u1']);
  });

  it('type-ahead 出队是新轮次；轮中吸收的排队消息不是', () => {
    const queued = (prompt: string, uuid: string, absorbed: boolean) => ({
      type: 'attachment',
      uuid,
      attachment: { type: 'queued_command', prompt },
      ...(absorbed ? { renderedRole: 'system' } : {}),
    });
    const path = fixture([
      userTurn('a', 'u1'), assistant,
      queued('轮中补充', 'q1', true), assistant,
      queued('排队的新问题', 'q2', false), assistant,
    ]);
    expect(scanClaudeTranscriptCheckpoints(path).map(cp => cp.uuid)).toEqual(['q2', 'u1']);
  });

  it('最近一次 compact 之前的检查点标记为 beforeCompaction', () => {
    const path = fixture([
      userTurn('压缩前', 'u1'), assistant,
      { type: 'system', subtype: 'compact_boundary', uuid: 'cb' },
      { ...userTurn('summary', 's1'), isCompactSummary: true },
      userTurn('压缩后', 'u2'), assistant,
    ]);
    const cps = scanClaudeTranscriptCheckpoints(path);
    expect(cps.map(cp => [cp.uuid, cp.beforeCompaction])).toEqual([['u2', false], ['u1', true]]);
  });

  it('末尾没有换行的半行不算检查点', () => {
    const path = fixture([userTurn('a', 'u1'), assistant]);
    appendFileSync(path, JSON.stringify(userTurn('写了一半', 'u2')));
    expect(scanClaudeTranscriptCheckpoints(path).map(cp => cp.uuid)).toEqual(['u1']);
  });

  it('最多返回 limit 个，且 index=1 仍是最新', () => {
    const path = fixture([userTurn('a', 'u1'), userTurn('b', 'u2'), userTurn('c', 'u3')]);
    const checkpoints = scanClaudeTranscriptCheckpoints(path, 2);
    expect(checkpoints.map(cp => cp.preview)).toEqual(['c', 'b']);
    expect(checkpoints.map(cp => cp.index)).toEqual([1, 2]);
  });
});

describe('resumable', () => {
  it('第一轮之前只剩元数据行：不可回退；之后的轮次可回退', () => {
    const meta = { type: 'permission-mode', permissionMode: 'default', sessionId: 's' };
    const path = fixture([meta, userTurn('第一轮', 'u1'), assistant, userTurn('第二轮', 'u2')]);
    expect(scanClaudeTranscriptCheckpoints(path).map(cp => [cp.uuid, cp.resumable])).toEqual([['u2', true], ['u1', false]]);
  });
});

describe('findCheckpoint', () => {
  it('预览后又来了一轮：按 uuid 找回原来那一轮，而不是按序号删错', () => {
    const path = fixture([userTurn('毒消息', 'u1'), assistant]);
    const [picked] = scanClaudeTranscriptCheckpoints(path);
    appendFileSync(path, `${JSON.stringify(userTurn('新的一轮', 'u2'))}\n`);
    const rescanned = scanClaudeTranscriptCheckpoints(path);
    expect(rescanned[0]!.uuid).toBe('u2');
    expect(findCheckpoint(rescanned, picked!)?.uuid).toBe('u1');
  });

  it('原来那一轮已经不在了就返回 undefined', () => {
    const path = fixture([userTurn('a', 'u1')]);
    expect(findCheckpoint(scanClaudeTranscriptCheckpoints(path), { offset: 0, preview: 'x', uuid: 'gone' })).toBeUndefined();
  });
});

describe('rewindClaudeTranscript', () => {
  it('截断到检查点并保留完整备份', () => {
    const path = fixture([userTurn('第一轮', 'u1'), assistant, userTurn('第二轮', 'u2')]);
    const before = statSync(path).size;
    const [latest] = scanClaudeTranscriptCheckpoints(path, 10);
    const result = rewindClaudeTranscript(path, latest!.offset, Date.UTC(2026, 9, 31, 1, 10, 0));

    expect(result.removedBytes).toBe(before - latest!.offset);
    expect(statSync(path).size).toBe(latest!.offset);
    expect(readFileSync(result.backupPath, 'utf8')).toContain('第二轮');
    expect(readFileSync(path, 'utf8')).not.toContain('第二轮');
    // The kept prefix must still be whole JSONL lines for --resume to parse.
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('拒绝非行首偏移和 0 偏移', () => {
    const path = fixture([userTurn('ab', 'u1'), userTurn('cd', 'u2')]);
    expect(() => rewindClaudeTranscript(path, 3)).toThrow(/line boundary/);
    expect(() => rewindClaudeTranscript(path, 0)).toThrow(/invalid rewind offset/);
  });
});

describe('rewindClaudeTranscript 文件安全', () => {
  it('拒绝符号链接，不截断链接指向的文件', () => {
    const real = fixture([userTurn('a', 'u1'), userTurn('b', 'u2')]);
    const link = `${real}.link.jsonl`;
    symlinkSync(real, link);
    const before = statSync(real).size;
    const [latest] = scanClaudeTranscriptCheckpoints(real);
    expect(() => rewindClaudeTranscript(link, latest!.offset)).toThrow(/non-regular/);
    expect(statSync(real).size).toBe(before);
  });

  it('备份路径已存在（含预埋链接）时失败且不截断', () => {
    const path = fixture([userTurn('a', 'u1'), userTurn('b', 'u2')]);
    const now = Date.UTC(2026, 9, 31, 1, 10, 0);
    const victim = fixture([assistant]);
    const victimBefore = readFileSync(victim, 'utf8');
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    symlinkSync(victim, `${path}.rewind-${stamp}.bak`);
    const before = statSync(path).size;
    const [latest] = scanClaudeTranscriptCheckpoints(path);
    expect(() => rewindClaudeTranscript(path, latest!.offset, now)).toThrow();
    expect(statSync(path).size).toBe(before);
    expect(readFileSync(victim, 'utf8')).toBe(victimBefore);
    expect(existsSync(victim)).toBe(true);
  });
});

describe('waitForTranscriptQuiet', () => {
  const fakeClock = (onTick?: (n: number) => void) => {
    let ticks = 0;
    return async (_ms: number) => { ticks += 1; onTick?.(ticks); };
  };

  it('文件还在增长时一直等，停下来连续 quietMs 才返回 true', async () => {
    const path = fixture([userTurn('a', 'u1')]);
    const grewAt: number[] = [];
    const ok = await waitForTranscriptQuiet(path, {
      quietMs: 300, pollMs: 100, timeoutMs: 5000,
      sleep: fakeClock(n => { if (n <= 4) { appendFileSync(path, 'x\n'); grewAt.push(n); } }),
    });
    expect(ok).toBe(true);
    expect(grewAt).toEqual([1, 2, 3, 4]);
  });

  it('短于 quietMs 的停顿不算写完', async () => {
    const path = fixture([userTurn('a', 'u1')]);
    let lastTick = 0;
    // Writes on ticks 1, 3, 5: each pause is one poll (100ms) < quietMs (300ms).
    const ok = await waitForTranscriptQuiet(path, {
      quietMs: 300, pollMs: 100, timeoutMs: 5000,
      sleep: fakeClock(n => { lastTick = n; if (n === 1 || n === 3 || n === 5) appendFileSync(path, 'x\n'); }),
    });
    expect(ok).toBe(true);
    expect(lastTick).toBe(8);
  });

  it('一直在写就超时返回 false', async () => {
    const path = fixture([userTurn('a', 'u1')]);
    const ok = await waitForTranscriptQuiet(path, {
      quietMs: 300, pollMs: 100, timeoutMs: 1000,
      sleep: fakeClock(() => appendFileSync(path, 'x\n')),
    });
    expect(ok).toBe(false);
  });
});

describe('summarizeUserText', () => {
  it('剥掉 botmux 注入的标签只留用户原话', () => {
    expect(summarizeUserText('<user_message>\n  @steve 帮我看下  \n</user_message>\n<sender name="x"/>')).toBe('@steve 帮我看下');
  });
});
