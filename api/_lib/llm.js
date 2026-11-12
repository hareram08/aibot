"use strict";

/**
 * Provider-agnostic call to the LLM backend. Supports OpenAI and Gemini;
 * picks whichever API key is present (Gemini first, since that's the
 * currently configured provider). Shared between the Vercel function
 * (api/chat.js) and the Cloudflare Worker (inlined by cloudflare/build.js).
 */

const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

function pickProvider(env) {
  if (env.GEMINI_API_KEY) return "gemini";
  if (env.OPENAI_API_KEY) return "openai";
  return null;
}

async function askOpenAI(messages, env, systemPrompt, maxTokens, timeoutMs) {
  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
        messages: [{ role: "system", content: systemPrompt }].concat(messages),
        max_completion_tokens: maxTokens,
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
      console.error("[chat] OpenAI error", response.status, detail); // server log only
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

// Gemini uses "user" / "model" roles (not "assistant"), and takes the system
// prompt as a separate field rather than a message in the array.
function toGeminiContents(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: String(message.content || "") }],
  }));
}

async function askGemini(messages, env, systemPrompt, maxTokens, timeoutMs) {
  const baseUrl = (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl + "/models/" + model + ":generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: toGeminiContents(messages),
        generationConfig: { maxOutputTokens: maxTokens },
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
      console.error("[chat] Gemini error", response.status, detail); // server log only
      return { upstreamStatus: response.status };
    }
    const data = await response.json();
    const candidate = data && data.candidates && data.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    const reply = Array.isArray(parts)
      ? parts
          .map((part) => (part && typeof part.text === "string" ? part.text : ""))
          .join("")
          .trim()
      : "";
    if (!reply && candidate && candidate.finishReason) {
      // e.g. "SAFETY" (blocked by Gemini's safety filters) or "MAX_TOKENS".
      console.error("[chat] Gemini finishReason", candidate.finishReason);
    }
    return { reply: reply };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * messages: [{ role: "user" | "assistant", content: string }, ...]
 * env: object with OPENAI_API_KEY/OPENAI_MODEL/OPENAI_BASE_URL and/or
 *      GEMINI_API_KEY/GEMINI_MODEL/GEMINI_BASE_URL.
 * options: { systemPrompt, maxTokens, timeoutMs }
 * Returns { reply } on success, or { upstreamStatus } on a provider error.
 */
async function askAssistant(messages, env, options) {
  const provider = pickProvider(env);
  if (provider === "gemini") return askGemini(messages, env, options.systemPrompt, options.maxTokens, options.timeoutMs);
  if (provider === "openai") return askOpenAI(messages, env, options.systemPrompt, options.maxTokens, options.timeoutMs);
  return { notConfigured: true };
}

module.exports = { askAssistant, pickProvider };
