"use strict";

/**
 * Local development server (no dependencies).
 *
 *   node scripts/dev-server.js
 *
 * Serves the site's static files and routes POST /api/chat to the same
 * handler Vercel runs in production. Reads variables from a .env file in the
 * project root if one exists. Not used in production.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const staticRoot = path.resolve(process.env.STATIC_ROOT || projectRoot);
const port = parseInt(process.env.PORT, 10) || 3000;

// Minimal .env loader: KEY=value lines, optional quotes, # comments.
const envFile = path.join(projectRoot, ".env");
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match || line.trim().startsWith("#")) return;
      const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    });
}

const chatHandler = require(path.join(projectRoot, "api", "chat.js"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

  if (pathname === "/api/chat") {
    Promise.resolve(chatHandler(req, res)).catch((error) => {
      console.error(error);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
    return;
  }

  const filePath = path.join(staticRoot, pathname === "/" ? "index.html" : pathname);
  const relative = path.relative(staticRoot, filePath);
  const hidden = relative.split(path.sep).some((part) => part.startsWith("."));
  if (relative.startsWith("..") || path.isAbsolute(relative) || hidden) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.statusCode = 404;
      return res.end("Not found");
    }
    res.setHeader("Content-Type", TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream");
    res.end(data);
  });
});

server.listen(port, () => {
  console.log("Portfolio running at http://localhost:" + port);
  if (!process.env.OPENAI_API_KEY) console.log("OPENAI_API_KEY is not set: the chat will show its 'not available' message.");
});
