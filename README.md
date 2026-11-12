# Hare Ram's AI Assistant — setup and maintenance

A chat widget for hareram.website that answers questions about Hare Ram from a
verified knowledge base, through a serverless function. The backend calls
Gemini or OpenAI — whichever API key is set (Gemini is used if both are set).

## What the inspection of the live site found

| Item | Finding |
|---|---|
| Framework | None. Plain static site: `index.html`, `css/styles.css`, `js/main.js` |
| Hosting | Vercel (response header `server: Vercel`) |
| Backend | None today. The contact form opens the visitor's email app (`mailto:`) |
| Theme | Dark/light toggle driven by CSS variables on `html[data-theme]`; teal accent `#3cbfb2` (dark) / `#0c5c56` (light); IBM Plex Sans + IBM Plex Mono |
| Resume | `resume/Hare_Ram_Resume.pdf` |
| GitHub | `https://github.com/hareram08` |
| LinkedIn | `https://www.linkedin.com/in/hare-ram-1b5526421/` |
| Email | `hareram2011000@gmail.com` (already public in the contact section) |

Because the site is static on Vercel, the backend is one Vercel serverless
function (`api/chat.js`). No separate server, no framework, no npm packages.

## Files

```
api/chat.js               Serverless function: validation, rate limit, calls the LLM
api/_lib/knowledge.json   Everything the assistant knows (edit this to update it)
api/_lib/prompt.js        The assistant's rules (system prompt)
api/_lib/rate-limit.js    Per-visitor rate limiter
api/_lib/validate.js      Request validation (shared with the Cloudflare Worker)
api/_lib/llm.js           Calls Gemini or OpenAI, whichever key is set (shared with the Worker)
cloudflare/build.js       Builds the single-file Cloudflare Worker
cloudflare/worker.template.js   Worker source (routes, CORS, calls the LLM)
css/chatbot.css           Widget styles (uses the site's own CSS variables)
js/chatbot.js             Widget behaviour (no dependencies)
.env.example              Environment variable template
scripts/dev-server.js     Local server for testing (not used in production)
tests/api.test.js         Vercel function tests, OpenAI path (no API key or internet needed)
tests/gemini.test.js      Vercel function tests, Gemini path
tests/worker.test.js      Cloudflare Worker tests (both providers)
```

Folders starting with `_` inside `api/` are not turned into endpoints by Vercel.

## Two ways to host the backend

The widget (`js/chatbot.js`, `css/chatbot.css`) is the same either way. Pick one
backend:

