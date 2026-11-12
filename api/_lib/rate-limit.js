"use strict";

/**
 * Basic in-memory rate limiter (fixed window per minute + per day).
 *
 * Serverless caveat: memory is per function instance and is lost on cold
 * start, so this slows casual abuse but is not a hard guarantee. The hard
 * backstop is a monthly spend limit on the OpenAI account.
 */
function createLimiter(options) {
  const windowMs = options.windowMs;
  const max = options.max;
  const dailyMax = options.dailyMax;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_KEYS = 5000;
  const store = new Map();

  function prune(now) {
    for (const [key, entry] of store) {
      if (now - entry.dayStart >= DAY_MS) store.delete(key);
    }
    // Still too big (many distinct clients): drop the oldest entries.
    while (store.size > MAX_KEYS) store.delete(store.keys().next().value);
  }

  return function check(key, now) {
    now = now || Date.now();
    if (store.size > MAX_KEYS) prune(now);

    let entry = store.get(key);
    if (!entry) {
      entry = { windowStart: now, count: 0, dayStart: now, dayCount: 0 };
      store.set(key, entry);
    }
    if (now - entry.windowStart >= windowMs) {
      entry.windowStart = now;
      entry.count = 0;
    }
    if (now - entry.dayStart >= DAY_MS) {
      entry.dayStart = now;
      entry.dayCount = 0;
    }

    if (entry.dayCount >= dailyMax) {
      return { ok: false, scope: "day", retryAfter: Math.ceil((entry.dayStart + DAY_MS - now) / 1000) };
    }
    if (entry.count >= max) {
      return { ok: false, scope: "minute", retryAfter: Math.ceil((entry.windowStart + windowMs - now) / 1000) };
    }

    entry.count += 1;
    entry.dayCount += 1;
    return { ok: true };
  };
}

module.exports = { createLimiter };
