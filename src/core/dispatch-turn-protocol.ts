/**
 * Hidden per-turn completion protocol for `botmux dispatch --bot-app`.
 *
 * The kickoff a dispatch posts into the target topic used to carry the
 * "— 完成回报 —" footer inline, so the topic showed a machine-generated
 * instruction block that reads as if a human wrote it. For local `--bot-app`
 * targets the footer now travels beside the message instead:
 *
 *   source daemon  — registers a pending record, posts the brief only, then
 *                    binds the record to the exact message id it got back;
 *   target daemon  — on that exact inbound message, resolves the record and
 *                    adds the rendered protocol to the turn's hidden context.
 *
 * The record stores only structured parameters (dispatch root, delivery mode,
 * same-topic copy switch); the receiver re-renders the text with the same
 * builder the inline footer used, so the hidden lane can never carry arbitrary
 * instructions. Records are HMAC-signed with the fleet's dispatch-report
 * binding secret, the same trust domain as the report binding itself.
 *
 * Legacy `--bot <open_id>` dispatches (possibly to another machine) have no
 * shared store with the receiver and keep the visible footer.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { updateDispatchRegistry } from './dispatch-registry.js';
import { buildDispatchCompletionBrief, type DispatchResultDelivery } from './dispatch.js';

const DOMAIN = 'botmux.dispatch-turn-protocol.v1';
const identity = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]{1,128}$`));

/** What the CLI asks the source daemon to attach to one kickoff. */
export const dispatchTurnProtocolRequestSchema = z.object({
  dispatchRoot: identity('om_'),
  resultDelivery: z.enum(['relay', 'publish', 'publish-and-relay']),
  sameTopicSendEnabled: z.boolean(),
}).strict();
export type DispatchTurnProtocolRequest = z.infer<typeof dispatchTurnProtocolRequestSchema>;

const payloadSchema = dispatchTurnProtocolRequestSchema.extend({
  domain: z.literal(DOMAIN),
  deliveryId: z.string().uuid(),
  issuedAt: z.number().int().nonnegative(),
  sourceAppId: identity('cli_'),
  chatId: identity('oc_'),
  rootId: identity('om_'),
  targetAppIds: z.array(identity('cli_')).min(1).max(64),
  messageId: identity('om_').optional(),
}).strict();
export type DispatchTurnProtocolPayload = z.infer<typeof payloadSchema>;
interface SignedDispatchTurnProtocol { payload: DispatchTurnProtocolPayload; signature: string }

/** A pending record only lets the receiver wait briefly for its binding. */
const PENDING_TTL_MS = 30_000;
/** Bound records are kept long enough for restart/redelivery of the same message. */
const BOUND_TTL_MS = 7 * 24 * 60 * 60_000;

export const dispatchTurnProtocolStorePath = (dataDir: string): string =>
  join(dataDir, 'dispatch-turn-protocols.json');

