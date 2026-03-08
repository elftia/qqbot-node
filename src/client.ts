/**
 * QQ Bot API client — authentication, token management, and message sending
 *
 * Features:
 * - Token singleflight (prevents duplicate fetches)
 * - Background token refresh (prevents expiry during long sessions)
 * - Upload cache integration (avoids re-uploading identical files)
 * - Proactive message support (fallback when passive reply limit exceeded)
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/
 */

import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from './upload-cache';
import { sanitizeFileName } from './utils/path-utils';
import type { QQBotLogger } from './types';
import { noopLogger } from './types';

const API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const DEFAULT_API_TIMEOUT = 30_000;
const FILE_UPLOAD_TIMEOUT = 120_000;
const UPLOAD_MAX_RETRIES = 2;
const UPLOAD_BASE_DELAY_MS = 1_000;

// ── Token cache with singleflight ──────────────────────────

let cachedToken: { token: string; expiresAt: number; appId: string } | null = null;
let tokenFetchPromise: Promise<string> | null = null;

/** Whether to send as markdown (msg_type:2) or plain text (msg_type:0) */
let markdownSupport = false;

export function setMarkdownSupport(enabled: boolean): void {
  markdownSupport = enabled;
}

export function isMarkdownEnabled(): boolean {
  return markdownSupport;
}

/**
 * Get access token with caching and singleflight deduplication.
 * When appId changes, old cache is automatically invalidated.
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000 && cachedToken.appId === appId) {
    return cachedToken.token;
  }

  if (cachedToken && cachedToken.appId !== appId) {
    cachedToken = null;
    tokenFetchPromise = null;
  }

  if (tokenFetchPromise) {
    return tokenFetchPromise;
  }

  tokenFetchPromise = (async () => {
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret }),
      });
      if (!res.ok) {
        throw new Error(`Token request failed: ${res.status}`);
      }
      const data = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) {
        throw new Error(`No access_token in response: ${JSON.stringify(data)}`);
      }
      cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
        appId,
      };
      return cachedToken.token;
    } finally {
      tokenFetchPromise = null;
    }
  })();

  return tokenFetchPromise;
}

export function clearTokenCache(): void {
  cachedToken = null;
}

/** Get current token status for monitoring */
export function getTokenStatus(): { status: 'valid' | 'expired' | 'refreshing' | 'none'; expiresAt: number | null } {
  if (tokenFetchPromise) return { status: 'refreshing', expiresAt: cachedToken?.expiresAt ?? null };
  if (!cachedToken) return { status: 'none', expiresAt: null };
  if (Date.now() >= cachedToken.expiresAt) return { status: 'expired', expiresAt: cachedToken.expiresAt };
  return { status: 'valid', expiresAt: cachedToken.expiresAt };
}

// ── Background token refresh ────────────────────────────────

let bgRefreshRunning = false;
let bgRefreshAbort: AbortController | null = null;

/**
 * Start background token refresh loop.
 * Refreshes token before expiry to avoid latency during message sending.
 */
export function startBackgroundTokenRefresh(
  appId: string, clientSecret: string,
  log?: { info: (msg: string) => void; error: (msg: string) => void },
): void {
  if (bgRefreshRunning) return;
  bgRefreshRunning = true;
  bgRefreshAbort = new AbortController();
  const signal = bgRefreshAbort.signal;

  const loop = async () => {
    log?.info('Background token refresh started');
    while (!signal.aborted) {
      try {
        await getAccessToken(appId, clientSecret);
        if (cachedToken) {
          const expiresIn = cachedToken.expiresAt - Date.now();
          const refreshAheadMs = 5 * 60 * 1000;
          const randomOffset = Math.random() * 30_000;
          const refreshIn = Math.max(expiresIn - refreshAheadMs - randomOffset, 60_000);
          await interruptibleSleep(refreshIn, signal);
        } else {
          await interruptibleSleep(60_000, signal);
        }
      } catch (err) {
        if (signal.aborted) break;
        log?.error(`Background token refresh failed: ${err}`);
        await interruptibleSleep(5_000, signal);
      }
    }
    bgRefreshRunning = false;
    log?.info('Background token refresh stopped');
  };

  loop().catch(() => { bgRefreshRunning = false; });
}

