/**
 * QQ Bot SDK type definitions
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/
 */

/** Chat type identifier for routing send calls to the correct API endpoint */
export type QQChatType = 'channel' | 'group' | 'c2c' | 'dm';

/** WebSocket payload from QQ gateway */
export interface WSPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

/** C2C (friend/single-user) message event */
export interface C2CMessageEvent {
  author: {
    id: string;
    union_openid: string;
    user_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  attachments?: MessageAttachment[];
}

/** Guild channel message event */
export interface GuildMessageEvent {
  id: string;
  channel_id: string;
  guild_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username?: string;
    bot?: boolean;
  };
  member?: {
    nick?: string;
  };
  attachments?: MessageAttachment[];
}

/** Group message event */
export interface GroupMessageEvent {
  author: {
    id: string;
    member_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  group_id: string;
  group_openid: string;
  attachments?: MessageAttachment[];
}

/** Message attachment */
export interface MessageAttachment {
  content_type: string;
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
  url: string;
  /** QQ may provide WAV URL directly for voice, avoiding SILK→WAV conversion */
  voice_wav_url?: string;
}

/** Parsed inbound message from the QQ gateway */
export interface GatewayMessage {
  type: 'c2c' | 'guild' | 'dm' | 'group';
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
    size?: number;
    voice_wav_url?: string;
    /** Local file path after download (only when downloadDir is configured) */
    localPath?: string;
  }>;
}

/** Simple logger interface — consumers inject their own logger */
export interface QQBotLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** Session persistence interface — consumers inject their own storage */
export interface SessionStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** No-op logger for default */
export const noopLogger: QQBotLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Message reply rate limiting record */
export interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}
