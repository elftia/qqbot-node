/**
 * @elftia/qqbot-node — QQ Bot SDK for Node.js
 *
 * Full-featured QQ Open Platform API v2 client.
 * Supports guild channels, QQ groups, C2C (friend) messages, and guild DMs.
 * Handles rich media (image/voice/video/file), SILK audio conversion,
 * intent degradation, session resume, and per-user message queuing.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/
 *
 * @example
 * ```ts
 * import { QQBotGateway, getAccessToken, sendC2CMessage } from '@elftia/qqbot-node';
 *
 * const gateway = new QQBotGateway({ appId: '...', clientSecret: '...' });
 * gateway.on('message', async (msg) => {
 *   const token = await getAccessToken(appId, clientSecret);
 *   await sendC2CMessage(token, msg.senderId, 'Hello!', msg.messageId);
 * });
 * await gateway.start();
 * ```
 */

// ── Types ───────────────────────────────────────────────────
export type {
  QQChatType,
  WSPayload,
  C2CMessageEvent,
  GuildMessageEvent,
  GroupMessageEvent,
  MessageAttachment,
  GatewayMessage,
  QQBotLogger,
  SessionStore,
  MessageReplyRecord,
} from './types';
export { noopLogger } from './types';

// ── Client (API + Token) ────────────────────────────────────
export {
  getAccessToken,
  clearTokenCache,
  getTokenStatus,
  setMarkdownSupport,
  isMarkdownEnabled,
  startBackgroundTokenRefresh,
  stopBackgroundTokenRefresh,
  isBackgroundTokenRefreshRunning,
  apiRequest,
  getGatewayUrl,
  // Message sending
  sendC2CMessage,
  sendGroupMessage,
  sendChannelMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendC2CInputNotify,
  // Rich media
  MediaFileType,
  uploadC2CMedia,
  uploadGroupMedia,
  sendC2CImageMessage,
  sendGroupImageMessage,
  sendC2CVoiceMessage,
  sendGroupVoiceMessage,
  sendC2CVideoMessage,
  sendGroupVideoMessage,
  sendC2CFileMessage,
  sendGroupFileMessage,
} from './client';
export type { MessageResponse, UploadMediaResponse } from './client';

// ── Gateway ─────────────────────────────────────────────────
export { QQBotGateway, encodeChatId, decodeChatId, cleanMessageContent, normalizeAttachmentUrl } from './gateway';
export type { GatewayOptions, QQBotGatewayEvents } from './gateway';

// ── Reply limiter ───────────────────────────────────────────
export {
  checkReplyLimit,
  recordReply,
  getMessageReplyStats,
  getMessageReplyConfig,
} from './reply-limiter';
export type { ReplyLimitResult } from './reply-limiter';

// ── Upload cache ────────────────────────────────────────────
export {
  computeFileHash,
  getCachedFileInfo,
  setCachedFileInfo,
  clearUploadCache,
  getUploadCacheStats,
} from './upload-cache';

// ── Audio conversion ────────────────────────────────────────
export {
  convertSilkToWav,
  audioFileToSilkBase64,
  isVoiceAttachment,
  isAudioFile,
  detectFfmpeg,
  ffmpegToPCM,
  resampleLinear,
  checkSilkWasmAvailable,
  formatDuration,
  waitForFile,
  // TTS
  textToSpeechPCM,
  pcmToSilk,
  textToSilk,
} from './utils/audio-convert';
export type { TTSConfig } from './utils/audio-convert';

// ── Image size ──────────────────────────────────────────────
export {
  parseImageSize,
  getImageSize,
  getImageSizeFromUrl,
  getImageSizeFromDataUrl,
  formatQQBotMarkdownImage,
  hasQQBotImageSize,
  DEFAULT_IMAGE_SIZE,
} from './utils/image-size';
export type { ImageSize } from './utils/image-size';

// ── File utilities ──────────────────────────────────────────
export {
  checkFileSize,
  readFileAsync,
  fileExistsAsync,
  isLargeFile,
  formatFileSize,
  getImageMimeType,
  getMimeType,
  MAX_UPLOAD_SIZE,
} from './utils/file-utils';

// ── Path utilities ──────────────────────────────────────────
export {
  expandTilde,
  normalizePath,
  sanitizeFileName,
  isLocalPath,
  looksLikeLocalPath,
} from './utils/path-utils';

// ── Diagnostics ─────────────────────────────────────────────
export { runDiagnostics } from './utils/diagnostics';
export type { DiagnosticReport } from './utils/diagnostics';
