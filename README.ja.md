# @elftia/qqbot-node

QQ Bot SDK for Node.js — [QQ Open Platform API v2](https://bot.q.qq.com/wiki/develop/api-v2/) の完全実装。

[中文](README.md) | [English](README.en.md) | 日本語

## なぜこの SDK が必要か

[OpenClaw](https://github.com/openclaw/openclaw) およびその軽量フォーク群（[Elftia](https://github.com/elftia) など）は、いずれも QQ Bot との連携が必要です。各プロジェクトが QQ プロトコル層を独自に実装するのは無駄が多く、バグの温床にもなります。

この SDK は QQ Bot のプロトコル層を独立したフレームワーク非依存の npm パッケージとして切り出しました。あらゆる claw 系プロジェクト——そしてあらゆる Node.js プロジェクト——が `npm install` 一行で QQ Bot に接続でき、WebSocket 再接続、SILK コーデック、トークンリフレッシュなどの低レベルな詳細を気にする必要がありません。

**設計目標：**

- **フレームワーク非依存** — claw フレームワークの内部 API に依存しない、純粋な EventEmitter + 依存性注入
- **すぐに使える** — Gateway 接続、メッセージ送受信、リッチメディア、音声変換を1パッケージで完結
- **プラグイン可能** — 独自の Logger と SessionStore を注入して、任意の実行環境に対応
- **プロトコル完全対応** — C2C、グループ、ギルドチャンネル、ギルド DM の全シナリオをカバー

> [@sliverp/qqbot](https://github.com/sliverp/qqbot) にインスパイアされました — OpenClaw エコシステム初の QQ Bot チャンネルプラグインです。
> この SDK は汎用プロトコル層を抽出し、すべての claw プロジェクトが同一の QQ Bot 実装を共有できるようにしました。

## 機能

- **WebSocket Gateway** — 自動再接続、ハートビート、セッション再開、Intent 段階的ダウングレード
- **メッセージ送受信** — C2C（フレンド）、グループ、ギルドチャンネル、DM；パッシブ応答 + プロアクティブ送信
- **リッチメディア** — 画像、音声、動画、ファイルアップロード（重複排除キャッシュ付き）
- **SILK オーディオ** — SILK ↔ WAV 変換、任意フォーマット → SILK エンコード（QQ ネイティブ音声形式）
- **TTS** — OpenAI 互換 API 経由のテキスト読み上げ、SILK 音声メッセージとして出力
- **トークン管理** — Singleflight 重複排除、バックグラウンドリフレッシュ、自動無効化
- **レート制限** — パッシブ応答リミッター（4回/メッセージ/時間）、超過時プロアクティブメッセージにフォールバック
- **Per-User キュー** — ユーザー単位で直列化、ユーザー間は並列処理
- **フレームワーク非依存** — EventEmitter ベース、Logger と SessionStore を注入するだけ

## インストール

```bash
npm install @elftia/qqbot-node
```

## クイックスタート

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

## Claw プロジェクトとの統合

この SDK は claw エコシステムの低レベル依存パッケージとして設計されています。各 claw プロジェクトは薄いアダプターを書くだけで QQ Bot に接続できます：

```
┌─────────────────────────────────────────────┐
│  OpenClaw / Elftia / YourProject             │  ← claw フレームワーク層
├─────────────────────────────────────────────┤
│  薄いアダプター（チャンネルプラグイン）         │  ← アダプター層（約200行）
├─────────────────────────────────────────────┤
│  @elftia/qqbot-node                         │  ← この SDK
└─────────────────────────────────────────────┘
```

アダプター層が行うのは3つだけ：

1. **Logger のブリッジ** — フレームワークのログシステムを SDK に注入
2. **SessionStore のブリッジ** — フレームワークのストレージを SDK に注入（WS セッション再開用）
3. **メッセージ形式のマッピング** — SDK の `GatewayMessage` ↔ フレームワークの内部メッセージ形式

```typescript
import { QQBotGateway } from '@elftia/qqbot-node';
import type { SessionStore, QQBotLogger } from '@elftia/qqbot-node';

// 1. Logger のブリッジ
const logger: QQBotLogger = {
  debug: (msg) => yourFramework.log.debug(msg),
  info:  (msg) => yourFramework.log.info(msg),
  warn:  (msg) => yourFramework.log.warn(msg),
  error: (msg) => yourFramework.log.error(msg),
};

// 2. SessionStore のブリッジ
const sessionStore: SessionStore = {
  get: (key) => yourFramework.storage.get(key),
  set: (key, value) => yourFramework.storage.set(key, value),
  delete: (key) => yourFramework.storage.delete(key),
};

// 3. 接続してメッセージを監視
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

## API リファレンス

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

### トークン管理

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

### メッセージ送信

```typescript
import {
  sendC2CMessage,
  sendGroupMessage,
  sendChannelMessage,
  sendProactiveC2CMessage,
  sendC2CInputNotify,
} from '@elftia/qqbot-node';

// パッシブ応答（受信メッセージの msg_id が必要）
await sendC2CMessage(token, openId, 'Hello!', msgId);
await sendGroupMessage(token, groupOpenId, 'Hello!', msgId);
await sendChannelMessage(token, channelId, 'Hello!', msgId);

// プロアクティブメッセージ（msg_id 不要、約4回/ユーザー/月の制限）
await sendProactiveC2CMessage(token, openId, 'Hey there!');

// 入力中インジケーター（C2C のみ）
await sendC2CInputNotify(token, openId);
```

### リッチメディア

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

### オーディオ変換

```typescript
import {
  convertSilkToWav,
  audioFileToSilkBase64,
  textToSilk,
  detectFfmpeg,
} from '@elftia/qqbot-node';

// SILK → WAV（音声認識用）
const wav = await convertSilkToWav('/path/to/voice.silk', '/output/dir');

// 任意の音声 → SILK base64（音声メッセージ送信用）
const silk = await audioFileToSilkBase64('/path/to/audio.mp3');

// TTS → SILK（テキスト読み上げを QQ 音声メッセージとして）
const result = await textToSilk('Hello world', ttsConfig, '/output/dir');

// ffmpeg 検出
const ffmpegPath = await detectFfmpeg();
```

## インターフェース

### QQBotLogger

独自のロガーを注入できます — `debug`、`info`、`warn`、`error` メソッドを持つ任意のオブジェクト。

```typescript
interface QQBotLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}
```

### SessionStore

WebSocket セッション再開用の永続化ストレージを注入できます。未指定の場合、セッションはメモリ内のみ。

```typescript
interface SessionStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
```

## Gateway の動作

### Intent 段階的ダウングレード

Bot の権限不足時に自動的に Intent をダウングレードします：

| レベル | 名称 | 対応機能 |
|--------|------|----------|
| 0 | full | C2C + グループ + ギルド + DM |
| 1 | group+channel | C2C + グループ + ギルド |
| 2 | channel-only | ギルド + ギルドメンバー |

### クローズコードの処理

| コード | アクション |
|--------|------------|
| 4004 | トークン更新、再接続 |
| 4006/4007/4009 | セッションクリア、再認証 |
| 4008 | レート制限、60秒待機 |
| 4014 | Intent 拒否、ダウングレード |
| 4914 | Bot オフライン/サンドボックス、停止 |
| 4915 | Bot BAN、停止 |

### 再接続

- 指数バックオフ: 1s → 2s → 5s → 10s → 30s → 60s
- 最大100回リトライで停止
- 高速切断検出（5秒以内に3回切断で延長バックオフ）

## 関連プロジェクト

| プロジェクト | 説明 |
|-------------|------|
| [@sliverp/qqbot](https://github.com/sliverp/qqbot) | OpenClaw の QQ Bot チャンネルプラグイン — この SDK のインスピレーション元 |
| [@elftia/channel-qqbot](https://github.com/elftia/elftia) | Elftia の QQ Bot アダプター層、この SDK を使用 |
| [OpenClaw](https://github.com/openclaw/openclaw) | AI チャットフレームワーク、この SDK の主要なユースケースの一つ |

## 前提条件

- **Node.js >= 18**（ネイティブ `fetch` のため）
- **QQ Bot 認証情報** — [QQ Open Platform](https://q.qq.com) で登録
- **silk-wasm** — 同梱、WASM サポートが必要
- **ffmpeg**（オプション）— すべてのオーディオ形式を変換可能に。未インストール時は WAV/MP3/SILK/PCM のみ対応

## ライセンス

[MIT](LICENSE)
