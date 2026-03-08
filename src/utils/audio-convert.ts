/**
 * Audio format conversion — SILK ↔ WAV, audio file → SILK Base64
 *
 * SILK is QQ's native voice format. This module handles:
 * - SILK → WAV decoding (for STT)
 * - Any audio → SILK encoding (for sending voice messages)
 * - MP3 decoding via WASM fallback when ffmpeg is unavailable
 * - ffmpeg detection with FFMPEG_PATH env var support and result caching
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

// ── silk-wasm availability check ────────────────────────────

let _silkAvailable: boolean | null = null;

export function checkSilkWasmAvailable(): boolean {
  if (_silkAvailable !== null) return _silkAvailable;
  try {
    require('silk-wasm');
    _silkAvailable = true;
  } catch {
    _silkAvailable = false;
  }
  return _silkAvailable;
}

function isSilkFile(buf: Buffer): boolean {
  if (!checkSilkWasmAvailable()) return false;
  try {
    const { isSilk } = require('silk-wasm');
    return isSilk(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } catch {
    return false;
  }
}

function stripAmrHeader(buf: Buffer): Buffer {
  const AMR_HEADER = Buffer.from('#!AMR\n');
  if (buf.length > 6 && buf.subarray(0, 6).equals(AMR_HEADER)) {
    return buf.subarray(6);
  }
  return buf;
}

function pcmToWav(pcmData: Uint8Array, sampleRate: number): Buffer {
  const dataSize = pcmData.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength).copy(buffer, 44);
  return buffer;
}

/**
 * Convert SILK/AMR voice file to WAV format
 * @returns WAV file path and duration, or null on failure
 */
export async function convertSilkToWav(
  inputPath: string,
  outputDir?: string,
): Promise<{ wavPath: string; duration: number } | null> {
  if (!fs.existsSync(inputPath)) return null;

  const fileBuf = fs.readFileSync(inputPath);
  const strippedBuf = stripAmrHeader(fileBuf);
  const rawData = new Uint8Array(strippedBuf.buffer, strippedBuf.byteOffset, strippedBuf.byteLength);

  try {
    const { isSilk, decode } = require('silk-wasm');
    if (!isSilk(rawData)) return null;

    const sampleRate = 24000;
    const result = await decode(rawData, sampleRate);
    const wavBuffer = pcmToWav(result.data, sampleRate);

    const dir = outputDir || path.dirname(inputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const wavPath = path.join(dir, `${baseName}.wav`);
    fs.writeFileSync(wavPath, wavBuffer);

    return { wavPath, duration: result.duration };
  } catch {
    return null;
  }
}

export function isVoiceAttachment(att: { content_type?: string; filename?: string }): boolean {
  if (att.content_type === 'voice' || att.content_type?.startsWith('audio/')) return true;
  const ext = att.filename ? path.extname(att.filename).toLowerCase() : '';
  return ['.amr', '.silk', '.slk', '.slac'].includes(ext);
}

export function isAudioFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.silk', '.slk', '.amr', '.wav', '.mp3', '.ogg', '.opus', '.aac', '.flac', '.m4a', '.wma', '.pcm'].includes(ext);
}

// ── ffmpeg detection with caching ───────────────────────────

let _ffmpegPath: string | null | undefined;
let _ffmpegCheckPromise: Promise<string | null> | null = null;

/**
 * Detect ffmpeg with priority:
 * 1. FFMPEG_PATH environment variable
 * 2. System PATH
 * 3. Common installation paths
 */
export async function detectFfmpeg(): Promise<string | null> {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  if (_ffmpegCheckPromise) return _ffmpegCheckPromise;

  _ffmpegCheckPromise = (async () => {
    const envPath = process.env.FFMPEG_PATH;
    if (envPath) {
      if (await testFfmpeg(envPath)) {
        _ffmpegPath = envPath;
        return envPath;
      }
    }

    const candidates = process.platform === 'win32'
      ? ['ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
         'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe']
      : ['ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg',
         '/snap/bin/ffmpeg', '/usr/local/opt/ffmpeg/bin/ffmpeg'];

    for (const cmd of candidates) {
      if (cmd.includes('/') || cmd.includes('\\')) {
        if (!fs.existsSync(cmd)) continue;
      }
      if (await testFfmpeg(cmd)) {
        _ffmpegPath = cmd;
        return cmd;
      }
    }

    _ffmpegPath = null;
    return null;
  })();

  const result = await _ffmpegCheckPromise;
  _ffmpegCheckPromise = null;
  return result;
}