| | Cloudflare (this repo's deployment) | Vercel function |
|---|---|---|
| Where it runs | Cloudflare Worker `hareram-ai-assistant` | `api/chat.js` inside the website's own Vercel project |
| Website change | Two lines in `index.html` pointing at Cloudflare | Copy files into the site + two lines |
| Key lives in | Cloudflare secret `GEMINI_API_KEY` (or `OPENAI_API_KEY`) | Vercel environment variable `GEMINI_API_KEY` (or `OPENAI_API_KEY`) |

## Cloudflare deployment

`node cloudflare/build.js` produces one self-contained file,
`cloudflare/dist/_worker.js`, that serves:

- `POST /api/chat` — the chat endpoint
- `GET /chatbot.js` and `GET /chatbot.css` — the widget
- `GET /` — a test page for the widget

**Live deployment:** Worker `hareram-ai-assistant` at
https://hareram-ai-assistant.hareram.workers.dev (test page at `/`). It was
uploaded through the Cloudflare API, so it does NOT redeploy on push. To get
automatic deploys, connect this repo in the Cloudflare dashboard (Workers &
Pages > the Worker > Settings > Build > connect Git repository; the included
`wrangler.jsonc` supplies the build settings), or run `npx wrangler deploy`
after each change.

Variables (Workers & Pages > hareram-ai-assistant > Settings > Variables and Secrets):

| Name | Type | Value |
|---|---|---|
| `GEMINI_API_KEY` | Secret | your Gemini key (never commit it) — used if set, even if `OPENAI_API_KEY` is also set |
| `ALLOWED_ORIGINS` | Text | `https://hareram.website,https://www.hareram.website` |
| `GEMINI_MODEL` | Text, optional | default `gemini-3.8-flash` |
| `OPENAI_API_KEY` | Secret, alternative provider | your OpenAI key (only used if `GEMINI_API_KEY` is not set) |
| `OPENAI_MODEL` | Text, optional | default `gpt-4.1-mini` |

Saving a variable or secret in the dashboard deploys it immediately.

Embed on the website:

```html
<!-- in <head>, after css/styles.css -->
<link rel="stylesheet" href="https://hareram-ai-assistant.hareram.workers.dev/chatbot.css">

<!-- before </body>, after js/main.js -->
<script src="https://hareram-ai-assistant.hareram.workers.dev/chatbot.js"
        data-endpoint="https://hareram-ai-assistant.hareram.workers.dev/api/chat" defer></script>
```

Only sites listed in `ALLOWED_ORIGINS` (and the Pages address itself) can call
the chat endpoint from a browser. Edge case: if the website is ever served
from another address (a Vercel preview URL, a new domain), add that address to
`ALLOWED_ORIGINS` or the chat will answer "can only be used from the portfolio
website".

After editing `knowledge.json`, `prompt.js`, `chatbot.js` or `chatbot.css`,
the Worker must be redeployed (see above). Browsers cache the widget files for
5 minutes.

## Vercel deployment (alternative)

### Install (two lines in index.html)

1. Copy the `api/` folder, `css/chatbot.css`, `js/chatbot.js`, `scripts/`,
   `tests/` and `.env.example` into the root of your site's repository, next to
   `index.html`. Nothing existing is overwritten.

2. In `index.html`, add the stylesheet directly under the existing one:

   ```html
   <link rel="stylesheet" href="css/styles.css">
   <link rel="stylesheet" href="css/chatbot.css">      <!-- add -->
   ```

3. Add the script directly under the existing one, before `</body>`:

   ```html
   <script src="js/main.js"></script>
   <script src="js/chatbot.js" defer></script>         <!-- add -->
   ```

4. Add `.env` to `.gitignore` (create the file if it does not exist).

No existing section, class, or script is modified. The single exception is one
CSS rule in `chatbot.css` that gives the footer extra bottom padding on screens
narrower than 1280px, so the chat button never sits on top of the footer links.

### Deploy on Vercel

1. Create a free API key at https://aistudio.google.com/apikey (or an OpenAI
   key at https://platform.openai.com/api-keys if you'd rather use that).
2. **Set a spend/usage limit** where the key was issued (Google AI Studio's
   usage page, or OpenAI's Billing > Limits). This is the hard ceiling on
   cost; see "Rate limiting" below for why it matters.
3. Vercel dashboard > your project > Settings > Environment Variables. Add
   `GEMINI_API_KEY` (or `OPENAI_API_KEY`) for Production (and Preview if you
   want it on previews). Optional variables are listed in `.env.example`.
4. Commit and push (or run `vercel --prod`). Environment variables only apply
   to deployments made after they were added, so redeploy if you add the key
   afterwards.
5. Open the site, click the chat button, ask "Who is Hare Ram?".

## Run locally

```bash
cp .env.example .env        # then put your key in .env
node scripts/dev-server.js  # http://localhost:3000
```

Needs Node.js 18 or newer. `vercel dev` also works if you use the Vercel CLI.

## Tests

```bash
node cloudflare/build.js
node --test tests/api.test.js tests/gemini.test.js tests/worker.test.js
```

Backend tests run against fake Gemini and OpenAI servers (no real key or
internet needed, nothing billed): valid answers, system prompt and knowledge
base are sent, follow-up context mapped to each provider's message format,
role injection blocked, empty/malformed input, 500-character limit, history
trimming, oversized bodies, wrong method/content type, cross-site blocking,
upstream errors hidden from visitors, missing key, provider priority
(Gemini over OpenAI when both keys are set), rate limiter, and knowledge-base
integrity.

## Updating what the assistant knows

Edit `api/_lib/knowledge.json` and redeploy. Rules:

- Only add things that are true. The assistant repeats this file.
- Leave a field `null` when you do not have the information; the assistant
  will say it is not available rather than guess.
- "What did he learn?" questions are answered only from each project's
  `skills_demonstrated`, `workflow` and `technical_implementation`.
- The Fleet Performance Monitoring project has
  `"completion_status": "not_confirmed"`, so the assistant never calls it
  completed. Change it to `"completed"`, `"in_progress"` or `"planned"` once
  you decide, and delete `completion_note` if it is completed.
- `outcomes_or_metrics` must stay `null` unless you have real, measured numbers.
- When you finish a certificate, add it to
  `certifications.completed_listed_in_portfolio` with issuer and date.
- When you take a job or internship, update `professional_experience`.

To change tone or rules, edit `api/_lib/prompt.js`. To change the welcome
message or suggested questions, edit `CONFIG` at the top of `js/chatbot.js`.

## Security

- The API key exists only in Vercel's environment variables. It is never sent
  to the browser and never appears in any file in the repository.
- The browser may only send `user` and `assistant` messages; the system prompt
  is added on the server and cannot be replaced by a visitor.
- Input validation: JSON only, 32 KB body cap, 500 characters per message, at
  most 40 messages per request, last 12 sent to the model, control characters
  stripped.
- Requests from other websites are refused (the `Origin` must match the site).
- Provider (Gemini/OpenAI) error details are logged on the server and never
  shown to visitors.
- Assistant replies are HTML-escaped before display; only bold, lists, code
  and links to `http(s)`, `mailto`, `/` and `#` addresses are rendered.

## Rate limiting — read this

Limits: 8 messages per minute and 80 per day per IP address (configurable).

The limiter keeps its counters in the function's memory. On serverless hosting
that memory is separate for each running instance and is wiped on a cold
start, so the limit is approximate: it stops casual abuse, not a determined
script. Three things cover the gap:

1. The provider spend/usage limit from the deploy steps (the real ceiling).
2. Replies are capped at 700 tokens and history at 12 messages.
3. If you ever see abuse, move the counters to a shared store such as Upstash
   Redis; only `api/_lib/rate-limit.js` needs to change.

## Edge cases to know about

- **`package.json` with `"type": "module"`**: the function files use
  `require`. If you later add a `package.json` with that setting, rename the
  four files in `api/` to use `import`/`export`, or leave `type` unset.
- **Vercel "Root Directory" / "Output Directory" settings**: the `api/` folder
  must be at the project's root directory as Vercel sees it. If the project is
  configured to deploy a subfolder, put `api/` inside that subfolder.
- **Model retirement**: both Google and OpenAI retire model names over time.
  If answers stop and the log shows a 404 for the model, set `GEMINI_MODEL`
  (or `OPENAI_MODEL`) to a current one. Reasoning-style models can spend the
  700-token budget thinking and return nothing; prefer a standard chat model,
  or raise `MAX_REPLY_TOKENS` in `api/chat.js`.
- **Gemini safety filters**: Gemini can return an empty reply with
  `finishReason: "SAFETY"` for a question it flags, even an innocuous one.
  This shows up to the visitor as "could not produce an answer"; check the
  Cloudflare/Vercel logs for the `[chat] Gemini finishReason` line.
- **Switching providers**: set the other key (`GEMINI_API_KEY` or
  `OPENAI_API_KEY`) and remove the one you're moving away from — Gemini is
  always preferred when both are present, so leaving an old key in place
  silently does nothing once the other is set.
- **Shared networks**: visitors behind one office or college IP address share
  one rate-limit bucket. Raise `CHAT_RATE_LIMIT_PER_MINUTE` if recruiters at
  the same company get blocked.
- **Conversation memory** lives in the visitor's browser tab (sessionStorage)
  and is sent with each question. Closing the tab forgets it. Nothing is
  stored on the server.
- **Private browsing** with storage disabled: the chat works but the
  conversation is lost on reload.
- **Fleet Performance Monitoring project**: it is in the knowledge base (from
  your brief) but not on the website. The assistant will describe it, and a
  visitor will not find it in the Projects section.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "The assistant is not available right now" | Neither `GEMINI_API_KEY` nor `OPENAI_API_KEY` is set, or the key is wrong/out of credit. Check the logs for `[chat]` lines |
| "The assistant is not set up on this site yet" | `/api/chat` returned 404: the `api/` folder is not at the deployed root |
| "The assistant is busy right now" | Provider rate limit or outage; also shown when the account has no quota/credit left |
| Chat button missing | The two lines in `index.html` were not added, or the file paths differ |
| Widget looks unstyled | `css/chatbot.css` must load after `css/styles.css` |
