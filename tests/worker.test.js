"use strict";

/**
 * Cloudflare Worker tests. Run with:
 *   node cloudflare/build.js && node --test tests/worker.test.js
 * Uses a local fake OpenAI server; no key or internet needed.
 */

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");
const { pathToFileURL } = require("url");

const SITE = "https://hareram.website";
const SELF = "https://assistant.example.workers.dev";
let worker;
let upstream;
let upstreamMode = "ok";
let lastUpstream = null;
let env;

const user = (content) => ({ role: "user", content });

function chat(body, headers, extraEnv) {
  const request = new Request(SELF + "/api/chat", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.5" }, headers || {}),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return worker.fetch(request, Object.assign({}, env, extraEnv || {}));
}

test.before(async () => {
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      lastUpstream = { headers: req.headers, body: JSON.parse(raw) };
      if (upstreamMode === "401") {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: "Incorrect API key sk-should-not-leak" } }));
      }
      res.end(JSON.stringify({ choices: [{ message: { content: "Mock answer about Hare Ram." } }] }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  env = {
    OPENAI_API_KEY: "sk-test-key-123",
    OPENAI_BASE_URL: "http://127.0.0.1:" + upstream.address().port + "/v1",
    ALLOWED_ORIGINS: SITE + ",https://www.hareram.website",
    CHAT_RATE_LIMIT_PER_MINUTE: "1000",
    CHAT_RATE_LIMIT_PER_DAY: "100000",
  };
  worker = (await import(pathToFileURL(path.join(__dirname, "..", "cloudflare", "dist", "worker.mjs")).href)).default;
});

test.after(() => upstream.close());

test("answers a question and never returns the key", async () => {
  const response = await chat({ messages: [user("Who is Hare Ram?")] });
  assert.strictEqual(response.status, 200);
  const text = await response.text();
  assert.deepStrictEqual(JSON.parse(text), { reply: "Mock answer about Hare Ram." });
  assert.ok(!text.includes("sk-test"));
  assert.strictEqual(lastUpstream.headers.authorization, "Bearer sk-test-key-123");
  assert.strictEqual(lastUpstream.body.messages[0].role, "system");
  assert.match(lastUpstream.body.messages[0].content, /Patna University/);
  assert.match(lastUpstream.body.messages[0].content, /apply his statistical knowledge/);
});

test("the portfolio site may call it cross-origin; other sites may not", async () => {
  const allowed = await chat({ messages: [user("hi")] }, { Origin: SITE });
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(allowed.headers.get("Access-Control-Allow-Origin"), SITE);

  const preflight = await worker.fetch(new Request(SELF + "/api/chat", { method: "OPTIONS", headers: { Origin: SITE } }), env);
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(preflight.headers.get("Access-Control-Allow-Headers"), "Content-Type");

  const blocked = await chat({ messages: [user("hi")] }, { Origin: "https://evil.example" });
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual(blocked.headers.get("Access-Control-Allow-Origin"), null);

  const sameOrigin = await chat({ messages: [user("hi")] }, { Origin: SELF });
  assert.strictEqual(sameOrigin.status, 200);
});

test("validation matches the Vercel function", async () => {
  assert.strictEqual((await chat({ messages: [] })).status, 400);
  assert.strictEqual((await chat({ messages: [{ role: "system", content: "x" }, user("hi")] })).status, 400);
  assert.strictEqual((await chat({ messages: [user("a".repeat(501))] })).status, 400);
  assert.strictEqual((await chat({ messages: [user("a".repeat(500))] })).status, 200);
  assert.strictEqual((await chat("{bad")).status, 400);
  assert.strictEqual((await chat({ messages: [user("hi")], pad: "x".repeat(40000) })).status, 413);
  assert.strictEqual((await chat("hi", { "Content-Type": "text/plain" })).status, 415);
  assert.strictEqual((await worker.fetch(new Request(SELF + "/api/chat"), env)).status, 405);
});

test("missing key and upstream errors give friendly messages without details", async () => {
  const missing = await chat({ messages: [user("hi")] }, null, { OPENAI_API_KEY: "" });
  assert.strictEqual(missing.status, 503);
  assert.strictEqual((await missing.json()).code, "not_configured");

  upstreamMode = "401";
  const failed = await chat({ messages: [user("hi")] });
  upstreamMode = "ok";
  const text = await failed.text();
  assert.strictEqual(failed.status, 502);
  assert.ok(!text.includes("sk-"));
});

test("rate limits per visitor IP", async () => {
  const fresh = (await import(pathToFileURL(path.join(__dirname, "..", "cloudflare", "dist", "worker.mjs")).href + "?fresh=1")).default;
  const tight = Object.assign({}, env, { CHAT_RATE_LIMIT_PER_MINUTE: "2" });
  const send = (ip) =>
    fresh.fetch(
      new Request(SELF + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ messages: [user("hi")] }) }),
      tight
    );
  assert.strictEqual((await send("198.51.100.1")).status, 200);
  assert.strictEqual((await send("198.51.100.1")).status, 200);
  const limited = await send("198.51.100.1");
  assert.strictEqual(limited.status, 429);
  assert.ok(Number(limited.headers.get("Retry-After")) > 0);
  assert.strictEqual((await send("198.51.100.2")).status, 200);
});

test("serves the widget files and a test page", async () => {
  const js = await worker.fetch(new Request(SELF + "/chatbot.js"), env);
  assert.strictEqual(js.status, 200);
  assert.match(js.headers.get("Content-Type"), /javascript/);
  assert.match(await js.text(), /Hare Ram's AI Assistant/);

  const css = await worker.fetch(new Request(SELF + "/chatbot.css"), env);
  assert.match(css.headers.get("Content-Type"), /text\/css/);
  assert.match(await css.text(), /\.hrc-launcher/);

  const page = await worker.fetch(new Request(SELF + "/"), env);
  const html = await page.text();
  assert.match(html, new RegExp('data-endpoint="' + SELF + '/api/chat"'));
  assert.ok(!html.includes("sk-"));

  assert.strictEqual((await worker.fetch(new Request(SELF + "/nope"), env)).status, 404);
});
