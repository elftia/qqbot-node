/**
 * QQ Bot WebSocket gateway — connection, heartbeat, reconnection, intent degradation
 *
 * Uses EventEmitter to decouple from any specific framework.
 * Consumers listen to events like 'message', 'connected', 'disconnected', etc.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
  WSPayload, QQChatType, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent,
  GatewayMessage, QQBotLogger, SessionStore,
} from './types';
import { noopLogger } from './types';
import { getAccessToken, getGatewayUrl, clearTokenCache } from './client';

// ── Intent levels (fallback from full → channel-only) ───────

const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};

const INTENT_LEVELS = [
  { name: 'full', intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C },
  { name: 'group+channel', intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C },
  { name: 'channel-only', intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GUILD_MEMBERS },
];

// ── Reconnect config ────────────────────────────────────────

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
const MAX_RECONNECT_ATTEMPTS = 100;
const RATE_LIMIT_DELAY = 60_000;
const QUICK_DISCONNECT_THRESHOLD = 5_000;
const MAX_QUICK_DISCONNECT_COUNT = 3;

// ── Message queue config ────────────────────────────────────

const PER_USER_QUEUE_SIZE = 20;
const MAX_CONCURRENT_USERS = 10;

// ── Session persistence ─────────────────────────────────────

const SESSION_EXPIRE_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_STORAGE_KEY = 'gateway_session';

interface SessionState {
  sessionId: string;
  lastSeq: number;
  intentLevelIndex: number;
  appId: string;
  savedAt: number;
}

// ── Chat ID helpers ─────────────────────────────────────────

export function encodeChatId(type: QQChatType, id: string): string {
  return `${type}:${id}`;
}

export function decodeChatId(encoded: string): { type: QQChatType; id: string } {
  const idx = encoded.indexOf(':');
  if (idx === -1) return { type: 'channel', id: encoded };
  const prefix = encoded.substring(0, idx);
  const id = encoded.substring(idx + 1);
  if (prefix === 'group' || prefix === 'c2c' || prefix === 'dm' || prefix === 'channel') {
    return { type: prefix as QQChatType, id };
  }
  return { type: 'channel', id: encoded };
}

// ── QQ Face tag parsing ─────────────────────────────────────

/** Convert QQ face tags to readable text: <faceType=...,faceId="107"> → [emoji] */
function parseFaceTags(content: string): string {
  return content.replace(
    /<faceType=[^,]*,faceId="(\d+)"(?:,ext="([^"]*)")?[^>]*>/gi,
    (_match, _faceId: string, ext?: string) => {
      if (ext) {
        try {
          const parsed = JSON.parse(ext);
          if (parsed?.faceText) return parsed.faceText;
        } catch { /* ignore */ }
      }
      return '[emoji]';
    },
  );
}

/** Clean up message content: strip @mentions, decode HTML entities, parse face tags */
export function cleanMessageContent(content: string): string {
  let cleaned = content;
  cleaned = cleaned.replace(/<@!?\d+>/g, '').trim();
  cleaned = parseFaceTags(cleaned);
  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return cleaned;
}

