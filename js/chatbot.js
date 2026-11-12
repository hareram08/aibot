/*
 * Hare Ram's AI Assistant — chat widget (no dependencies).
 * Loaded with:  <script src="js/chatbot.js" defer></script>
 * Talks to the serverless function at /api/chat. No API key is used here.
 */
(function () {
  "use strict";

  if (window.__hrChatLoaded) return;
  window.__hrChatLoaded = true;

  var script = document.currentScript;

  var CONFIG = {
    endpoint: (script && script.getAttribute("data-endpoint")) || "/api/chat",
    maxLength: 500, // keep in sync with MAX_MESSAGE_CHARS in api/chat.js
    historyLimit: 10, // messages sent as context for follow-up questions
    requestTimeoutMs: 30000,
    storageKey: "hr-chat-v1",
    name: "Hare Ram's AI Assistant",
    subtitle: "Your guide to Hare Ram's professional profile.",
    welcome:
      "Hello! Welcome to Hare Ram's portfolio. I'm his AI assistant. You can ask me about his education, technical skills, projects, learning journey, and professional background.",
    suggestions: [
      "Who is Hare Ram?",
      "Tell me about his education.",
      "What are his technical skills?",
      "Explain his AWS projects.",
      "What is his experience with SQL?",
      "Why did he choose Data Analytics?",
      "What projects has he completed?",
      "What makes his Statistics background useful for Data Analytics?",
      "Can I download his resume?",
      "How can I contact him?",
    ],
  };

  var ICONS = {
    chat: '<svg class="hrc-icon-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 20.5l1.7-5A8.4 8.4 0 1 1 21 11.5z"/><path d="M8.5 10.5h7M8.5 13.5h4.5"/></svg>',
    close: '<svg class="hrc-icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  };

  /* ---------- State ---------- */

  var messages = []; // { role: "user" | "assistant", content, ts }
  var pending = false;
  var isOpen = false;
  var clearTimer = null;
  var welcomeTs = Date.now();

  function loadState() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(CONFIG.storageKey) || "[]");
      if (Array.isArray(saved)) {
        messages = saved.filter(function (m) {
          return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
        });
      }
    } catch (error) {
      messages = [];
    }
  }

  function saveState() {
    try {
      sessionStorage.setItem(CONFIG.storageKey, JSON.stringify(messages.slice(-40)));
    } catch (error) {
      /* storage unavailable: the chat still works for this page view */
    }
  }

  /* ---------- Small helpers ---------- */

  function el(tag, attrs, html) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "class") node.className = attrs[key];
        else if (key === "text") node.textContent = attrs[key];
        else node.setAttribute(key, attrs[key]);
      });
    }
    if (html) node.innerHTML = html;
    return node;
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (error) {
      return "";
    }
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /* ---------- Safe, minimal Markdown rendering ---------- */
  // Everything is HTML-escaped first; only links, bold, code and lists are
  // turned back into markup, and only http(s), mailto, "/" and "#" links.

  function makeLink(url, label) {
    if (!/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(url)) return label;
    var external = /^https?:\/\//i.test(url);
    return '<a href="' + url + '"' + (external ? ' target="_blank" rel="noopener noreferrer"' : "") + ">" + label + "</a>";
  }

  function renderInline(escaped) {
    var out = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (match, label, url) {
      return makeLink(url, label);
    });
    out = out.replace(/(^|[\s(])((?:https?:\/\/|mailto:)[^\s<]+[^\s<.,;:!?)])/g, function (match, lead, url) {
      return lead + makeLink(url, url.replace(/^mailto:/i, ""));
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    return out;
  }

  function renderMarkdown(text) {
    var lines = escapeHtml(text).split(/\r?\n/);
    var html = [];
    var paragraph = [];
    var list = null; // { type: "ul" | "ol", items: [] }

    function flushParagraph() {
      if (paragraph.length) html.push("<p>" + paragraph.join("<br>") + "</p>");
      paragraph = [];
    }
    function flushList() {
      if (list) html.push("<" + list.type + "><li>" + list.items.join("</li><li>") + "</li></" + list.type + ">");
      list = null;
    }

    lines.forEach(function (raw) {
      var line = raw.trim();
      var bullet = /^[-*•]\s+(.*)$/.exec(line);
      var numbered = /^\d+[.)]\s+(.*)$/.exec(line);
      if (!line) {
        flushParagraph();
        flushList();
      } else if (bullet || numbered) {
        var type = bullet ? "ul" : "ol";
        flushParagraph();
        if (list && list.type !== type) flushList();
        if (!list) list = { type: type, items: [] };
        list.items.push(renderInline((bullet || numbered)[1]));
      } else {
        flushList();
        var heading = /^#{1,6}\s+(.*)$/.exec(line);
        paragraph.push(heading ? "<strong>" + renderInline(heading[1]) + "</strong>" : renderInline(line));
      }
    });
    flushParagraph();
    flushList();
    return html.join("");
  }

  /* ---------- DOM ---------- */

  var root = el("div", { class: "hrc-root" });

  var launcher = el(
    "button",
    {
      class: "hrc-launcher",
      type: "button",
      "aria-label": "Open chat with " + CONFIG.name,
      "aria-expanded": "false",
      "aria-controls": "hrc-panel",
    },
    ICONS.chat + ICONS.close
  );

  var panel = el("div", { class: "hrc-panel", id: "hrc-panel", role: "dialog", "aria-label": CONFIG.name });

  var header = el("div", { class: "hrc-header" });
  header.appendChild(el("div", { class: "hrc-avatar", "aria-hidden": "true", text: "AI" }));
  var heading = el("div", { class: "hrc-heading" });
  heading.appendChild(el("p", { class: "hrc-title", text: CONFIG.name }));
  heading.appendChild(el("p", { class: "hrc-subtitle", text: CONFIG.subtitle }));
  header.appendChild(heading);
  var clearBtn = el("button", { class: "hrc-icon-btn", type: "button", "aria-label": "Clear conversation", title: "Clear conversation" }, ICONS.trash);
  var closeBtn = el("button", { class: "hrc-icon-btn", type: "button", "aria-label": "Close chat", title: "Close chat" }, ICONS.x);
  header.appendChild(clearBtn);
  header.appendChild(closeBtn);

  var log = el("div", { class: "hrc-log", role: "log", "aria-live": "polite", "aria-label": "Conversation", tabindex: "0" });

  var suggest = el("div", { class: "hrc-suggest" });
  suggest.appendChild(el("p", { class: "hrc-suggest-label", text: "Suggested questions" }));
  var chips = el("div", { class: "hrc-chips" });
  CONFIG.suggestions.forEach(function (question) {
    var chip = el("button", { class: "hrc-chip", type: "button", text: question });
    chip.addEventListener("click", function () {
      sendMessage(question);
    });
    chips.appendChild(chip);
  });
  suggest.appendChild(chips);

  var form = el("form", { class: "hrc-form", novalidate: "" });
  var inputId = "hrc-input";
  form.appendChild(el("label", { class: "hrc-sr", for: inputId, text: "Ask a question about Hare Ram" }));
  var input = el("textarea", {
    class: "hrc-input",
    id: inputId,
    rows: "1",
    placeholder: "Ask about Hare Ram…",
    maxlength: String(CONFIG.maxLength),
    autocomplete: "off",
    enterkeyhint: "send",
  });
  var sendBtn = el("button", { class: "hrc-send", type: "submit", "aria-label": "Send message", disabled: "" }, ICONS.send);
  form.appendChild(input);
  form.appendChild(sendBtn);

  var foot = el("div", { class: "hrc-foot" });
  var suggestToggle = el("button", { class: "hrc-link-btn", type: "button", "aria-expanded": "true", text: "Hide suggestions" });
  var counter = el("span", { class: "hrc-counter", "aria-hidden": "true" });
  var footRight = el("p");
  footRight.appendChild(el("span", { text: "AI answers from his portfolio. " }));
  footRight.appendChild(counter);
  foot.appendChild(suggestToggle);
  foot.appendChild(footRight);

  panel.appendChild(header);
  panel.appendChild(log);
  panel.appendChild(suggest);
  panel.appendChild(form);
  panel.appendChild(foot);
  root.appendChild(panel);
  root.appendChild(launcher);

  /* ---------- Rendering ---------- */

  function scrollToLatest() {
    log.scrollTop = log.scrollHeight;
  }

  function copyText(text, button) {
    function done(ok) {
      button.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(function () {
        button.textContent = "Copy";
      }, 1600);
    }
    function fallback() {
      var area = el("textarea", { class: "hrc-sr", "aria-hidden": "true" });
      area.value = text;
      root.appendChild(area);
      area.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (error) {
        ok = false;
      }
      root.removeChild(area);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        done(true);
      }, fallback);
    } else {
      fallback();
    }
  }

  function addBubble(kind, content, ts, options) {
    options = options || {};
    var wrap = el("div", { class: "hrc-msg hrc-msg--" + kind });
    var bubble = el("div", { class: "hrc-bubble" });
    if (kind === "user") bubble.textContent = content;
    else bubble.innerHTML = renderMarkdown(content);
    wrap.appendChild(bubble);

    var meta = el("div", { class: "hrc-meta" });
    meta.appendChild(el("time", { datetime: new Date(ts).toISOString(), text: formatTime(ts) }));
    if (kind === "ai" && options.copy !== false) {
      var copyBtn = el("button", { class: "hrc-link-btn", type: "button", "aria-label": "Copy this answer", text: "Copy" });
      copyBtn.addEventListener("click", function () {
        copyText(bubble.innerText.trim(), copyBtn);
      });
      meta.appendChild(copyBtn);
    }
    if (kind === "error" && options.retry) {
      var retryBtn = el("button", { class: "hrc-link-btn", type: "button", text: "Try again" });
      retryBtn.addEventListener("click", function () {
        wrap.remove();
        requestReply();
      });
      meta.appendChild(retryBtn);
    }
    wrap.appendChild(meta);
    log.appendChild(wrap);
    scrollToLatest();
    return wrap;
  }

  function renderAll() {
    log.innerHTML = "";
    addBubble("ai", CONFIG.welcome, welcomeTs, { copy: false });
    messages.forEach(function (message) {
      addBubble(message.role === "user" ? "user" : "ai", message.content, message.ts);
    });
    setSuggestionsVisible(messages.length === 0);
  }

  function setSuggestionsVisible(visible) {
    suggest.hidden = !visible;
    suggestToggle.textContent = visible ? "Hide suggestions" : "Suggestions";
    suggestToggle.setAttribute("aria-expanded", String(visible));
    scrollToLatest();
  }

  var typingNode = null;
  function showTyping(show) {
    if (typingNode) {
      typingNode.remove();
      typingNode = null;
    }
    if (!show) return;
    typingNode = el("div", { class: "hrc-msg hrc-msg--ai" });
    var bubble = el("div", { class: "hrc-bubble" });
    bubble.appendChild(el("span", { class: "hrc-sr", text: "Assistant is typing" }));
    bubble.appendChild(el("span", { class: "hrc-typing", "aria-hidden": "true" }, "<span></span><span></span><span></span>"));
    typingNode.appendChild(bubble);
    log.appendChild(typingNode);
    scrollToLatest();
  }

  function updateComposer() {
    var length = input.value.length;
    var hasText = input.value.trim().length > 0;
    sendBtn.disabled = pending || !hasText || length > CONFIG.maxLength;
    var near = length >= CONFIG.maxLength - 100;
    counter.textContent = near ? length + "/" + CONFIG.maxLength : "";
    counter.classList.toggle("is-over", length >= CONFIG.maxLength);
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight + 2, 110) + "px";
  }

  function setPending(value) {
    pending = value;
    showTyping(value);
    panel.setAttribute("aria-busy", String(value));
    Array.prototype.forEach.call(chips.children, function (chip) {
      chip.disabled = value;
    });
    updateComposer();
  }

  /* ---------- Talking to the backend ---------- */

  function historyForRequest() {
    var recent = messages.slice(-CONFIG.historyLimit).map(function (message) {
      return { role: message.role, content: message.content };
    });
    while (recent.length && recent[0].role !== "user") recent.shift();
    return recent;
  }

  function friendlyError(status, payload) {
    if (payload && typeof payload.error === "string" && payload.error) return payload.error;
    if (status === 429) return "You are sending messages too quickly. Please wait a moment and try again.";
    if (status === 404) return "The assistant is not set up on this site yet.";
    return "Something went wrong. Please try again.";
  }

  function requestReply() {
    if (pending) return;
    setPending(true);

    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, CONFIG.requestTimeoutMs);

    fetch(CONFIG.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: historyForRequest() }),
      signal: controller ? controller.signal : undefined,
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (payload) {
            return { ok: response.ok, status: response.status, payload: payload };
          });
      })
      .then(function (result) {
        if (!result.ok || !result.payload || typeof result.payload.reply !== "string") {
          // 400 means the message itself was rejected, so retrying will not help.
          addBubble("error", friendlyError(result.status, result.payload), Date.now(), { retry: result.status !== 400 });
          return;
        }
        var reply = { role: "assistant", content: result.payload.reply, ts: Date.now() };
        messages.push(reply);
        saveState();
        addBubble("ai", reply.content, reply.ts);
      })
      .catch(function (error) {
        var timedOut = error && error.name === "AbortError";
        addBubble(
          "error",
          timedOut
            ? "The assistant took too long to respond. Please try again."
            : "Could not reach the assistant. Check your connection and try again.",
          Date.now(),
          { retry: true }
        );
      })
      .then(function () {
        clearTimeout(timer);
        setPending(false);
        if (isOpen && window.matchMedia && window.matchMedia("(min-width: 601px)").matches) input.focus();
      });
  }

  function sendMessage(text) {
    text = String(text || "").trim();
    if (!text || pending) return;
    if (text.length > CONFIG.maxLength) {
      addBubble("error", "Messages are limited to " + CONFIG.maxLength + " characters. Please shorten your question.", Date.now());
      return;
    }
    // A failed turn leaves a user message without an answer; drop old error notes.
    Array.prototype.slice.call(log.querySelectorAll(".hrc-msg--error")).forEach(function (node) {
      node.remove();
    });
    // If the previous question never got an answer, replace it rather than sending two in a row.
    if (messages.length && messages[messages.length - 1].role === "user") messages.pop();

    var message = { role: "user", content: text, ts: Date.now() };
    messages.push(message);
    saveState();
    renderAll();
    setSuggestionsVisible(false);
    input.value = "";
    updateComposer();
    requestReply();
  }

  /* ---------- Open / close ---------- */

  function setOpen(open) {
    isOpen = open;
    root.classList.toggle("is-open", open);
    panel.inert = !open;
    launcher.setAttribute("aria-expanded", String(open));
    launcher.setAttribute("aria-label", (open ? "Close chat with " : "Open chat with ") + CONFIG.name);
    if (open) {
      scrollToLatest();
      setTimeout(function () {
        input.focus({ preventScroll: true });
      }, 60);
    } else if (panel.contains(document.activeElement)) {
      launcher.focus({ preventScroll: true });
    }
  }

  launcher.addEventListener("click", function () {
    setOpen(!isOpen);
  });
  closeBtn.addEventListener("click", function () {
    setOpen(false);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && isOpen) setOpen(false);
  });

  // Two-step clear so a stray click does not wipe the conversation.
  function resetClear() {
    clearTimeout(clearTimer);
    clearBtn.classList.remove("is-confirm");
    clearBtn.innerHTML = ICONS.trash;
    clearBtn.setAttribute("aria-label", "Clear conversation");
  }
  clearBtn.addEventListener("click", function () {
    if (!clearBtn.classList.contains("is-confirm")) {
      if (!messages.length && !log.querySelector(".hrc-msg--error")) return;
      clearBtn.classList.add("is-confirm");
      clearBtn.textContent = "Clear?";
      clearBtn.setAttribute("aria-label", "Confirm clearing the conversation");
      clearTimer = setTimeout(resetClear, 3500);
      return;
    }
    resetClear();
    messages = [];
    welcomeTs = Date.now();
    saveState();
    renderAll();
    input.focus();
  });

  suggestToggle.addEventListener("click", function () {
    setSuggestionsVisible(suggest.hidden);
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    sendMessage(input.value);
  });
  input.addEventListener("input", updateComposer);
  input.addEventListener("keydown", function (event) {
    // Enter sends; Shift+Enter adds a new line. Ignore Enter while an IME is composing (Hindi keyboards).
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage(input.value);
    }
  });

  // In-page links (#contact, #projects): on phones the chat covers the page, so close it first.
  log.addEventListener("click", function (event) {
    var link = event.target.closest ? event.target.closest("a[href^='#']") : null;
    if (link && window.matchMedia && window.matchMedia("(max-width: 600px)").matches) setOpen(false);
  });

  /* ---------- Start ---------- */

  function init() {
    loadState();
    document.body.appendChild(root);
    panel.inert = true;
    renderAll();
    updateComposer();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
