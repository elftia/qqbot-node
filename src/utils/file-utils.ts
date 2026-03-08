/**
 * File operation utilities — async read, size check, MIME type detection
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** QQ Bot API max upload file size: 20MB */
export const MAX_UPLOAD_SIZE = 20 * 1024 * 1024;
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024;

export function checkFileSize(filePath: string, maxSize = MAX_UPLOAD_SIZE): { ok: boolean; size: number; error?: string } {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxSize) {
      return { ok: false, size: stat.size, error: `File too large (${formatFileSize(stat.size)}), limit is ${formatFileSize(maxSize)}` };
    }
    return { ok: true, size: stat.size };
  } catch (err) {
    return { ok: false, size: 0, error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function readFileAsync(filePath: string): Promise<Buffer> {
  return fs.promises.readFile(filePath);
}

export async function fileExistsAsync(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function isLargeFile(sizeBytes: number): boolean {
  return sizeBytes >= LARGE_FILE_THRESHOLD;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export { isLocalPath } from './path-utils';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip', '.txt': 'text/plain',
};

/** Get MIME type for images only (returns null for non-image files) */
export function getImageMimeType(filePath: string): string | null {
  const mime = MIME_TYPES[path.extname(filePath).toLowerCase()];
  return mime?.startsWith('image/') ? mime : null;
}

/** Get MIME type for any supported file type */
export function getMimeType(filePath: string): string | null {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}
