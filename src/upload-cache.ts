/**
 * Upload file_info cache — avoids re-uploading identical files within TTL.
 * Cache key = md5(content) + scope(c2c/group) + targetId + fileType
 */

import * as crypto from 'node:crypto';

interface CacheEntry {
  fileInfo: string;
  fileUuid: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 500;

function buildKey(hash: string, scope: string, targetId: string, fileType: number): string {
  return `${hash}:${scope}:${targetId}:${fileType}`;
}

export function computeFileHash(data: string | Buffer): string {
  return crypto.createHash('md5').update(data).digest('hex');
}

export function getCachedFileInfo(
  contentHash: string, scope: 'c2c' | 'group', targetId: string, fileType: number,
): string | null {
  const key = buildKey(contentHash, scope, targetId, fileType);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.fileInfo;
}

export function setCachedFileInfo(
  contentHash: string, scope: 'c2c' | 'group', targetId: string, fileType: number,
  fileInfo: string, fileUuid: string, ttl: number,
): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now >= v.expiresAt) cache.delete(k);
    }
    if (cache.size >= MAX_CACHE_SIZE) {
      const keys = Array.from(cache.keys());
      for (let i = 0; i < keys.length / 2; i++) cache.delete(keys[i]!);
    }
  }

  const safetyMargin = 60;
  const effectiveTtl = Math.max(ttl - safetyMargin, 10);
  cache.set(buildKey(contentHash, scope, targetId, fileType), {
    fileInfo,
    fileUuid,
    expiresAt: Date.now() + effectiveTtl * 1000,
  });
}

export function clearUploadCache(): void {
  cache.clear();
}

export function getUploadCacheStats(): { size: number; maxSize: number } {
  return { size: cache.size, maxSize: MAX_CACHE_SIZE };
}
