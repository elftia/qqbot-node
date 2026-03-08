# @elftia/qqbot-node

QQ Bot SDK for Node.js — a complete implementation of [QQ Open Platform API v2](https://bot.q.qq.com/wiki/develop/api-v2/).

[中文](README.md) | English | [日本語](README.ja.md)

## Why

[OpenClaw](https://github.com/open-claw) and its lightweight forks (such as [Elftia](https://github.com/elftia), [MoltBot](https://github.com/moltbot), etc.) all need QQ Bot integration. Having each project reimplement the QQ protocol layer is wasteful and error-prone.

This SDK extracts the QQ Bot protocol layer into a standalone, framework-agnostic npm package, so any claw-family project — or any Node.js project — can integrate QQ Bot with a single `npm install`, without worrying about WebSocket reconnection, SILK codec, token refresh, and other low-level details.

**Design goals:**

- **Framework-agnostic** — no dependency on any claw framework internals; pure EventEmitter + dependency injection
- **Batteries included** — one package covers Gateway connection, messaging, rich media, and audio transcoding
- **Pluggable** — inject your own Logger and SessionStore to fit any runtime environment
- **Protocol-complete** — covers C2C, group, guild channel, and guild DM scenarios

> Inspired by [@sliverp/qqbot](https://github.com/sliverp/qqbot) — the first QQ Bot channel plugin in the OpenClaw ecosystem.
> This SDK extracts the generic protocol layer so that all claw projects can share a single QQ Bot implementation.

## Features

- **WebSocket Gateway** — auto-reconnect, heartbeat, session resume, intent degradation
- **Message Sending** — C2C (friend), group, guild channel, DM; passive reply + proactive push
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
  logger: console,
});

gateway.on('connected', () => {
  console.log('Bot connected!');
  startBackgroundTokenRefresh(appId, clientSecret, console);
});

gateway.on('message', async (msg) => {
  console.log(`[${msg.type}] ${msg.senderName}: ${msg.content}`);

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

## Integration with Claw Projects

This SDK is designed as a low-level dependency for the claw ecosystem. Each claw project only needs a thin adapter to integrate QQ Bot:

```
┌─────────────────────────────────────────────┐
│  OpenClaw / Elftia / MoltBot / YourProject  │  ← claw framework layer
├─────────────────────────────────────────────┤
│  Thin Adapter (channel plugin)              │  ← adapter layer (~200 lines)
├─────────────────────────────────────────────┤
│  @elftia/qqbot-node                         │  ← this SDK
└─────────────────────────────────────────────┘
```

The adapter layer only needs to do three things:

1. **Bridge Logger** — inject your framework's logging system into the SDK
2. **Bridge SessionStore** — inject your framework's storage into the SDK (for WS session resume)
3. **Map message format** — SDK's `GatewayMessage` ↔ your framework's internal message format

```typescript
import { QQBotGateway } from '@elftia/qqbot-node';
import type { SessionStore, QQBotLogger } from '@elftia/qqbot-node';

// 1. Bridge Logger
const logger: QQBotLogger = {
  debug: (msg) => yourFramework.log.debug(msg),
  info:  (msg) => yourFramework.log.info(msg),
  warn:  (msg) => yourFramework.log.warn(msg),
  error: (msg) => yourFramework.log.error(msg),
};

// 2. Bridge SessionStore
const sessionStore: SessionStore = {
  get: (key) => yourFramework.storage.get(key),
  set: (key, value) => yourFramework.storage.set(key, value),
  delete: (key) => yourFramework.storage.delete(key),
};

// 3. Connect and listen
const gateway = new QQBotGateway({ appId, clientSecret, logger, sessionStore });

gateway.on('message', (msg) => {
  yourFramework.handleInbound({
    id: msg.messageId,
    sender: msg.senderId,
    content: msg.content,
  });
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
  logger?: QQBotLogger,
  sessionStore?: SessionStore,
});

await gateway.start();
gateway.stop();
gateway.connected; // boolean

gateway.on('message', (msg: GatewayMessage) => {});
gateway.on('connected', () => {});
gateway.on('disconnected', (code: number) => {});
gateway.on('reconnecting', (attempt: number) => {});
gateway.on('error', (error: Error) => {});
gateway.on('status', (status: string) => {});

gateway.lastMsgId.get(chatId);
```

### Token Management

```typescript
import {
  getAccessToken,
  clearTokenCache,
  startBackgroundTokenRefresh,
  stopBackgroundTokenRefresh,
} from '@elftia/qqbot-node';

const token = await getAccessToken(appId, clientSecret);
startBackgroundTokenRefresh(appId, clientSecret, logger);
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
  sendC2CInputNotify,
} from '@elftia/qqbot-node';

await sendC2CMessage(token, openId, 'Hello!', msgId);
await sendGroupMessage(token, groupOpenId, 'Hello!', msgId);
await sendChannelMessage(token, channelId, 'Hello!', msgId);
await sendProactiveC2CMessage(token, openId, 'Hey there!');
await sendC2CInputNotify(token, openId);
```

### Rich Media

```typescript
import {
  sendC2CImageMessage,
  sendC2CVoiceMessage,
  sendC2CVideoMessage,
  sendC2CFileMessage,
} from '@elftia/qqbot-node';

await sendC2CImageMessage(token, openId, 'https://example.com/photo.jpg', msgId);
await sendC2CVoiceMessage(token, openId, silkBase64, msgId);
await sendC2CVideoMessage(token, openId, 'https://example.com/video.mp4', undefined, msgId);
await sendC2CFileMessage(token, openId, fileBase64, undefined, msgId, 'document.pdf');
```

### Audio Conversion

```typescript
import {
  convertSilkToWav,
  audioFileToSilkBase64,
  textToSilk,
  detectFfmpeg,
} from '@elftia/qqbot-node';

const wav = await convertSilkToWav('/path/to/voice.silk', '/output/dir');
const silk = await audioFileToSilkBase64('/path/to/audio.mp3');
const result = await textToSilk('Hello world', ttsConfig, '/output/dir');
const ffmpegPath = await detectFfmpeg();
```

## Interfaces

### QQBotLogger

```typescript
interface QQBotLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}
```

### SessionStore

```typescript
interface SessionStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
```

## Gateway Behavior

### Intent Degradation

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

## Related Projects

| Project | Description |
|---------|-------------|
| [@sliverp/qqbot](https://github.com/sliverp/qqbot) | OpenClaw QQ Bot channel plugin — the inspiration for this SDK |
| [@elftia/channel-qqbot](https://github.com/elftia/elftia) | Elftia's QQ Bot adapter layer, built on this SDK |
| [OpenClaw](https://github.com/open-claw) | AI chat framework, one of the primary consumers of this SDK |

## Prerequisites

- **Node.js >= 18** (for native `fetch`)
- **QQ Bot credentials** — register at [QQ Open Platform](https://q.qq.com)
- **silk-wasm** — bundled, requires WASM support
- **ffmpeg** (optional) — enables all audio formats; without it, only WAV/MP3/SILK/PCM are supported

## License

[MIT](LICENSE)
