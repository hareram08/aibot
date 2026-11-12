"use strict";

/**
 * POST /api/chat  — Vercel serverless function (Node.js, no dependencies).
 *
 * Request:  { "messages": [ { "role": "user" | "assistant", "content": "..." }, ... ] }
 * Response: { "reply": "..." }  or  { "error": "...", "code": "..." }
 *
 * The OpenAI key is read from the OPENAI_API_KEY environment variable and
 * never leaves the server.
 */

const knowledgeBase = require("./_lib/knowledge.json");
const { buildSystemPrompt } = require("./_lib/prompt");
const { createLimiter } = require("./_lib/rate-limit");
const { validateMessages, MAX_MESSAGE_CHARS } = require("./_lib/validate");

const MAX_BODY_BYTES = 32 * 1024;
const MAX_REPLY_TOKENS = 700;
const UPSTREAM_TIMEOUT_MS = 20000;

const SYSTEM_PROMPT = buildSystemPrompt(knowledgeBase);

function intEnv(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const checkRate = createLimiter({
  windowMs: 60 * 1000,
  max: intEnv("CHAT_RATE_LIMIT_PER_MINUTE", 8),
  dailyMax: intEnv("CHAT_RATE_LIMIT_PER_DAY", 80),
});

function send(res, status, payload, headers) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (headers) Object.keys(headers).forEach((key) => res.setHeader(key, headers[key]));
  res.end(JSON.stringify(payload));
}

function fail(res, status, code, message, headers) {
  send(res, status, { error: message, code: code }, headers);
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "unknown";
}

/** Same-origin requests are always allowed; other origins only if listed in ALLOWED_ORIGINS. */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client; still rate limited
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch (error) {
    return false;
  }
  if (originHost === req.headers.host) return true;
  const extra = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return extra.indexOf(origin) !== -1;
}

function readBody(req) {
  // Vercel parses JSON bodies for us; the local dev server and tests do not.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return Promise.resolve(JSON.parse(req.body));
    if (Buffer.isBuffer(req.body)) return Promise.resolve(JSON.parse(req.body.toString("utf8")));
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return; // keep draining so the 413 response can be delivered
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error("too large"), { tooLarge: true }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function askOpenAI(messages) {
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        messages: [{ role: "system", content: SYSTEM_PROMPT }].concat(messages),
        max_completion_tokens: MAX_REPLY_TOKENS,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch (error) {
        /* ignore */
      }
      // Logged on the server only; never returned to the browser.
      console.error("[chat] OpenAI error", response.status, detail);
      return { upstreamStatus: response.status };
    }

    const data = await response.json();
    const choice = data && data.choices && data.choices[0];
    const reply = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content.trim() : "";
    return { reply: reply };
  } finally {
    clearTimeout(timer);
  }
}

async function handler(req, res) {
  if (!originAllowed(req)) return fail(res, 403, "forbidden_origin", "This chat can only be used from the portfolio website.");

  const origin = req.headers.origin;
  if (origin) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === req.headers.host;
    } catch (error) {
      sameHost = false;
    }
    if (!sameHost) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return fail(res, 405, "method_not_allowed", "Use POST.", { Allow: "POST, OPTIONS" });
  }
  if (String(req.headers["content-type"] || "").toLowerCase().indexOf("application/json") !== 0) {
    return fail(res, 415, "unsupported_media_type", "Send JSON.");
  }

  const limit = checkRate(clientIp(req));
  if (!limit.ok) {
    const message =
      limit.scope === "day"
        ? "You have reached today's message limit. Please contact Hare Ram directly using the contact section."
        : "You are sending messages too quickly. Please wait a moment and try again.";
    return fail(res, 429, "rate_limited", message, { "Retry-After": String(limit.retryAfter) });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    if (error && error.tooLarge) return fail(res, 413, "too_large", "Request is too large.");
    return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
  }

  const result = validateMessages(body);
  if (result.error) return fail(res, 400, "invalid_request", result.error);

  if (!process.env.OPENAI_API_KEY) {
    console.error("[chat] OPENAI_API_KEY is not set.");
    return fail(res, 503, "not_configured", "The assistant is not available right now. Please use the contact section to reach Hare Ram.");
  }

  try {
    const answer = await askOpenAI(result.messages);
    if (answer.upstreamStatus) {
      const busy = answer.upstreamStatus === 429 || answer.upstreamStatus >= 500;
      return fail(
        res,
        busy ? 503 : 502,
        busy ? "assistant_busy" : "assistant_error",
        busy
          ? "The assistant is busy right now. Please try again in a minute."
          : "The assistant is not available right now. Please use the contact section to reach Hare Ram."
      );
    }
    if (!answer.reply) {
      return fail(res, 502, "empty_reply", "The assistant could not produce an answer. Please try rephrasing your question.");
    }
    return send(res, 200, { reply: answer.reply });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    console.error("[chat] request failed:", timedOut ? "timeout" : error && error.message);
    return fail(
      res,
      timedOut ? 504 : 502,
      timedOut ? "timeout" : "assistant_error",
      timedOut ? "The assistant took too long to respond. Please try again." : "Something went wrong. Please try again."
    );
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 30 };
module.exports._internal = { validateMessages, originAllowed, MAX_MESSAGE_CHARS };