export function stopBackgroundTokenRefresh(): void {
  if (bgRefreshAbort) {
    bgRefreshAbort.abort();
    bgRefreshAbort = null;
  }
  bgRefreshRunning = false;
}

export function isBackgroundTokenRefreshRunning(): boolean {
  return bgRefreshRunning;
}

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ── API request helpers ─────────────────────────────────────

/** Generate a unique message sequence number (0~65535) */
function getNextMsgSeq(): number {
  const timePart = Date.now() % 100_000_000;
  const random = Math.floor(Math.random() * 65536);
  return (timePart ^ random) % 65536;
}

/** Mask sensitive fields in request body for logging */
function maskBodyForLog(body: unknown): string {
  if (!body) return '';
  try {
    const str = JSON.stringify(body, (_key, value) => {
      if (_key === 'file_data' && typeof value === 'string') {
        return `<base64 ${value.length} chars>`;
      }
      return value;
    });
    return str.length > 2000 ? str.slice(0, 2000) + '...' : str;
  } catch {
    return '[non-serializable]';
  }
}

/** Mask access_token in response text for logging */
function maskTokenInResponse(text: string): string {
  return text.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"***"');
}

export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
  logger?: QQBotLogger,
): Promise<T> {
  const log = logger ?? noopLogger;
  const url = `${API_BASE}${path}`;
  const isFileUpload = path.includes('/files');
  const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const headers: Record<string, string> = {
    Authorization: `QQBot ${accessToken}`,
    'Content-Type': 'application/json',
  };

  // Log request
  if (typeof process !== 'undefined' && process.env.QQBOT_DEBUG) {
    log.debug(`>>> ${method} ${url} (timeout: ${timeout}ms)`);
    if (body) log.debug(`>>> Body: ${maskBodyForLog(body)}`);
  }

  const options: RequestInit = { method, headers, signal: controller.signal };
  if (body) {
    options.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timeout [${path}]: exceeded ${timeout}ms`);
    }
    throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const rawBody = await res.text();

  // Log response
  if (typeof process !== 'undefined' && process.env.QQBOT_DEBUG) {
    log.debug(`<<< ${res.status} ${res.statusText}`);
    log.debug(`<<< Body: ${maskTokenInResponse(rawBody.slice(0, 2000))}`);
  }

  let data: T;
  try {
    data = JSON.parse(rawBody) as T;
  } catch {
    throw new Error(`Failed to parse response [${path}]: ${rawBody.slice(0, 200)}`);
  }

  if (!res.ok) {
    const error = data as { message?: string; code?: number };
    throw new Error(`API Error [${path}]: ${res.status} ${error.message ?? rawBody.slice(0, 200)}`);
  }

  return data;
}

async function apiRequestWithRetry<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  logger?: QQBotLogger,
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      return await apiRequest<T>(accessToken, method, path, body, undefined, logger);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const errMsg = lastError.message;
      if (errMsg.includes('400') || errMsg.includes('401') || errMsg.includes('Invalid')
        || errMsg.includes('timeout') || errMsg.includes('Timeout') || errMsg.includes('上传超时')) {
        throw lastError;
      }
      if (attempt < UPLOAD_MAX_RETRIES) {
        const delay = UPLOAD_BASE_DELAY_MS * 2 ** attempt;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError!;
}

// ── Gateway ─────────────────────────────────────────────────

export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, 'GET', '/gateway');
  return data.url;
}

// ── Message sending ─────────────────────────────────────────

export interface MessageResponse {
  id: string;
  timestamp: number | string;
}

function buildMessageBody(content: string, msgId: string | undefined, msgSeq: number): Record<string, unknown> {
  const body: Record<string, unknown> = markdownSupport
    ? { markdown: { content }, msg_type: 2, msg_seq: msgSeq }
    : { content, msg_type: 0, msg_seq: msgSeq };
  if (msgId) body.msg_id = msgId;
  return body;
}

function buildProactiveMessageBody(content: string): Record<string, unknown> {
  if (!content || content.trim().length === 0) {
    throw new Error('Proactive message content cannot be empty');
  }
  return markdownSupport
    ? { markdown: { content }, msg_type: 2 }
    : { content, msg_type: 0 };
}

export async function sendC2CMessage(token: string, openid: string, content: string, msgId?: string): Promise<MessageResponse> {
  return apiRequest(token, 'POST', `/v2/users/${openid}/messages`, buildMessageBody(content, msgId, getNextMsgSeq()));
}

export async function sendGroupMessage(token: string, groupOpenid: string, content: string, msgId?: string): Promise<MessageResponse> {
  return apiRequest(token, 'POST', `/v2/groups/${groupOpenid}/messages`, buildMessageBody(content, msgId, getNextMsgSeq()));
}

export async function sendChannelMessage(token: string, channelId: string, content: string, msgId?: string): Promise<{ id: string; timestamp: string }> {
  return apiRequest(token, 'POST', `/channels/${channelId}/messages`, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

/** Proactive C2C message (no msg_id required, monthly quota: ~4/user) */
export async function sendProactiveC2CMessage(token: string, openid: string, content: string): Promise<MessageResponse> {
  return apiRequest(token, 'POST', `/v2/users/${openid}/messages`, buildProactiveMessageBody(content));
}

/** Proactive Group message (no msg_id required, monthly quota: ~4/group) */
export async function sendProactiveGroupMessage(token: string, groupOpenid: string, content: string): Promise<MessageResponse> {
  return apiRequest(token, 'POST', `/v2/groups/${groupOpenid}/messages`, buildProactiveMessageBody(content));
}

export async function sendC2CInputNotify(token: string, openid: string, msgId?: string, inputSecond = 60): Promise<void> {
  await apiRequest(token, 'POST', `/v2/users/${openid}/messages`, {
    msg_type: 6,
    input_notify: { input_type: 1, input_second: inputSecond },
    msg_seq: getNextMsgSeq(),
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

// ── Rich media upload & send ────────────────────────────────

export enum MediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4,
}

export interface UploadMediaResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
}

export async function uploadC2CMedia(
  token: string, openid: string, fileType: MediaFileType,
  url?: string, fileData?: string, srvSendMsg = false, fileName?: string,
): Promise<UploadMediaResponse> {
  if (!url && !fileData) throw new Error('uploadC2CMedia: url or fileData is required');

  if (fileData) {
    const hash = computeFileHash(fileData);
    const cached = getCachedFileInfo(hash, 'c2c', openid, fileType);
    if (cached) return { file_uuid: '', file_info: cached, ttl: 0 };
  }

  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) body.url = url; else if (fileData) body.file_data = fileData;
  if (fileType === MediaFileType.FILE && fileName) body.file_name = sanitizeFileName(fileName);

  const result = await apiRequestWithRetry<UploadMediaResponse>(token, 'POST', `/v2/users/${openid}/files`, body);

  if (fileData && result.file_info && result.ttl > 0) {
    const hash = computeFileHash(fileData);
    setCachedFileInfo(hash, 'c2c', openid, fileType, result.file_info, result.file_uuid, result.ttl);
  }

  return result;
}

export async function uploadGroupMedia(
  token: string, groupOpenid: string, fileType: MediaFileType,
  url?: string, fileData?: string, srvSendMsg = false, fileName?: string,
): Promise<UploadMediaResponse> {
  if (!url && !fileData) throw new Error('uploadGroupMedia: url or fileData is required');

  if (fileData) {
    const hash = computeFileHash(fileData);
    const cached = getCachedFileInfo(hash, 'group', groupOpenid, fileType);
    if (cached) return { file_uuid: '', file_info: cached, ttl: 0 };
  }

  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) body.url = url; else if (fileData) body.file_data = fileData;
  if (fileType === MediaFileType.FILE && fileName) body.file_name = sanitizeFileName(fileName);

  const result = await apiRequestWithRetry<UploadMediaResponse>(token, 'POST', `/v2/groups/${groupOpenid}/files`, body);

  if (fileData && result.file_info && result.ttl > 0) {
    const hash = computeFileHash(fileData);
    setCachedFileInfo(hash, 'group', groupOpenid, fileType, result.file_info, result.file_uuid, result.ttl);
  }

  return result;
}

async function sendMediaMessage(
  token: string, path: string, fileInfo: string, msgId?: string, content?: string,
): Promise<MessageResponse> {
  return apiRequest(token, 'POST', path, {
    msg_type: 7,
    media: { file_info: fileInfo },
    msg_seq: getNextMsgSeq(),
    ...(content ? { content } : {}),
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

export async function sendC2CImageMessage(token: string, openid: string, imageUrl: string, msgId?: string, content?: string): Promise<MessageResponse> {
  const isDataUrl = imageUrl.startsWith('data:');
  let upload: UploadMediaResponse;
  if (isDataUrl) {
    const match = imageUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL format');
    upload = await uploadC2CMedia(token, openid, MediaFileType.IMAGE, undefined, match[1]);
  } else {
    upload = await uploadC2CMedia(token, openid, MediaFileType.IMAGE, imageUrl);
  }
  return sendMediaMessage(token, `/v2/users/${openid}/messages`, upload.file_info, msgId, content);
}

export async function sendGroupImageMessage(token: string, groupOpenid: string, imageUrl: string, msgId?: string, content?: string): Promise<MessageResponse> {
  const isDataUrl = imageUrl.startsWith('data:');
  let upload: UploadMediaResponse;
  if (isDataUrl) {
    const match = imageUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL format');
    upload = await uploadGroupMedia(token, groupOpenid, MediaFileType.IMAGE, undefined, match[1]);
  } else {
    upload = await uploadGroupMedia(token, groupOpenid, MediaFileType.IMAGE, imageUrl);
  }
  return sendMediaMessage(token, `/v2/groups/${groupOpenid}/messages`, upload.file_info, msgId, content);
}

export async function sendC2CVoiceMessage(token: string, openid: string, voiceBase64: string, msgId?: string): Promise<MessageResponse> {
  const upload = await uploadC2CMedia(token, openid, MediaFileType.VOICE, undefined, voiceBase64);
  return sendMediaMessage(token, `/v2/users/${openid}/messages`, upload.file_info, msgId);
}

export async function sendGroupVoiceMessage(token: string, groupOpenid: string, voiceBase64: string, msgId?: string): Promise<MessageResponse> {
  const upload = await uploadGroupMedia(token, groupOpenid, MediaFileType.VOICE, undefined, voiceBase64);
  return sendMediaMessage(token, `/v2/groups/${groupOpenid}/messages`, upload.file_info, msgId);
}

export async function sendC2CVideoMessage(token: string, openid: string, videoUrl?: string, videoBase64?: string, msgId?: string, content?: string): Promise<MessageResponse> {
  const upload = await uploadC2CMedia(token, openid, MediaFileType.VIDEO, videoUrl, videoBase64);
  return sendMediaMessage(token, `/v2/users/${openid}/messages`, upload.file_info, msgId, content);
}

export async function sendGroupVideoMessage(token: string, groupOpenid: string, videoUrl?: string, videoBase64?: string, msgId?: string, content?: string): Promise<MessageResponse> {
  const upload = await uploadGroupMedia(token, groupOpenid, MediaFileType.VIDEO, videoUrl, videoBase64);
  return sendMediaMessage(token, `/v2/groups/${groupOpenid}/messages`, upload.file_info, msgId, content);
}

export async function sendC2CFileMessage(token: string, openid: string, fileBase64?: string, fileUrl?: string, msgId?: string, fileName?: string): Promise<MessageResponse> {
  const upload = await uploadC2CMedia(token, openid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
  return sendMediaMessage(token, `/v2/users/${openid}/messages`, upload.file_info, msgId);
}

export async function sendGroupFileMessage(token: string, groupOpenid: string, fileBase64?: string, fileUrl?: string, msgId?: string, fileName?: string): Promise<MessageResponse> {
  const upload = await uploadGroupMedia(token, groupOpenid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
  return sendMediaMessage(token, `/v2/groups/${groupOpenid}/messages`, upload.file_info, msgId);
}
