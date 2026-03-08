/**
 * Message reply rate limiter
 *
 * QQ Bot API v2 limits passive replies: same message_id can be replied to
 * at most 4 times within 1 hour. After that, must fall back to proactive messages.
 */

const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1 hour

interface ReplyRecord {
  count: number;
  firstReplyAt: number;
}

const replyTracker = new Map<string, ReplyRecord>();

export interface ReplyLimitResult {
  allowed: boolean;
  remaining: number;
  shouldFallbackToProactive: boolean;
  fallbackReason?: 'expired' | 'limit_exceeded';
}

/**
 * Check whether a passive reply is allowed for this messageId.
 * Cleans up expired records when map exceeds 10k entries.
 */
export function checkReplyLimit(messageId: string): ReplyLimitResult {
  const now = Date.now();

  if (replyTracker.size > 10_000) {
    for (const [id, rec] of replyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        replyTracker.delete(id);
      }
    }
  }

  const record = replyTracker.get(messageId);

  if (!record) {
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT, shouldFallbackToProactive: false };
  }

  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    return {
      allowed: false,
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: 'expired',
    };
  }

  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  if (remaining <= 0) {
    return {
      allowed: false,
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: 'limit_exceeded',
    };
  }

  return { allowed: true, remaining, shouldFallbackToProactive: false };
}

export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  let totalReplies = 0;
  for (const rec of replyTracker.values()) {
    totalReplies += rec.count;
  }
  return { trackedMessages: replyTracker.size, totalReplies };
}

export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return { limit: MESSAGE_REPLY_LIMIT, ttlMs: MESSAGE_REPLY_TTL, ttlHours: MESSAGE_REPLY_TTL / (60 * 60 * 1000) };
}

/** Record one reply against a messageId */
export function recordReply(messageId: string): void {
  const now = Date.now();
  const record = replyTracker.get(messageId);

  if (!record) {
    replyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    replyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    record.count++;
  }
}
