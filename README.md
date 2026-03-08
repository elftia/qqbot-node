# @elftia/qqbot-node

QQ Bot SDK for Node.js — [QQ Open Platform API v2](https://bot.q.qq.com/wiki/develop/api-v2/) 的完整实现。

中文 | [English](README.en.md) | [日本語](README.ja.md)

## Why

[OpenClaw](https://github.com/openclaw/openclaw) 及其各种轻量级复刻项目（如 [Elftia](https://github.com/elftia) 等）都需要接入 QQ Bot，但各项目重复实现 QQ 协议层既浪费又容易出 bug。

本 SDK 将 QQ Bot 的协议层抽离为独立的、框架无关的 npm 包，让任何 claw 类项目——以及任何 Node.js 项目——都能通过 `npm install` 一行命令接入 QQ Bot，无需关心 WebSocket 重连、SILK 编解码、Token 刷新等底层细节。

**设计目标：**

- **框架无关** — 不依赖任何 claw 框架的内部接口，纯 EventEmitter + 依赖注入
- **开箱即用** — 一个包搞定 Gateway 连接、消息收发、富媒体、语音转码
- **可插拔** — 注入自己的 Logger 和 SessionStore，适配任何运行环境
- **协议完整** — 覆盖 C2C、群聊、频道、频道私信全场景

> 灵感来自 [@sliverp/qqbot](https://github.com/sliverp/qqbot) — OpenClaw 生态中首个 QQ Bot 频道插件。
> 本 SDK 将其中通用的协议层提取为独立包，使得各 claw 项目可以共享同一套 QQ Bot 实现。

## Features

- **WebSocket Gateway** — 自动重连、心跳、Session Resume、Intent 降级
- **消息收发** — C2C（好友）、群聊、频道、频道私信；被动回复 + 主动推送
- **富媒体** — 图片、语音、视频、文件上传，带去重缓存
- **SILK 音频** — SILK ↔ WAV 转换，任意格式 → SILK 编码（QQ 原生语音格式）
- **TTS** — 通过 OpenAI 兼容 API 文字转语音，输出 SILK 语音消息
- **Token 管理** — Singleflight 去重、后台刷新、自动失效重取
- **被动回复限制** — 每条消息 4 次/小时，超限自动降级为主动消息
- **Per-User 队列** — 同用户串行、跨用户并行消息处理
- **框架无关** — 基于 EventEmitter，注入 Logger 和 SessionStore 即可

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

本 SDK 设计为 claw 生态的底层依赖。各 claw 项目只需编写一层薄适配即可接入 QQ Bot：

```
┌─────────────────────────────────────────────┐
│  OpenClaw / Elftia / YourProject             │  ← claw 框架层
├─────────────────────────────────────────────┤
│  Thin Adapter (channel plugin)              │  ← 适配层（~200 行）
├─────────────────────────────────────────────┤
│  @elftia/qqbot-node                         │  ← 本 SDK
└─────────────────────────────────────────────┘
```

适配层只需要做三件事：

1. **桥接 Logger** — 将框架的日志系统注入 SDK
2. **桥接 SessionStore** — 将框架的存储注入 SDK（用于 WS session resume）
3. **映射消息格式** — SDK 的 `GatewayMessage` ↔ 框架的内部消息格式

```typescript
import { QQBotGateway } from '@elftia/qqbot-node';
import type { SessionStore, QQBotLogger } from '@elftia/qqbot-node';

// 1. 桥接 Logger
const logger: QQBotLogger = {
  debug: (msg) => yourFramework.log.debug(msg),
  info:  (msg) => yourFramework.log.info(msg),
  warn:  (msg) => yourFramework.log.warn(msg),
  error: (msg) => yourFramework.log.error(msg),
};

// 2. 桥接 SessionStore
const sessionStore: SessionStore = {
  get: (key) => yourFramework.storage.get(key),
  set: (key, value) => yourFramework.storage.set(key, value),
  delete: (key) => yourFramework.storage.delete(key),
};

// 3. 连接并监听消息
const gateway = new QQBotGateway({ appId, clientSecret, logger, sessionStore });

gateway.on('message', (msg) => {
  // 映射为你框架的消息格式，然后交给框架处理
  yourFramework.handleInbound({
    id: msg.messageId,
    sender: msg.senderId,
    content: msg.content,
    // ...
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

## Related Projects

| Project | Description |
|---------|-------------|
| [@sliverp/qqbot](https://github.com/sliverp/qqbot) | OpenClaw QQ Bot channel plugin — 本 SDK 的灵感来源 |
| [@elftia/channel-qqbot](https://github.com/elftia/elftia) | Elftia 的 QQ Bot 适配层，基于本 SDK |
| [OpenClaw](https://github.com/openclaw/openclaw) | AI 聊天框架，本 SDK 的主要使用场景之一 |

## Prerequisites

- **Node.js >= 18** (for native `fetch`)
- **QQ Bot credentials** — register at [QQ Open Platform](https://q.qq.com)
- **silk-wasm** — bundled, requires WASM support
- **ffmpeg** (optional) — enables conversion of all audio formats; without it, only WAV/MP3/SILK/PCM are supported

## License

[MIT](LICENSE)
