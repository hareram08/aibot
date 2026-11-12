"use strict";

/**
 * Builds the single-file Cloudflare Worker (no dependencies, no bundler).
 *
 *   node cloudflare/build.js   ->   cloudflare/dist/worker.mjs and cloudflare/dist/_worker.js
 *
 * It inlines the system prompt (rules + knowledge.json), the widget's JS and
 * CSS, and the shared validation and rate-limit code, so the Worker and the
 * Vercel function always behave the same. Rebuild and redeploy after editing
 * knowledge.json, prompt.js, chatbot.js or chatbot.css.
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// Turn a small CommonJS file into plain declarations.
function inlineModule(relative) {
  return read(relative)
    .replace(/^"use strict";\s*/m, "")
    .replace(/^module\.exports\s*=.*$/m, "")
    .trim();
}

const { buildSystemPrompt } = require(path.join(root, "api/_lib/prompt.js"));
const knowledge = JSON.parse(read("api/_lib/knowledge.json"));

const replacements = {
  __SYSTEM_PROMPT__: JSON.stringify(buildSystemPrompt(knowledge)),
  __WIDGET_JS__: JSON.stringify(read("js/chatbot.js")),
  __WIDGET_CSS__: JSON.stringify(read("css/chatbot.css")),
  __VALIDATE_SOURCE__: inlineModule("api/_lib/validate.js"),
  __RATE_LIMIT_SOURCE__: inlineModule("api/_lib/rate-limit.js"),
  __LLM_SOURCE__: inlineModule("api/_lib/llm.js"),
};

let output = read("cloudflare/worker.template.js");
Object.keys(replacements).forEach((token) => {
  // Function form so "$" in the replacement text is not treated specially.
  output = output.replace(token + (token.endsWith("SOURCE__") ? "" : ";"), () => replacements[token] + (token.endsWith("SOURCE__") ? "" : ";"));
});

const outDir = path.join(root, "cloudflare", "dist");
fs.mkdirSync(outDir, { recursive: true });
// worker.mjs: for tests and "wrangler deploy". _worker.js: the same file under the
// name Cloudflare Pages looks for (advanced mode) when cloudflare/dist is the output directory.
fs.writeFileSync(path.join(outDir, "worker.mjs"), output);
fs.writeFileSync(path.join(outDir, "_worker.js"), output);
console.log("Built cloudflare/dist/worker.mjs and _worker.js (" + output.length + " bytes)");
