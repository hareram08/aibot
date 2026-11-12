"use strict";

/**
 * Gemini-provider tests. Run with:  node --test tests/gemini.test.js
 *
 * Uses a local fake Gemini server, so no API key or internet is needed and
 * nothing is billed. Mirrors tests/api.test.js but for the GEMINI_API_KEY
 * path (used instead of OpenAI when GEMINI_API_KEY is set).
 */

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");

let upstream; // fake Gemini
let upstreamMode = "ok";
let lastUpstreamRequest = null;
let app;
let baseUrl;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function post(body, headers) {
  return fetch(baseUrl + "/api/chat", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const user = (content) => ({ role: "user", content });

test.before(async () => {
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      lastUpstreamRequest = { url: req.url, headers: req.headers, body: JSON.parse(raw || "{}") };
      if (upstreamMode === "429") {
        res.statusCode = 429;
        return res.end(JSON.stringify({ error: { message: "secret upstream detail AIza-should-not-leak" } }));
      }
      if (upstreamMode === "403") {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: { message: "API key not valid: AIza-should-not-leak" } }));
      }
      if (upstreamMode === "empty") {
        return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "MAX_TOKENS" }] }));
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Mock answer about Hare Ram." }] }, finishReason: "STOP" }],
        })
      );
    });
  });
  const upstreamPort = await listen(upstream);

  delete process.env.OPENAI_API_KEY;
  process.env.GEMINI_API_KEY = "AIza-test-key-123";
  process.env.GEMINI_BASE_URL = "http://127.0.0.1:" + upstreamPort + "/v1beta";
  process.env.CHAT_RATE_LIMIT_PER_MINUTE = "1000";
  process.env.CHAT_RATE_LIMIT_PER_DAY = "100000";

  const handler = require(path.join(__dirname, "..", "api", "chat.js"));
  app = http.createServer((req, res) => handler(req, res));
  baseUrl = "http://127.0.0.1:" + (await listen(app));
});

test.after(() => {
  upstream.close();
  app.close();
});

test("picks Gemini when GEMINI_API_KEY is set, and never leaks the key", async () => {
  upstreamMode = "ok";
  const response = await post({ messages: [user("Who is Hare Ram?")] });
  assert.strictEqual(response.status, 200);
  const text = await response.text();
  assert.deepStrictEqual(JSON.parse(text), { reply: "Mock answer about Hare Ram." });
  assert.ok(!text.includes("AIza-test-key-123"));
  assert.match(lastUpstreamRequest.url, /^\/v1beta\/models\/gemini-2\.5-flash:generateContent\?key=AIza-test-key-123$/);
});

test("sends the system prompt separately and maps assistant turns to the model role", async () => {
  await post({
    messages: [user("What projects has he completed?"), { role: "assistant", content: "Several." }, user("Tell me more about the first one")],
  });
  const sent = lastUpstreamRequest.body;
  assert.match(sent.systemInstruction.parts[0].text, /Never invent/);
  assert.match(sent.systemInstruction.parts[0].text, /Patna University/);
  assert.deepStrictEqual(
    sent.contents.map((c) => c.role),
    ["user", "model", "user"]
  );
  assert.strictEqual(sent.contents[1].parts[0].text, "Several.");
});

test("hides upstream error details from the visitor", async () => {
  for (const mode of ["429", "403"]) {
    upstreamMode = mode;
    const response = await post({ messages: [user("hi")] });
    const text = await response.text();
    assert.strictEqual(response.status, mode === "429" ? 503 : 502);
    assert.ok(!text.includes("AIza-"), "no key material in the response");
    assert.ok(!text.includes("upstream detail"));
    assert.ok(JSON.parse(text).error.length > 10);
  }
  upstreamMode = "empty";
  assert.strictEqual((await post({ messages: [user("hi")] })).status, 502);
  upstreamMode = "ok";
});

test("reports a friendly error when no provider key is set", async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const response = await post({ messages: [user("hi")] });
  process.env.GEMINI_API_KEY = saved;
  assert.strictEqual(response.status, 503);
  assert.strictEqual((await response.json()).code, "not_configured");
});

test("Gemini takes priority when both GEMINI_API_KEY and OPENAI_API_KEY are set", () => {
  const { pickProvider } = require("../api/_lib/llm");
  assert.strictEqual(pickProvider({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" }), "gemini");
  assert.strictEqual(pickProvider({ OPENAI_API_KEY: "o" }), "openai");
  assert.strictEqual(pickProvider({}), null);
});