async function testFfmpeg(cmd: string): Promise<boolean> {
  try {
    return await new Promise<boolean>(resolve => {
      execFile(cmd, ['-version'], { timeout: 5000 }, err => resolve(!err));
    });
  } catch {
    return false;
  }
}

export function ffmpegToPCM(ffmpegCmd: string, inputPath: string, sampleRate = 24000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegCmd, [
      '-i', inputPath, '-f', 's16le', '-ar', String(sampleRate),
      '-ac', '1', '-acodec', 'pcm_s16le', '-v', 'error', 'pipe:1',
    ], {
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'buffer',
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    }, (err, stdout) => {
      if (err) reject(new Error(`ffmpeg failed: ${err.message}`));
      else resolve(stdout as unknown as Buffer);
    });
  });
}

// ── Linear interpolation resampler ──────────────────────────

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.ceil(input.length / ratio);
  const output = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const floor = Math.floor(srcIdx);
    const frac = srcIdx - floor;
    const a = input[floor] ?? 0;
    const b = input[Math.min(floor + 1, input.length - 1)] ?? 0;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

/** QQ Bot API natively supported upload formats (no conversion needed) */
const QQ_NATIVE_UPLOAD_FORMATS = ['.wav', '.mp3', '.silk'];

/**
 * Parse WAV header to extract PCM data without ffmpeg.
 */
function parseWavFallback(buf: Buffer): { pcm: Buffer; sampleRate: number; channels: number } | null {
  if (buf.length < 44) return null;
  const riff = buf.toString('ascii', 0, 4);
  const wave = buf.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || wave !== 'WAVE') return null;

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) return null;
      const audioFormat = buf.readUInt16LE(offset + 8);
      if (audioFormat !== 1) return null;
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize;
  }

  if (!sampleRate || !dataOffset || !dataSize) return null;
  if (bitsPerSample !== 16) return null;

  const pcm = buf.subarray(dataOffset, dataOffset + dataSize);

  if (channels > 1) {
    const monoSamples = Math.floor(pcm.length / (2 * channels));
    const mono = Buffer.alloc(monoSamples * 2);
    for (let i = 0; i < monoSamples; i++) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch++) {
        sum += pcm.readInt16LE((i * channels + ch) * 2);
      }
      mono.writeInt16LE(Math.round(sum / channels), i * 2);
    }
    return { pcm: mono, sampleRate, channels: 1 };
  }

  return { pcm: Buffer.from(pcm), sampleRate, channels };
}

/**
 * Convert any audio file to SILK Base64 for QQ Bot API upload.
 *
 * Strategy:
 * 1. WAV/MP3/SILK → direct upload (QQ native formats)
 * 2. ffmpeg available → decode to PCM → silk-wasm encode
 * 3. No ffmpeg → WASM fallback (PCM, WAV, MP3 only)
 */
