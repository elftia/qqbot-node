/**
 * Image size utilities for QQ Bot markdown image format
 *
 * QQ Bot markdown requires image size hints: ![#widthpx #heightpx](url)
 * Without size hints, images may not render or render at wrong dimensions.
 *
 * Supports PNG, JPEG, GIF, WebP — parses from binary headers (no dependencies).
 */

import { Buffer } from 'node:buffer';

export interface ImageSize {
  width: number;
  height: number;
}

/** Default image size when actual dimensions cannot be determined */
export const DEFAULT_IMAGE_SIZE: ImageSize = { width: 512, height: 512 };

// ── Binary header parsers ────────────────────────────────────

function parsePngSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseJpegSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) { offset++; continue; }

    const marker = buffer[offset + 1]!;
    if (marker === 0xc0 || marker === 0xc2) {
      if (offset + 9 <= buffer.length) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
    }
    if (offset + 3 < buffer.length) {
      offset += 2 + buffer.readUInt16BE(offset + 2);
    } else {
      break;
    }
  }
  return null;
}

function parseGifSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 10) return null;
  const sig = buffer.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function parseWebpSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const chunk = buffer.toString('ascii', 12, 16);

  if (chunk === 'VP8 ' && buffer.length >= 30
    && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      width: (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16)) + 1,
      height: (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16)) + 1,
    };
  }
  return null;
}

/** Parse image dimensions from a binary buffer (PNG/JPEG/GIF/WebP) */
export function parseImageSize(buffer: Buffer): ImageSize | null {
  return parsePngSize(buffer) ?? parseJpegSize(buffer) ?? parseGifSize(buffer) ?? parseWebpSize(buffer);
}

// ── Size fetchers ────────────────────────────────────────────

/** Fetch image size from a URL by downloading only the first 64KB */
export async function getImageSizeFromUrl(url: string, timeoutMs = 5000): Promise<ImageSize | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Range: 'bytes=0-65535' },
    });
    clearTimeout(timeoutId);

    if (!response.ok && response.status !== 206) return null;

    const buf = Buffer.from(await response.arrayBuffer());
    return parseImageSize(buf);
  } catch {
    return null;
  }
}

/** Parse image size from a base64 data URL */
export function getImageSizeFromDataUrl(dataUrl: string): ImageSize | null {
  const m = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
  if (!m) return null;
  try {
    return parseImageSize(Buffer.from(m[1]!, 'base64'));
  } catch {
    return null;
  }
}

/** Get image size from any source (HTTP URL or data URL) */
export async function getImageSize(source: string): Promise<ImageSize | null> {
  if (source.startsWith('data:')) return getImageSizeFromDataUrl(source);
  if (source.startsWith('http://') || source.startsWith('https://')) return getImageSizeFromUrl(source);
  return null;
}

// ── QQ Bot markdown format helpers ───────────────────────────

/** Format a URL as QQ Bot markdown image: ![#widthpx #heightpx](url) */
export function formatQQBotMarkdownImage(url: string, size: ImageSize | null): string {
  const { width, height } = size ?? DEFAULT_IMAGE_SIZE;
  return `![#${width}px #${height}px](${url})`;
}

/** Check if a markdown image already has QQ Bot size hints */
export function hasQQBotImageSize(markdownImage: string): boolean {
  return /!\[#\d+px\s+#\d+px\]/.test(markdownImage);
}
