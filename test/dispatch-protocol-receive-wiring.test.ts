/**
 * Receive-side wiring for the hidden dispatch completion protocol: a kickoff
 * posted by `botmux dispatch --bot-app` shows the brief only in the topic, and
 * the target daemon must add the bound "— 完成回报 —" protocol to the CLI
 * input of the turn that kickoff triggers — on both ingress routes (cold fork
 * of a new topic session, and a live session in an existing topic). Removing
 * either daemon call site drops the report instructions and fails these tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const mocks = vi.hoisted(() => {
  // data/ under a private root: the report-binding secret lives in its parent.
  process.env.SESSION_DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/botmux-dispatch-protocol-rx-${process.pid}/data`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  const created: any[] = [];
  return {
    created,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    listChatBotMembers: vi.fn(async () => [] as any[]),
    downloadResources: vi.fn(async () => ({ attachments: [] as any[], needLogin: false })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined) => (
      openId ? { openId, type: 'user' as const } : undefined
    )),
    forkWorker: vi.fn(),
    sendWorkerInput: vi.fn(),
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: string) => {
      const s = {
        sessionId: `sess-dp-${Math.random().toString(36).slice(2)}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
      created.push(s);
      return s;
    }),
    updateSession: vi.fn(),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
    listChatBotMembers: mocks.listChatBotMembers,
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return { ...actual, createSession: mocks.createSession, updateSession: mocks.updateSession };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return { ...actual, downloadResources: (...args: any[]) => mocks.downloadResources(...args) };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    forkWorker: (...args: any[]) => mocks.forkWorker(...args),
    sendWorkerInput: (...args: any[]) => mocks.sendWorkerInput(...args),
  };
});

import { registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import { loadOrCreateDispatchReportBindingSecret } from '../src/core/dispatch-report-binding.js';
import { deliverWithDispatchTurnProtocol } from '../src/core/dispatch-turn-protocol.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
} from '../src/daemon.js';

const APP = 'cli_dispatch_rx_app';
const CHAT = 'oc_dispatch_rx_chat';
const OWNER = 'ou_dispatch_rx_human';
const ROOT = 'om_dispatch_rx_root';
const NOW = new Date().toISOString();
const REPORT = `botmux report --dispatch-root ${ROOT} "子项目完成 + 产出位置/摘要"`;

let home: string;

function kickoffEvent(messageId: string): any {
  return {
    sender: { sender_id: { open_id: OWNER, union_id: `on_${OWNER}` }, sender_type: 'user' },
    message: {
      message_id: messageId,
      root_id: ROOT,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text: '完成任务：修复登录页' }),
      create_time: String(Date.now()),
    },
  };
}

async function bindProtocol(messageId: string): Promise<void> {
  const dataDir = process.env.SESSION_DATA_DIR!;
  mkdirSync(dataDir, { recursive: true });
  await deliverWithDispatchTurnProtocol({
    dataDir, secret: loadOrCreateDispatchReportBindingSecret(dataDir),
    sourceAppId: 'cli_dispatch_rx_source', chatId: CHAT, rootId: ROOT, targetAppIds: [APP],
    protocol: { dispatchRoot: ROOT, resultDelivery: 'relay', sameTopicSendEnabled: false },
    send: async () => messageId,
  });
}

const ctx = (messageId: string) => ({
  chatId: CHAT, messageId, chatType: 'group' as const, scope: 'thread' as const,
  anchor: ROOT, replyRootId: ROOT, larkAppId: APP,
});

describe('dispatch completion protocol reaches the target turn as hidden context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.created.length = 0;
    home = mkdtempSync(join(tmpdir(), 'botmux-dispatch-rx-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CODEX_HOME', '');
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    mocks.listChatBotMembers.mockResolvedValue([]);
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    mocks.forkWorker.mockReturnValue(true);
    mocks.sendWorkerInput.mockReturnValue(true);
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER],
      workingDir: '/tmp', oncallChats: [{ chatId: CHAT, workingDir: '/tmp' }],
    });
    bot.resolvedAllowedUsers = [OWNER];
    bot.botName = 'RxBot';
    bot.botOpenId = 'ou_dispatch_rx_selfbot';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(dirname(process.env.SESSION_DATA_DIR!), { recursive: true, force: true });
  });

  it('new-topic route: the cold-fork input carries the bound protocol after the visible brief', async () => {
    await bindProtocol('om_kickoff_new');
    await handleNewTopic(kickoffEvent('om_kickoff_new'), ctx('om_kickoff_new'));
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const input = (mocks.forkWorker.mock.calls[0]?.[1] as any)?.content as string;
    expect(input).toContain('完成任务：修复登录页');
    expect(input).toContain('— 完成回报 —');
    expect(input).toContain(REPORT);
  });

  it('new-topic route: an unbound message gets no protocol', async () => {
    await handleNewTopic(kickoffEvent('om_plain_new'), ctx('om_plain_new'));
    const input = (mocks.forkWorker.mock.calls[0]?.[1] as any)?.content as string;
    expect(input).toContain('完成任务：修复登录页');
    expect(input).not.toContain('完成回报');
  });

  it.each([true, false])('thread route: a live session input carries the protocol only when bound (bound=%s)', async bound => {
    const messageId = bound ? 'om_kickoff_into' : 'om_plain_into';
    if (bound) await bindProtocol(messageId);
    const ds = {
      scope: 'thread', chatId: CHAT, chatType: 'group', larkAppId: APP,
      worker: { killed: false, send: vi.fn() }, workerPort: null, workerToken: null,
      spawnedAt: Date.now(), cliVersion: '1.0.0', lastMessageAt: Date.now(), hasHistory: true,
      ownerOpenId: OWNER, workingDir: '/tmp',
      session: { sessionId: 'sess-dp-live', chatId: CHAT, rootMessageId: ROOT, title: 'existing topic',
        status: 'active', createdAt: NOW, larkAppId: APP, scope: 'thread', workingDir: '/tmp' },
    } as unknown as DaemonSession;
    activeSessions.set(sessionKey(ROOT, APP), ds);
    await handleThreadReply(kickoffEvent(messageId), ctx(messageId));
    expect(mocks.sendWorkerInput).toHaveBeenCalledTimes(1);
    const input = (mocks.sendWorkerInput.mock.calls[0]?.[1] as any)?.content as string;
    expect(input).toContain('完成任务：修复登录页');
    expect(input.includes(REPORT)).toBe(bound);
  });
});