export async function audioFileToSilkBase64(
  filePath: string,
  directUploadFormats: string[] = QQ_NATIVE_UPLOAD_FORMATS,
): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;

  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) return null;

  const ext = path.extname(filePath).toLowerCase();

  if (directUploadFormats.map(f => f.toLowerCase()).includes(ext)) {
    return buf.toString('base64');
  }

  const stripped = stripAmrHeader(buf);
  if (isSilkFile(stripped)) {
    return buf.toString('base64');
  }

  const targetRate = 24000;

  const ffmpegCmd = await detectFfmpeg();
  if (ffmpegCmd) {
    try {
      const pcmBuf = await ffmpegToPCM(ffmpegCmd, filePath, targetRate);
      if (pcmBuf.length === 0) return null;
      const { encode } = require('silk-wasm');
      const result = await encode(new Uint8Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength), targetRate);
      return Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength).toString('base64');
    } catch {
      // fall through to WASM fallback
    }
  }

  if (ext === '.pcm') {
    try {
      const { encode } = require('silk-wasm');
      const result = await encode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), targetRate);
      return Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength).toString('base64');
    } catch {
      return null;
    }
  }

  if (ext === '.mp3') {
    try {
      const { MPEGDecoder } = require('mpg123-decoder');
      const decoder = new MPEGDecoder();
      await decoder.ready;
      const decoded = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      decoder.free();
      if (decoded.samplesDecoded === 0) return null;

      let floatMono: Float32Array;
      if (decoded.channelData.length === 1) {
        floatMono = decoded.channelData[0];
      } else {
        floatMono = new Float32Array(decoded.samplesDecoded);
        const chCount = decoded.channelData.length;
        for (let i = 0; i < decoded.samplesDecoded; i++) {
          let sum = 0;
          for (let ch = 0; ch < chCount; ch++) sum += decoded.channelData[ch][i];
          floatMono[i] = sum / chCount;
        }
      }

      const resampled = resampleLinear(floatMono, decoded.sampleRate, targetRate);
      const s16 = new Uint8Array(resampled.length * 2);
      const view = new DataView(s16.buffer);
      for (let i = 0; i < resampled.length; i++) {
        const val = Math.max(-1, Math.min(1, resampled[i])) * (resampled[i] < 0 ? 32768 : 32767);
        view.setInt16(i * 2, Math.round(val), true);
      }

      const { encode } = require('silk-wasm');
      const result = await encode(s16, targetRate);
      return Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength).toString('base64');
    } catch {
      return null;
    }
  }

  if (ext === '.wav') {
    try {
      const wavData = parseWavFallback(buf);
      if (wavData) {
        let pcmBuf = wavData.pcm;
        if (wavData.sampleRate !== targetRate) {
          const samples = new Float32Array(pcmBuf.length / 2);
          for (let i = 0; i < samples.length; i++) {
            samples[i] = pcmBuf.readInt16LE(i * 2) / 32768;
          }
          const resampled = resampleLinear(samples, wavData.sampleRate, targetRate);
          pcmBuf = Buffer.alloc(resampled.length * 2);
          for (let i = 0; i < resampled.length; i++) {
            const val = Math.max(-1, Math.min(1, resampled[i])) * (resampled[i] < 0 ? 32768 : 32767);
            pcmBuf.writeInt16LE(Math.round(val), i * 2);
          }
        }
        const { encode } = require('silk-wasm');
        const result = await encode(new Uint8Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength), targetRate);
        return Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength).toString('base64');
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return remainSeconds > 0 ? `${minutes}m${remainSeconds}s` : `${minutes}m`;
}

// ── TTS (Text-to-Speech) ────────────────────────────────────

export interface TTSConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  authStyle?: 'bearer' | 'api-key';
  queryParams?: Record<string, string>;
  speed?: number;
}

function buildTTSRequest(ttsCfg: TTSConfig): { url: string; headers: Record<string, string> } {
  let url = `${ttsCfg.baseUrl}/audio/speech`;
  if (ttsCfg.queryParams && Object.keys(ttsCfg.queryParams).length > 0) {
    const qs = new URLSearchParams(ttsCfg.queryParams).toString();
    url += `?${qs}`;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ttsCfg.authStyle === 'api-key') {
    headers['api-key'] = ttsCfg.apiKey;
  } else {
    headers['Authorization'] = `Bearer ${ttsCfg.apiKey}`;
  }

  return { url, headers };
}

async function wasmDecodeMp3ToPCM(mp3Buffer: Buffer, targetRate: number): Promise<Buffer | null> {
  try {
    const { MPEGDecoder } = require('mpg123-decoder');
    const decoder = new MPEGDecoder();
    await decoder.ready;
    const decoded = decoder.decode(new Uint8Array(mp3Buffer.buffer, mp3Buffer.byteOffset, mp3Buffer.byteLength));
    decoder.free();
    if (decoded.samplesDecoded === 0) return null;

    let floatMono: Float32Array;
    if (decoded.channelData.length === 1) {
      floatMono = decoded.channelData[0];
    } else {
      floatMono = new Float32Array(decoded.samplesDecoded);
      const chCount = decoded.channelData.length;
      for (let i = 0; i < decoded.samplesDecoded; i++) {
        let sum = 0;
        for (let ch = 0; ch < chCount; ch++) sum += decoded.channelData[ch][i];
        floatMono[i] = sum / chCount;
      }
    }

    const resampled = resampleLinear(floatMono, decoded.sampleRate, targetRate);
    const s16 = new Uint8Array(resampled.length * 2);
    const view = new DataView(s16.buffer);
    for (let i = 0; i < resampled.length; i++) {
      const val = Math.max(-1, Math.min(1, resampled[i])) * (resampled[i] < 0 ? 32768 : 32767);
      view.setInt16(i * 2, Math.round(val), true);
    }
    return Buffer.from(s16.buffer);
  } catch {
    return null;
  }
}

