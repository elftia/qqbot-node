# @elftia/qqbot-node

Full-featured QQ Bot SDK for Node.js, built on [QQ Open Platform API v2](https://bot.q.qq.com/wiki/develop/api-v2/).

## Features

- **WebSocket Gateway** — auto-reconnect, heartbeat, session resume, intent degradation
- **Message Sending** — C2C (friend), group, guild channel, DM; passive and proactive modes
- **Rich Media** — image, voice, video, file upload with deduplication cache
- **SILK Audio** — SILK ↔ WAV conversion, any-format → SILK encoding (QQ's native voice format)
- **TTS** — text-to-speech via OpenAI-compatible API, output as SILK voice message
- **Token Management** — singleflight deduplication, background refresh, auto-invalidation
- **Rate Limiting** — passive reply limiter (4/msg/hour) with proactive message fallback
- **Per-User Queue** — serialized message processing per user, parallel across users
- **Framework-Agnostic** — EventEmitter-based, inject your own logger and session store

## Install

```bash
npm install @elftia/qqbot-node
```

## Quick Start

```typescript
import {
  QQBotGateway,
  getAccessToken,
  sendC2CMessage,
  startBackgroundTokenRefresh,
} from '@elftia/qqbot-node';

const appId = 'YOUR_APP_ID';
const clientSecret = 'YOUR_CLIENT_SECRET';

const gateway = new QQBotGateway({
  appId,
  clientSecret,
  logger: console, // or any { debug, info, warn, error } object
});

gateway.on('connected', () => {
  console.log('Bot connected!');
  startBackgroundTokenRefresh(appId, clientSecret, console);
});

gateway.on('message', async (msg) => {
  console.log(`[${msg.type}] ${msg.senderName}: ${msg.content}`);

  // Echo reply
  const token = await getAccessToken(appId, clientSecret);
  if (msg.type === 'c2c') {
    await sendC2CMessage(token, msg.senderId, `You said: ${msg.content}`, msg.messageId);
  }
});

gateway.on('error', (err) => {
  console.error('Gateway error:', err);
});

await gateway.start();
```

## API Reference

### Gateway

```typescript
import { QQBotGateway } from '@elftia/qqbot-node';

const gateway = new QQBotGateway({
  appId: string,
  clientSecret: string,
  logger?: QQBotLogger,       // { debug, info, warn, error }
  sessionStore?: SessionStore, // { get, set, delete } for session persistence
});

// Lifecycle
await gateway.start();
gateway.stop();
gateway.connected; // boolean

// Events
gateway.on('message', (msg: GatewayMessage) => {});
gateway.on('connected', () => {});
gateway.on('disconnected', (code: number) => {});
gateway.on('reconnecting', (attempt: number) => {});
gateway.on('error', (error: Error) => {});
gateway.on('status', (status: string) => {});

// Last message ID per chat (needed for passive replies)
gateway.lastMsgId.get(chatId);
```

### Token Management

```typescript
import {
  getAccessToken,
  clearTokenCache,
  getTokenStatus,
  startBackgroundTokenRefresh,
  stopBackgroundTokenRefresh,
} from '@elftia/qqbot-node';

const token = await getAccessToken(appId, clientSecret);
// Cached with singleflight — safe to call concurrently

startBackgroundTokenRefresh(appId, clientSecret, logger);
// Refreshes token before expiry in the background

stopBackgroundTokenRefresh();
clearTokenCache();
```

### Message Sending

```typescript
import {
  sendC2CMessage,
  sendGroupMessage,
  sendChannelMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendC2CInputNotify,
} from '@elftia/qqbot-node';

// Passive reply (requires msg_id from inbound message)
await sendC2CMessage(token, openId, 'Hello!', msgId);
await sendGroupMessage(token, groupOpenId, 'Hello!', msgId);
await sendChannelMessage(token, channelId, 'Hello!', msgId);

// Proactive message (no msg_id, limited to ~4/user/month)
await sendProactiveC2CMessage(token, openId, 'Hey there!');

// Typing indicator (C2C only)
await sendC2CInputNotify(token, openId);
```

### Rich Media

```typescript
import {
  sendC2CImageMessage,
  sendGroupImageMessage,
  sendC2CVoiceMessage,
  sendGroupVoiceMessage,
  sendC2CVideoMessage,
  sendGroupVideoMessage,
  sendC2CFileMessage,
  sendGroupFileMessage,
  MediaFileType,
  uploadC2CMedia,
  uploadGroupMedia,
} from '@elftia/qqbot-node';

// Image (HTTP URL or data URL)
await sendC2CImageMessage(token, openId, 'https://example.com/photo.jpg', msgId);

// Voice (SILK base64)
await sendC2CVoiceMessage(token, openId, silkBase64, msgId);

// Video
await sendC2CVideoMessage(token, openId, 'https://example.com/video.mp4', undefined, msgId);

// File
await sendC2CFileMessage(token, openId, fileBase64, undefined, msgId, 'document.pdf');

// Low-level upload
const result = await uploadC2CMedia(token, openId, MediaFileType.IMAGE, url);
```

### Audio Conversion

```typescript
import {
  convertSilkToWav,
  audioFileToSilkBase64,
  isVoiceAttachment,
  detectFfmpeg,
  textToSilk,
} from '@elftia/qqbot-node';

// SILK → WAV (for speech-to-text)
const wav = await convertSilkToWav('/path/to/voice.silk', '/output/dir');
// { wavPath: '/output/dir/voice.wav', duration: 3200 }

// Any audio → SILK base64 (for sending voice messages)
const silk = await audioFileToSilkBase64('/path/to/audio.mp3');

// TTS → SILK (text-to-speech as QQ voice message)
const result = await textToSilk('Hello world', ttsConfig, '/output/dir');
// { silkPath, silkBase64, duration }

// Check voice attachment
isVoiceAttachment({ content_type: 'voice' }); // true

// Detect ffmpeg
const ffmpegPath = await detectFfmpeg(); // '/usr/bin/ffmpeg' or null
```

### Reply Rate Limiter

```typescript
import { checkReplyLimit, recordReply } from '@elftia/qqbot-node';

const result = checkReplyLimit(messageId);
// { allowed: true, remaining: 3, shouldFallbackToProactive: false }

recordReply(messageId); // Track one reply
```

### Image Size

```typescript
import {
  getImageSize,
  parseImageSize,
  formatQQBotMarkdownImage,
} from '@elftia/qqbot-node';

// From URL (fetches first 64KB only)
const size = await getImageSize('https://example.com/photo.png');
// { width: 800, height: 600 }

// QQ Bot markdown format
formatQQBotMarkdownImage('https://example.com/photo.png', size);
// '![#800px #600px](https://example.com/photo.png)'
```

### Utilities

```typescript
import {
  encodeChatId,
  decodeChatId,
  normalizePath,
  sanitizeFileName,
  isLocalPath,
  runDiagnostics,
} from '@elftia/qqbot-node';

encodeChatId('c2c', 'user123');     // 'c2c:user123'
decodeChatId('group:abc');          // { type: 'group', id: 'abc' }

normalizePath('~/Downloads/img.png'); // '/home/user/Downloads/img.png'
sanitizeFileName('my%20file.pdf');    // 'my file.pdf'

// Startup diagnostics (ffmpeg, silk-wasm, temp dir)
const report = await runDiagnostics(console);
```

## Interfaces

### QQBotLogger

Inject your own logger — any object with `debug`, `info`, `warn`, `error` methods.

```typescript
interface QQBotLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}
```

### SessionStore

Inject your own persistence for WebSocket session resume. Without it, sessions are in-memory only.

```typescript
interface SessionStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Example with file system:

```typescript
import fs from 'fs';
import path from 'path';

const dataDir = '/path/to/data';
const sessionStore: SessionStore = {
  async get(key) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, `${key}.json`), 'utf-8'));
    } catch { return null; }
  },
  async set(key, value) {
    fs.writeFileSync(path.join(dataDir, `${key}.json`), JSON.stringify(value));
  },
  async delete(key) {
    try { fs.unlinkSync(path.join(dataDir, `${key}.json`)); } catch {}
  },
};
```

## Gateway Behavior

### Intent Degradation

The gateway automatically downgrades intents when the bot lacks permissions:

| Level | Name | Capabilities |
|-------|------|-------------|
| 0 | full | C2C + Group + Guild + DM |
| 1 | group+channel | C2C + Group + Guild |
| 2 | channel-only | Guild + Guild Members |

### Close Code Handling

| Code | Action |
|------|--------|
| 4004 | Refresh token, reconnect |
| 4006/4007/4009 | Clear session, re-identify |
| 4008 | Rate limited, wait 60s |
| 4014 | Intent rejected, downgrade level |
| 4914 | Bot offline/sandbox, stop |
| 4915 | Bot banned, stop |

### Reconnection

- Exponential backoff: 1s → 2s → 5s → 10s → 30s → 60s
- Max 100 attempts before giving up
- Quick disconnect detection (3 disconnects within 5s triggers extended backoff)

## Prerequisites

- **Node.js >= 18** (for native `fetch`)
- **QQ Bot credentials** — register at [QQ Open Platform](https://q.qq.com)
- **silk-wasm** — bundled, requires WASM support (Node.js >= 16)
- **ffmpeg** (optional) — enables conversion of all audio formats; without it, only WAV/MP3/SILK/PCM are supported

## License

[MIT](LICENSE)