/** Normalize attachment URL: fix protocol-relative URLs */
export function normalizeAttachmentUrl(url: string): string {
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

// ── Gateway Events ──────────────────────────────────────────

export interface QQBotGatewayEvents {
  /** A message was received (any type: c2c, group, guild, dm) */
  message: [msg: GatewayMessage];
  /** Gateway connected and identified/resumed */
  connected: [];
  /** Gateway disconnected */
  disconnected: [code: number];
  /** Gateway is reconnecting */
  reconnecting: [attempt: number];
  /** Unrecoverable error (bot offline, banned, max reconnects) */
  error: [error: Error];
  /** Status change */
  status: [status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error'];
}

export interface GatewayOptions {
  appId: string;
  clientSecret: string;
  logger?: QQBotLogger;
  sessionStore?: SessionStore;
}

/**
 * QQ Bot WebSocket gateway manager.
 *
 * Emits events for all inbound messages instead of using framework-specific callbacks.
 * Supports session resume, intent degradation, and per-user message queue serialization.
 *
 * @example
 * ```ts
 * const gateway = new QQBotGateway({ appId, clientSecret, logger });
 * gateway.on('message', (msg) => console.log('Got message:', msg));
 * gateway.on('connected', () => console.log('Connected!'));
 * await gateway.start();
 * ```
 */
export class QQBotGateway extends EventEmitter {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval = 30_000;
  private lastHeartbeatAck = true;
  private sessionId = '';
  private seq = 0;
  private intentLevelIndex = 0;
  private lastSuccessfulIntentLevel = -1;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private aborted = false;
  private isConnecting = false;
  private cachedToken = '';
  private shouldRefreshToken = false;

  // Quick disconnect detection
  private lastConnectTime = 0;
  private quickDisconnectCount = 0;

  // Session persistence throttle
  private sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-user message queue
  private userQueues = new Map<string, GatewayMessage[]>();
  private activeUsers = new Set<string>();

  /** Last received message ID per chat — required for passive replies */
  readonly lastMsgId = new Map<string, string>();

  private readonly log: QQBotLogger;
  private readonly store: SessionStore | null;

  constructor(private readonly opts: GatewayOptions) {
    super();
    this.log = opts.logger ?? noopLogger;
    this.store = opts.sessionStore ?? null;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && !this.aborted;
  }

  async start(): Promise<void> {
    this.aborted = false;
    this.reconnectAttempts = 0;
    await this.loadSession();
    await this.connect();
  }

  stop(): void {
    this.aborted = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sessionSaveTimer) {
      clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
    }
    this.saveSessionNow();
    this.cleanup();
    this.lastMsgId.clear();
    this.userQueues.clear();
    this.activeUsers.clear();
  }

  // ── Typed event emitter helpers ─────────────────────────────

  override emit<K extends keyof QQBotGatewayEvents>(event: K, ...args: QQBotGatewayEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof QQBotGatewayEvents>(event: K, listener: (...args: QQBotGatewayEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override once<K extends keyof QQBotGatewayEvents>(event: K, listener: (...args: QQBotGatewayEvents[K]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  // ── Session persistence ────────────────────────────────────

  private async loadSession(): Promise<void> {
    if (!this.store) return;
    try {
      const saved = await this.store.get<SessionState>(SESSION_STORAGE_KEY);
      if (!saved) return;

      const age = Date.now() - saved.savedAt;
      if (age > SESSION_EXPIRE_MS) {
        this.log.info(`Stored session expired (age: ${Math.round(age / 1000)}s), starting fresh`);
        await this.store.delete(SESSION_STORAGE_KEY);
        return;
      }

      if (saved.appId !== this.opts.appId) {
        this.log.info('AppId changed, discarding stored session');
        await this.store.delete(SESSION_STORAGE_KEY);
        return;
      }

      this.sessionId = saved.sessionId;
      this.seq = saved.lastSeq;
      this.intentLevelIndex = saved.intentLevelIndex;
      this.log.info(`Restored session: ${saved.sessionId}, seq: ${saved.lastSeq}`);
    } catch {
      // Ignore storage errors
    }
  }

  private saveSessionThrottled(): void {
    if (this.sessionSaveTimer) return;
    this.sessionSaveTimer = setTimeout(() => {
      this.sessionSaveTimer = null;
      this.saveSessionNow();
    }, 1000);
  }

  private saveSessionNow(): void {
    if (!this.store || !this.sessionId || this.seq <= 0) return;
    const state: SessionState = {
      sessionId: this.sessionId,
      lastSeq: this.seq,
      intentLevelIndex: this.lastSuccessfulIntentLevel >= 0 ? this.lastSuccessfulIntentLevel : this.intentLevelIndex,
      appId: this.opts.appId,
      savedAt: Date.now(),
    };
    this.store.set(SESSION_STORAGE_KEY, state).catch(() => {});
  }

  private clearStoredSession(): void {
    this.sessionId = '';
    this.seq = 0;
    this.store?.delete(SESSION_STORAGE_KEY).catch(() => {});
  }

  // ── Connection ──────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.isConnecting || this.aborted) return;
    this.isConnecting = true;

    try {
      this.cleanup();

      if (this.shouldRefreshToken) {
        clearTokenCache();
        this.shouldRefreshToken = false;
      }

      const token = await getAccessToken(this.opts.appId, this.opts.clientSecret);
      this.cachedToken = token;
      const gatewayUrl = await getGatewayUrl(token);
      this.log.info(`Connecting to QQ gateway: ${gatewayUrl}`);

      this.emit('status', 'connecting');
      this.lastConnectTime = Date.now();
      const ws = new WebSocket(gatewayUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.log.info('QQ Bot WebSocket opened');
        this.reconnectAttempts = 0;
      });

      ws.on('message', (data) => {
        this.handleWSMessage(data.toString());
      });

      ws.on('error', (err) => {
        this.log.error('QQ Bot WebSocket error', err);
      });

      ws.on('close', (code) => {
        this.handleClose(code);
      });
    } catch (err) {
      this.log.error('Gateway connection failed', err instanceof Error ? err : new Error(String(err)));
      if (!this.aborted) this.scheduleReconnect();
    } finally {
      this.isConnecting = false;
    }
  }

  // ── Close code handling ────────────────────────────────────

  private handleClose(code: number): void {
    this.cleanup();
    if (this.aborted) return;

    this.log.info(`WebSocket closed with code ${code}`);
    this.emit('disconnected', code);

    // 4914/4915: Bot offline or banned — do not reconnect
    if (code === 4914 || code === 4915) {
      const reason = code === 4914 ? 'offline/sandbox-only' : 'banned';
      this.log.error(`Bot is ${reason}. Check QQ Open Platform.`);
      this.emit('status', 'error');
      this.emit('error', new Error(`Bot is ${reason} (code: ${code})`));
      return;
    }

    // 4004: Invalid token — refresh and reconnect
    if (code === 4004) {
      this.log.info('Invalid token (4004), will refresh and reconnect');
      this.shouldRefreshToken = true;
      this.emit('status', 'reconnecting');
      this.scheduleReconnect();
      return;
    }

    // 4008: Rate limited — wait 60s
    if (code === 4008) {
      this.log.info(`Rate limited (4008), waiting ${RATE_LIMIT_DELAY}ms`);
      this.emit('status', 'reconnecting');
      this.scheduleReconnect(RATE_LIMIT_DELAY);
      return;
    }

    // 4006/4007/4009: Session errors — clear session, re-identify
    if (code === 4006 || code === 4007 || code === 4009) {
      const desc: Record<number, string> = {
        4006: 'session no longer valid',
        4007: 'invalid seq on resume',
        4009: 'session timed out',
      };
      this.log.info(`Error ${code} (${desc[code]}), will re-identify`);
      this.clearStoredSession();
      this.shouldRefreshToken = true;
    } else if (code >= 4900 && code <= 4913) {
      this.log.info(`Internal error (${code}), will re-identify`);
      this.clearStoredSession();
      this.shouldRefreshToken = true;
    } else if (code === 4014) {
      if (this.intentLevelIndex < INTENT_LEVELS.length - 1) {
        this.intentLevelIndex++;
        this.log.info(`Intent rejected (4014), trying level ${this.intentLevelIndex}: ${INTENT_LEVELS[this.intentLevelIndex]!.name}`);
        this.emit('status', 'reconnecting');
        this.scheduleReconnect(1000);
        return;
      }
    }

    // Quick disconnect detection
    const connectionDuration = Date.now() - this.lastConnectTime;
    if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && this.lastConnectTime > 0) {
      this.quickDisconnectCount++;
      this.log.info(`Quick disconnect (${connectionDuration}ms), count: ${this.quickDisconnectCount}`);

      if (this.quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
        this.log.error('Too many quick disconnects. Check: 1) AppID/Secret 2) Bot permissions on QQ Open Platform');
        this.quickDisconnectCount = 0;
        this.emit('status', 'reconnecting');
        this.scheduleReconnect(RATE_LIMIT_DELAY);
        return;
      }
    } else {
      this.quickDisconnectCount = 0;
    }

    if (code !== 1000) {
      this.emit('status', 'reconnecting');
      this.scheduleReconnect();
    }
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(customDelay?: number): void {
    if (this.aborted || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.log.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
      this.emit('status', 'error');
      this.emit('error', new Error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`));
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const idx = Math.min(this.reconnectAttempts, RECONNECT_DELAYS.length - 1);
    const delay = customDelay ?? RECONNECT_DELAYS[idx]!;
    this.reconnectAttempts++;
    this.log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.emit('reconnecting', this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.aborted) this.connect();
    }, delay);
  }

  // ── WebSocket message handling ────────────────────────────

  private handleWSMessage(raw: string): void {
    let payload: WSPayload;
    try {
      payload = JSON.parse(raw) as WSPayload;
    } catch {
      return;
    }

    if (payload.s) {
      this.seq = payload.s;
      this.saveSessionThrottled();
    }

    switch (payload.op) {
      case 10: {
        const d = payload.d as Record<string, unknown> | undefined;
        this.heartbeatInterval = Number(d?.heartbeat_interval ?? 30000);
        this.sendIdentify();
        this.startHeartbeat();
        break;
      }
      case 0:
        this.handleDispatch(payload.t, payload.d as Record<string, unknown> | undefined);
        break;
      case 11:
        this.lastHeartbeatAck = true;
        break;
      case 7:
        this.log.info('Server requested reconnect');
        this.ws?.close();
        break;
      case 9: {
        const resumable = payload.d as boolean | undefined;
        this.log.warn(`Invalid session (resumable: ${resumable})`);
        if (!resumable) {
          this.clearStoredSession();
          if (this.intentLevelIndex < INTENT_LEVELS.length - 1) {
            this.intentLevelIndex++;
            this.log.info(`Downgrading intent to level ${this.intentLevelIndex}: ${INTENT_LEVELS[this.intentLevelIndex]!.name}`);
          }
        }
        this.ws?.close();
        break;
      }
    }
  }

  private sendIdentify(): void {
    if (this.sessionId && this.seq > 0) {
      this.log.info(`Resuming session: ${this.sessionId}, seq: ${this.seq}`);
      this.ws?.send(JSON.stringify({
        op: 6,
        d: { token: `QQBot ${this.getTokenSync()}`, session_id: this.sessionId, seq: this.seq },
      }));
    } else {
      const level = INTENT_LEVELS[this.lastSuccessfulIntentLevel >= 0 ? this.lastSuccessfulIntentLevel : this.intentLevelIndex]!;
      this.log.info(`Identifying with intent level: ${level.name}`);
      this.ws?.send(JSON.stringify({
        op: 2,
        d: { token: `QQBot ${this.getTokenSync()}`, intents: level.intents, shard: [0, 1] },
      }));
    }
  }

  private getTokenSync(): string {
    return this.cachedToken;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.lastHeartbeatAck = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.lastHeartbeatAck) {
        this.log.warn('Heartbeat ACK missed, reconnecting');
        this.ws?.close();
        return;
      }
      this.lastHeartbeatAck = false;
      this.ws?.send(JSON.stringify({ op: 1, d: this.seq || null }));
    }, this.heartbeatInterval);
  }

  // ── Dispatch events ───────────────────────────────────────

  private handleDispatch(eventType?: string, data?: Record<string, unknown>): void {
    if (!eventType || !data) return;

    if (eventType === 'READY' || eventType === 'RESUMED') {
      if (data.session_id) this.sessionId = String(data.session_id);
      this.lastSuccessfulIntentLevel = this.intentLevelIndex;
      this.log.info(`Session ${eventType}: ${this.sessionId}`);
      this.emit('status', 'connected');
      this.emit('connected');
      this.saveSessionNow();
      return;
    }

    let msg: GatewayMessage | null = null;

    switch (eventType) {
      case 'MESSAGE_CREATE':
      case 'AT_MESSAGE_CREATE':
        msg = this.parseGuildMessage(data);
        break;
      case 'GROUP_AT_MESSAGE_CREATE':
        msg = this.parseGroupMessage(data);
        break;
      case 'C2C_MESSAGE_CREATE':
        msg = this.parseC2CMessage(data);
        break;
      case 'DIRECT_MESSAGE_CREATE':
        msg = this.parseDirectMessage(data);
        break;
    }

    if (msg) {
      this.enqueueMessage(msg);
    }
  }

  private parseGuildMessage(data: Record<string, unknown>): GatewayMessage | null {
    const author = data.author as Record<string, unknown> | undefined;
    if (author?.bot) return null;
    const d = data as unknown as GuildMessageEvent;
    return {
      type: 'guild',
      senderId: String(author?.id ?? ''),
      senderName: String(author?.username ?? 'Unknown'),
      content: cleanMessageContent(String(data.content ?? '')),
      messageId: String(data.id ?? Date.now()),
      timestamp: String(data.timestamp ?? new Date().toISOString()),
      channelId: d.channel_id,
      guildId: d.guild_id,
      attachments: d.attachments?.map(a => ({
        content_type: a.content_type, url: normalizeAttachmentUrl(a.url),
        filename: a.filename, size: a.size, voice_wav_url: a.voice_wav_url,
      })),
    };
  }

  private parseGroupMessage(data: Record<string, unknown>): GatewayMessage | null {
    const d = data as unknown as GroupMessageEvent;
    const msgId = String(d.id ?? Date.now());
    const chatId = encodeChatId('group', d.group_openid);
    this.lastMsgId.set(chatId, msgId);
    return {
      type: 'group',
      senderId: String(d.author?.member_openid ?? ''),
      senderName: String(d.author?.member_openid ?? 'GroupMember'),
      content: cleanMessageContent(String(d.content ?? '')),
      messageId: msgId,
      timestamp: String(d.timestamp ?? new Date().toISOString()),
      groupOpenid: d.group_openid,
      attachments: d.attachments?.map(a => ({
        content_type: a.content_type, url: normalizeAttachmentUrl(a.url),
        filename: a.filename, size: a.size, voice_wav_url: a.voice_wav_url,
      })),
    };
  }

  private parseC2CMessage(data: Record<string, unknown>): GatewayMessage | null {
    const d = data as unknown as C2CMessageEvent;
    const msgId = String(d.id ?? Date.now());
    const userOpenId = String(d.author?.user_openid ?? '');
    const chatId = encodeChatId('c2c', userOpenId);
    this.lastMsgId.set(chatId, msgId);
    return {
      type: 'c2c',
      senderId: userOpenId,
      senderName: userOpenId,
      content: cleanMessageContent(String(d.content ?? '')),
      messageId: msgId,
      timestamp: String(d.timestamp ?? new Date().toISOString()),
      attachments: d.attachments?.map(a => ({
        content_type: a.content_type, url: normalizeAttachmentUrl(a.url),
        filename: a.filename, size: a.size, voice_wav_url: a.voice_wav_url,
      })),
    };
  }

  private parseDirectMessage(data: Record<string, unknown>): GatewayMessage | null {
    const author = data.author as Record<string, unknown> | undefined;
    if (author?.bot) return null;
    const msgId = String(data.id ?? Date.now());
    const guildId = String(data.guild_id ?? '');
    const chatId = encodeChatId('dm', guildId);
    this.lastMsgId.set(chatId, msgId);
    return {
      type: 'dm',
      senderId: String(author?.id ?? ''),
      senderName: String(author?.username ?? 'Unknown'),
      content: cleanMessageContent(String(data.content ?? '')),
      messageId: msgId,
      timestamp: String(data.timestamp ?? new Date().toISOString()),
      guildId,
      attachments: (data.attachments as GuildMessageEvent['attachments'])?.map(a => ({
        content_type: a.content_type, url: normalizeAttachmentUrl(a.url),
        filename: a.filename, size: a.size, voice_wav_url: a.voice_wav_url,
      })),
    };
  }

  // ── Per-user message queue ────────────────────────────────

  private getMessagePeerId(msg: GatewayMessage): string {
    if (msg.type === 'guild') return `guild:${msg.channelId ?? 'unknown'}`;
    if (msg.type === 'group') return `group:${msg.groupOpenid ?? 'unknown'}`;
    return `dm:${msg.senderId}`;
  }

  private enqueueMessage(msg: GatewayMessage): void {
    const peerId = this.getMessagePeerId(msg);
    let queue = this.userQueues.get(peerId);
    if (!queue) {
      queue = [];
      this.userQueues.set(peerId, queue);
    }
    if (queue.length >= PER_USER_QUEUE_SIZE) {
      queue.shift();
    }
    queue.push(msg);
    this.drainUserQueue(peerId);
  }

  private async drainUserQueue(peerId: string): Promise<void> {
    if (this.activeUsers.has(peerId)) return;
    if (this.activeUsers.size >= MAX_CONCURRENT_USERS) return;

    const queue = this.userQueues.get(peerId);
    if (!queue || queue.length === 0) {
      this.userQueues.delete(peerId);
      return;
    }

    this.activeUsers.add(peerId);
    try {
      while (queue.length > 0 && !this.aborted) {
        const msg = queue.shift()!;
        try {
          this.emit('message', msg);
        } catch (err) {
          this.log.error(`Message emit error for ${peerId}: ${err}`);
        }
      }
    } finally {
      this.activeUsers.delete(peerId);
      this.userQueues.delete(peerId);
      for (const [waitingPeerId, waitingQueue] of this.userQueues) {
        if (waitingQueue.length > 0 && !this.activeUsers.has(waitingPeerId)) {
          this.drainUserQueue(waitingPeerId);
          break;
        }
      }
    }
  }
}
