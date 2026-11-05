import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDispatchCompletionBrief } from '../src/core/dispatch.js';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';
import { authorizeReportSessionRelayRequest } from '../src/core/report-session-relay.js';
import {
  deliverWithDispatchTurnProtocol,
  dispatchTurnProtocolContextForInbound,
  dispatchTurnProtocolStorePath,
  resolveDispatchTurnProtocol,
  type DispatchTurnProtocolRequest,
} from '../src/core/dispatch-turn-protocol.js';

const secret = 'fleet-binding-secret';
const relay: DispatchTurnProtocolRequest = { dispatchRoot: 'om_root', resultDelivery: 'relay', sameTopicSendEnabled: false };
let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'dispatch-turn-protocol-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

const deliver = (send: () => Promise<string>, protocol = relay) => deliverWithDispatchTurnProtocol({
  dataDir, secret, sourceAppId: 'cli_source', chatId: 'oc_task', rootId: 'om_root',
  targetAppIds: ['cli_worker'], protocol, send,
});
const inbound = (overrides: Partial<Parameters<typeof dispatchTurnProtocolContextForInbound>[0]> = {}) =>
  dispatchTurnProtocolContextForInbound({
    dataDir, loadSecret: () => secret, appId: 'cli_worker', chatId: 'oc_task',
    rootId: 'om_root', messageId: 'om_kickoff', zeroInjection: false, waitMs: 0, ...overrides,
  });

describe('dispatch completion protocol as hidden turn context', () => {
  it('gives the receiving turn the same report instructions the inline footer had', async () => {
    await deliver(async () => 'om_kickoff');
    const context = await inbound();
    const inlineFooter = buildDispatchCompletionBrief({ brief: '', dispatchRootId: 'om_root',
      exactReportRootEnabled: true, sameTopicSendEnabled: false }).trim();
    expect(context).toContain(inlineFooter);
    expect(context).toContain('botmux report --dispatch-root om_root "子项目完成 + 产出位置/摘要"');
    expect(context).toContain('不要在本话题 @ 来源 bot');
  });

  it.each([
    ['publish', false, '--delivery publish', false],
    ['publish-and-relay', false, '--delivery publish-and-relay', false],
    ['relay', true, 'botmux send --no-mention', true],
  ] as const)('renders %s (same-topic copy=%s)', async (resultDelivery, sameTopicSendEnabled, expected, hasCopy) => {
    await deliver(async () => 'om_kickoff', { dispatchRoot: 'om_root', resultDelivery, sameTopicSendEnabled });
    const context = await inbound();
    expect(context).toContain(expected);
    expect(context.includes('— 原话题留档 —')).toBe(hasCopy);
  });

  it('applies only to the exact bound message, addressed bot, chat and thread', async () => {
    await deliver(async () => 'om_kickoff');
    expect(await inbound({ messageId: 'om_human_followup' })).toBe('');
    expect(await inbound({ appId: 'cli_bystander' })).toBe('');
    expect(await inbound({ chatId: 'oc_other' })).toBe('');
    expect(await inbound({ rootId: 'om_other_root' })).toBe('');
    expect(await inbound({ zeroInjection: true })).toBe('');
  });

  it('waits for the binding when the Lark event overtakes the send response', async () => {
    let releaseSend!: (id: string) => void;
    const sending = deliver(() => new Promise<string>(resolve => { releaseSend = resolve; }));
    // The pending record is written before the post starts.
    await new Promise(resolve => setTimeout(resolve, 50));
    const receiving = inbound({ waitMs: 2000 });
    setTimeout(() => releaseSend('om_kickoff'), 100);
    await sending;
    expect(await receiving).toContain('botmux report --dispatch-root om_root');
  });

  it('does not wait at all for ordinary messages with no pending kickoff', async () => {
    const started = Date.now();
    expect(await inbound({ waitMs: 5000 })).toBe('');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('drops the pending record when the post fails, so nothing can bind later', async () => {
    await expect(deliver(async () => { throw new Error('reply failed'); })).rejects.toThrow('reply failed');
    expect(JSON.parse(readFileSync(dispatchTurnProtocolStorePath(dataDir), 'utf8'))).toEqual({});
  });

  it('ignores records that are not signed with the fleet secret', async () => {
    await deliver(async () => 'om_kickoff');
    const path = dispatchTurnProtocolStorePath(dataDir);
    const store = JSON.parse(readFileSync(path, 'utf8'));
    store.om_kickoff.payload.dispatchRoot = 'om_attacker';
    writeFileSync(path, JSON.stringify(store));
    expect(await resolveDispatchTurnProtocol({ dataDir, secret, appId: 'cli_worker', chatId: 'oc_task',
      rootId: 'om_root', messageId: 'om_kickoff', waitMs: 0 })).toBeUndefined();
    expect(await inbound({ loadSecret: () => 'other-secret' })).toBe('');
  });

  it('degrades to no context when the secret cannot be loaded', async () => {
    await deliver(async () => 'om_kickoff');
    expect(await inbound({ loadSecret: () => { throw new Error('unsafe secret'); } })).toBe('');
  });

  it('keeps botmux report on the source session route, never an @ in the target topic', async () => {
    await deliver(async () => 'om_kickoff');
    const context = await inbound();
    const root = /botmux report --dispatch-root (om_[A-Za-z0-9_-]+)/.exec(context)?.[1];
    expect(root).toBe('om_root');
    expect(context).not.toMatch(/<at |@ou_|user_id=/);
    // The command the worker runs resolves through the dispatch binding to the
    // dispatching session — the same route as before the footer moved.
    const decision = authorizeReportSessionRelayRequest({
      raw: { sessionId: 'session-worker', dispatchRoot: root, content: '子项目完成', originCapability: 'c'.repeat(64) },
      trustedHost: false,
      session: { sessionId: 'session-worker', larkAppId: 'cli_worker', chatId: 'oc_task', receiver: false,
        scope: 'thread', rootMessageId: 'om_root',
        liveOrigin: { capability: 'c'.repeat(64), turnId: 'om_kickoff', dispatchAttempt: 1 }, quoteTargetId: 'om_kickoff' },
      selfLarkAppId: 'cli_worker',
      registry: { om_root: { orchAppId: 'cli_source', orchSessionId: 'session-source', title: 'task',
        reportBinding: createDispatchReportBinding(secret, { dispatchRoot: 'om_root', targetLarkAppId: 'cli_source',
          targetSessionId: 'session-source', sourceName: 'task', issuedAt: '2026-11-06T00:00:00.000Z' }) } },
      bindingSecret: secret,
    });
    expect(decision).toMatchObject({ ok: true, delivery: 'relay',
      target: { larkAppId: 'cli_source', sessionId: 'session-source' } });
  });
});
