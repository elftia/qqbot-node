/**
 * Path utilities — tilde expansion, filename sanitization, local path detection
 */

import * as os from 'node:os';
import * as path from 'node:path';

function getHomeDir(): string {
  try {
    return os.homedir();
  } catch {
    return process.env.HOME ?? process.env.USERPROFILE ?? os.tmpdir();
  }
}

/** Expand ~ to home directory */
export function expandTilde(p: string): string {
  if (!p) return p;
  if (p === '~') return getHomeDir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(getHomeDir(), p.slice(2));
  }
  return p;
}

/** Expand tilde + trim */
export function normalizePath(p: string): string {
  return expandTilde(p.trim());
}

/**
 * Sanitize filename for QQ Bot API:
 * - URI decode percent-encoded names
 * - Unicode NFC normalization (macOS NFD → NFC)
 * - Strip ASCII control characters
 */
export function sanitizeFileName(name: string): string {
  if (!name) return name;
  let result = name.trim();

  if (result.includes('%')) {
    try { result = decodeURIComponent(result); } catch { /* keep original */ }
  }

  result = result.normalize('NFC');
  result = result.replace(/[\x00-\x1F\x7F]/g, '');
  return result;
}

/** Comprehensive local path detection (non-URL) */
export function isLocalPath(p: string): boolean {
  if (!p) return false;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return true;
  if (p.startsWith('/')) return true;
  if (/^[a-zA-Z]:[/\\]/.test(p)) return true;
  if (p.startsWith('\\\\')) return true;
  if (p.startsWith('./') || p.startsWith('../') || p.startsWith('.\\') || p.startsWith('..\\')) return true;
  return false;
}

/** Loose heuristic: might be a local path (for extracting from markdown) */
export function looksLikeLocalPath(p: string): boolean {
  if (isLocalPath(p)) return true;
  if (/\.(png|jpg|jpeg|gif|webp|bmp|mp3|wav|mp4|mov|pdf|doc|docx)$/i.test(p)) return true;
  return false;
}