export async function textToSpeechPCM(
  text: string,
  ttsCfg: TTSConfig,
): Promise<{ pcmBuffer: Buffer; sampleRate: number }> {
  const sampleRate = 24000;
  const { url, headers } = buildTTSRequest(ttsCfg);

  const formats: Array<{ format: string; needsDecode: boolean }> = [
    { format: 'pcm', needsDecode: false },
    { format: 'mp3', needsDecode: true },
  ];

  let lastError: Error | null = null;

  for (const { format, needsDecode } of formats) {
    const controller = new AbortController();
    const ttsTimeout = setTimeout(() => controller.abort(), 120000);

    try {
      const body: Record<string, unknown> = {
        model: ttsCfg.model,
        input: text,
        voice: ttsCfg.voice,
        response_format: format,
        ...(format === 'pcm' ? { sample_rate: sampleRate } : {}),
        ...(ttsCfg.speed !== undefined ? { speed: ttsCfg.speed } : {}),
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(ttsTimeout));

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        if (format === 'pcm' && (resp.status === 400 || resp.status === 422)) {
          lastError = new Error(`TTS PCM not supported: ${detail.slice(0, 200)}`);
          continue;
        }
        throw new Error(`TTS failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
      }

      const arrayBuffer = await resp.arrayBuffer();
      const rawBuffer = Buffer.from(arrayBuffer);

      if (!needsDecode) {
        return { pcmBuffer: rawBuffer, sampleRate };
      }

      const os = require('node:os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
      const tmpMp3 = path.join(tmpDir, 'tts.mp3');
      fs.writeFileSync(tmpMp3, rawBuffer);

      try {
        const ffmpegCmd = await detectFfmpeg();
        if (ffmpegCmd) {
          const pcmBuf = await ffmpegToPCM(ffmpegCmd, tmpMp3, sampleRate);
          return { pcmBuffer: pcmBuf, sampleRate };
        }
        const pcmBuf = await wasmDecodeMp3ToPCM(rawBuffer, sampleRate);
        if (pcmBuf) return { pcmBuffer: pcmBuf, sampleRate };
        throw new Error('No decoder available for mp3 (install ffmpeg for best compatibility)');
      } finally {
        try { fs.unlinkSync(tmpMp3); fs.rmdirSync(tmpDir); } catch { /* cleanup */ }
      }
    } catch (err) {
      clearTimeout(ttsTimeout);
      lastError = err instanceof Error ? err : new Error(String(err));
      if (format === 'pcm') continue;
      throw lastError;
    }
  }

  throw lastError ?? new Error('TTS failed: all formats exhausted');
}

export async function pcmToSilk(
  pcmBuffer: Buffer,
  sampleRate: number,
): Promise<{ silkBuffer: Buffer; duration: number }> {
  const { encode } = require('silk-wasm');
  const pcmData = new Uint8Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
  const result = await encode(pcmData, sampleRate);
  return {
    silkBuffer: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength),
    duration: result.duration,
  };
}

export async function textToSilk(
  text: string,
  ttsCfg: TTSConfig,
  outputDir: string,
): Promise<{ silkPath: string; silkBase64: string; duration: number }> {
  const { pcmBuffer, sampleRate } = await textToSpeechPCM(text, ttsCfg);
  const { silkBuffer, duration } = await pcmToSilk(pcmBuffer, sampleRate);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const silkPath = path.join(outputDir, `tts-${Date.now()}.silk`);
  fs.writeFileSync(silkPath, silkBuffer);

  return { silkPath, silkBase64: silkBuffer.toString('base64'), duration };
}

/**
 * Wait for a file to appear and stabilize (e.g., after TTS generation).
 * @returns file size in bytes, or 0 on timeout
 */
export async function waitForFile(filePath: string, timeoutMs = 120_000, pollMs = 500): Promise<number> {
  const start = Date.now();
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) {
        if (stat.size === lastSize) {
          stableCount++;
          if (stableCount >= 2) return stat.size;
        } else {
          stableCount = 0;
        }
        lastSize = stat.size;
      }
    } catch {
      // file may not exist yet
    }
    await new Promise(r => setTimeout(r, pollMs));
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 0) return stat.size;
  } catch {
    // ignore
  }
  return 0;
}
