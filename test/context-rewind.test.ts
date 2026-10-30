import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rewindClaudeTranscript,
  scanClaudeTranscriptCheckpoints,
  summarizeUserText,
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

const userTurn = (text: string, uuid: string, at: string) => ({
  type: 'user',
  message: { role: 'user', content: `<user_message>\n${text}\n</user_message>` },
  uuid,
  timestamp: at,
});

describe('scanClaudeTranscriptCheckpoints', () => {
  it('只把真实用户轮次当检查点，返回从新到旧并带行首偏移', () => {
    const assistant = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    const toolResult = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    };
    const path = fixture([
      userTurn('第一轮', 'u1', '2026-10-31T01:00:00.000Z'),
      assistant,
      toolResult,
      userTurn('第二轮', 'u2', '2026-10-31T01:05:00.000Z'),
      assistant,
    ]);

    const checkpoints = scanClaudeTranscriptCheckpoints(path, 10);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toMatchObject({ index: 1, preview: '第二轮', uuid: 'u2' });
    expect(checkpoints[1]).toMatchObject({ index: 2, preview: '第一轮', uuid: 'u1' });

    const raw = readFileSync(path);
    const firstLine = JSON.stringify(userTurn('第一轮', 'u1', '2026-10-31T01:00:00.000Z')).length + 1;
    expect(checkpoints[1]!.offset).toBe(0);
    expect(checkpoints[0]!.offset).toBeGreaterThan(firstLine);
    expect(raw[checkpoints[0]!.offset - 1]).toBe(0x0a);
  });

  it('最多返回 limit 个，且 index=1 仍是最新', () => {
    const path = fixture([
      userTurn('a', 'u1', '2026-10-31T01:00:00.000Z'),
      userTurn('b', 'u2', '2026-10-31T01:01:00.000Z'),
      userTurn('c', 'u3', '2026-10-31T01:02:00.000Z'),
    ]);
    const checkpoints = scanClaudeTranscriptCheckpoints(path, 2);
    expect(checkpoints.map(cp => cp.preview)).toEqual(['c', 'b']);
    expect(checkpoints.map(cp => cp.index)).toEqual([1, 2]);
  });
});

describe('rewindClaudeTranscript', () => {
  it('截断到检查点并保留完整备份', () => {
    const path = fixture([
      userTurn('第一轮', 'u1', '2026-10-31T01:00:00.000Z'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
      userTurn('第二轮', 'u2', '2026-10-31T01:05:00.000Z'),
    ]);
    const before = statSync(path).size;
    const [latest] = scanClaudeTranscriptCheckpoints(path, 10);

    const result = rewindClaudeTranscript(path, latest!.offset, Date.UTC(2026, 9, 31, 1, 10, 0));

    expect(result.removedBytes).toBe(before - latest!.offset);
    expect(statSync(path).size).toBe(latest!.offset);
    expect(statSync(result.backupPath).size).toBe(before);
    expect(readFileSync(result.backupPath, 'utf8')).toContain('第二轮');
    expect(readFileSync(path, 'utf8')).not.toContain('第二轮');
  });

  it('拒绝非行首偏移', () => {
    const path = fixture([userTurn('ab', 'u1', '2026-10-31T01:00:00.000Z')]);
    expect(() => rewindClaudeTranscript(path, 3)).toThrow(/line boundary/);
  });
});

describe('summarizeUserText', () => {
  it('剥掉 botmux 注入的标签只留用户原话', () => {
    expect(summarizeUserText('<user_message>\n  @steve 帮我看下  \n</user_message>\n<sender name="x"/>')).toBe('@steve 帮我看下');
  });
});