function sign(secret: string, value: DispatchTurnProtocolPayload): SignedDispatchTurnProtocol {
  if (!secret) throw new Error('missing dispatch protocol signing key');
  const payload = payloadSchema.parse(value);
  return { payload, signature: createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url') };
}

function verify(secret: string, raw: unknown): DispatchTurnProtocolPayload | undefined {
  try {
    if (!secret || !raw || typeof raw !== 'object') return;
    const signed = raw as SignedDispatchTurnProtocol;
    const expected = sign(secret, signed.payload);
    const a = Buffer.from(expected.signature, 'base64url');
    const b = Buffer.from(String(signed.signature), 'base64url');
    if (a.length === b.length && timingSafeEqual(a, b)) return expected.payload;
  } catch { /* malformed or forged records carry no protocol */ }
}

function readStore(dataDir: string): Record<string, unknown> {
  const path = dispatchTurnProtocolStorePath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function prune(store: Record<string, unknown>, now: number): void {
  for (const [key, raw] of Object.entries(store)) {
    const issuedAt = (raw as { payload?: { issuedAt?: unknown } } | null)?.payload?.issuedAt;
    const ttl = key.startsWith('pending:') ? PENDING_TTL_MS * 4 : BOUND_TTL_MS;
    if (typeof issuedAt !== 'number' || now - issuedAt > ttl) delete store[key];
  }
}

/** Render the protocol exactly as the inline footer read, minus the brief. */
export function renderDispatchTurnProtocol(protocol: DispatchTurnProtocolRequest): string {
  return buildDispatchCompletionBrief({
    brief: '',
    dispatchRootId: protocol.dispatchRoot,
    exactReportRootEnabled: true,
    sameTopicSendEnabled: protocol.sameTopicSendEnabled,
    resultDelivery: protocol.resultDelivery as DispatchResultDelivery,
  }).trim();
}

/** The hidden-context block a receiving turn gets (trailing newline included). */
export function dispatchTurnProtocolContext(protocol: DispatchTurnProtocolRequest): string {
  return '[派单完成约定] 以下约定由 botmux 随本条派单注入，话题中不显示：\n'
    + renderDispatchTurnProtocol(protocol) + '\n';
}

/**
 * Pick what the source daemon posts for a delivery request.
 *
 * - The root is NOT a registered dispatch (`--into` a human-started topic, a
 *   secretary watch, …): post the brief only, with no completion protocol at
 *   all. A `--dispatch-root` instruction there names a root `botmux report`
 *   can never resolve, and the legacy positional form would make the worker
 *   post a top-level @ in the group. The topic's own conversation is the
 *   report channel.
 * - Registered root + complete hidden-protocol request: post the brief only
 *   and bind the protocol as hidden turn context.
 * - Anything else (older CLI, malformed/partial hidden request, legacy `--bot`
 *   into a registered dispatch): post `content` with the inline footer, so a
 *   bad request can never silently drop the protocol of a real dispatch.
 */
export function selectDispatchKickoffContent(body: {
  rootId?: unknown;
  content?: unknown;
  visibleContent?: unknown;
  completionProtocol?: unknown;
  targetAppIds?: unknown;
}, rootRegistered: boolean): { content: string; protocol?: DispatchTurnProtocolRequest } {
  const content = String(body.content ?? '');
  const visible = typeof body.visibleContent === 'string' && body.visibleContent.trim()
    ? body.visibleContent : undefined;
  if (!rootRegistered && visible) return { content: visible };
  if (body.completionProtocol === undefined || !visible) return { content };
  const parsed = dispatchTurnProtocolRequestSchema.safeParse(body.completionProtocol);
  if (!parsed.success
    || parsed.data.dispatchRoot !== body.rootId
    || !Array.isArray(body.targetAppIds) || body.targetAppIds.length === 0) {
    return { content };
  }
  return { content: visible, protocol: parsed.data };
}

/**
 * Post a kickoff whose completion protocol rides as hidden context. The
 * pending record is written before `send` because the receiver can observe the
 * Lark event before `send` resolves; on any failure the record is dropped.
 */
export async function deliverWithDispatchTurnProtocol(input: {
  dataDir: string;
  secret: string;
  sourceAppId: string;
  chatId: string;
  rootId: string;
  targetAppIds: string[];
  protocol: DispatchTurnProtocolRequest;
  send: () => Promise<string>;
  now?: () => number;
}): Promise<string> {
  const now = input.now ?? Date.now;
  const path = dispatchTurnProtocolStorePath(input.dataDir);
  const pending = sign(input.secret, {
    ...dispatchTurnProtocolRequestSchema.parse(input.protocol),
    domain: DOMAIN, deliveryId: randomUUID(), issuedAt: now(),
    sourceAppId: input.sourceAppId, chatId: input.chatId, rootId: input.rootId,
    targetAppIds: [...new Set(input.targetAppIds)],
  });
  const key = `pending:${pending.payload.deliveryId}`;
  await updateDispatchRegistry(path, store => { prune(store, now()); store[key] = pending; });
  const drop = () => updateDispatchRegistry(path, store => { delete store[key]; });
  let messageId: string;
  try {
    messageId = await input.send();
  } catch (error) {
    await drop().catch(() => {});
    throw error;
  }
  try {
    await updateDispatchRegistry(path, store => {
      if (!verify(input.secret, store[key])) throw new Error('dispatch protocol registration is missing');
      if (store[messageId] !== undefined) throw new Error('duplicate dispatch protocol message identity');
      store[messageId] = sign(input.secret, { ...pending.payload, messageId });
      delete store[key];
    });
  } catch {
    // The message is already posted. Losing the hidden protocol must not turn
    // a delivered task into a reported transport failure (the sender would
    // retry and duplicate it); the receiver simply gets no protocol block.
    await drop().catch(() => {});
  }
  return messageId;
}

/**
 * The protocol bound to this exact inbound message, if any. Waits (bounded)
 * only while a fresh pending record addressed to this bot in this thread
 * exists, i.e. while the sender is between posting and binding.
 */
export async function resolveDispatchTurnProtocol(input: {
  dataDir: string;
  secret: string;
  appId: string;
  chatId: string;
  rootId?: string;
  messageId: string;
  waitMs?: number;
  now?: () => number;
}): Promise<DispatchTurnProtocolRequest | undefined> {
  if (!input.rootId || input.rootId === input.messageId) return;
  const now = input.now ?? Date.now;
  const deadline = now() + (input.waitMs ?? 5000);
  const addressed = (p: DispatchTurnProtocolPayload): boolean => p.chatId === input.chatId
    && p.rootId === input.rootId && p.targetAppIds.includes(input.appId);
  for (;;) {
    const store = readStore(input.dataDir);
    const exact = verify(input.secret, store[input.messageId]);
    if (exact && exact.messageId === input.messageId && addressed(exact)) {
      return { dispatchRoot: exact.dispatchRoot, resultDelivery: exact.resultDelivery,
        sameTopicSendEnabled: exact.sameTopicSendEnabled };
    }
    const waiting = Object.entries(store).some(([key, raw]) => {
      if (!key.startsWith('pending:')) return false;
      const p = verify(input.secret, raw);
      return !!p && !p.messageId && addressed(p) && now() - p.issuedAt < PENDING_TTL_MS;
    });
    if (!waiting || now() >= deadline) return;
    await delay(25);
  }
}

/**
 * Hidden-context block for one inbound message, or '' when it is not a bound
 * dispatch kickoff. A zero-injection bot gets nothing (its daemon reports the
 * final answer automatically). Store/secret failures degrade to '' — the turn
 * itself must never fail because the protocol could not be read.
 */
export async function dispatchTurnProtocolContextForInbound(input: {
  dataDir: string;
  loadSecret: () => string;
  appId: string;
  chatId: string;
  rootId?: string;
  messageId?: string;
  zeroInjection: boolean;
  waitMs?: number;
}): Promise<string> {
  if (input.zeroInjection || !input.messageId || !input.rootId || input.rootId === input.messageId) return '';
  try {
    const protocol = await resolveDispatchTurnProtocol({
      dataDir: input.dataDir, secret: input.loadSecret(), appId: input.appId, chatId: input.chatId,
      rootId: input.rootId, messageId: input.messageId, waitMs: input.waitMs,
    });
    return protocol ? dispatchTurnProtocolContext(protocol) : '';
  } catch {
    return '';
  }
}

