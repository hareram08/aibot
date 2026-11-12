"use strict";

/**
 * Request validation shared by the Vercel function (api/chat.js) and the
 * Cloudflare Worker (cloudflare/build.js inlines this file).
 */

const MAX_MESSAGE_CHARS = 500; // per visitor message
const MAX_ASSISTANT_CHARS = 2500; // earlier assistant turns are trimmed to this
const MAX_HISTORY = 12; // messages sent to the model
const MAX_MESSAGES_IN_REQUEST = 40;

function cleanText(value) {
  // Strip control characters (keep tab and newline) and trim.
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

/** Returns { messages } or { error }. */
function validateMessages(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    return { error: "Request must include a messages array." };
  }
  if (body.messages.length === 0) return { error: "Please enter a message." };
  if (body.messages.length > MAX_MESSAGES_IN_REQUEST) {
    return { error: "This conversation is too long. Please clear the chat and start again." };
  }

  const cleaned = [];
  for (const item of body.messages) {
    if (!item || typeof item !== "object" || typeof item.content !== "string") {
      return { error: "Each message needs a role and text content." };
    }
    if (item.role !== "user" && item.role !== "assistant") {
      return { error: "Invalid message role." };
    }
    let content = cleanText(item.content);
    if (!content) continue;
    if (item.role === "user" && content.length > MAX_MESSAGE_CHARS) {
      return { error: "Messages are limited to " + MAX_MESSAGE_CHARS + " characters. Please shorten your question." };
    }
    if (item.role === "assistant") content = content.slice(0, MAX_ASSISTANT_CHARS);
    cleaned.push({ role: item.role, content: content });
  }

  let recent = cleaned.slice(-MAX_HISTORY);
  while (recent.length && recent[0].role !== "user") recent = recent.slice(1);
  if (!recent.length || recent[recent.length - 1].role !== "user") {
    return { error: "Please enter a message." };
  }
  return { messages: recent };
}

module.exports = { validateMessages, MAX_MESSAGE_CHARS };
