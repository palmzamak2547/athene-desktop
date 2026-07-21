// renderer.js — the chat UI logic. XSS-safe (builds DOM with textContent, never
// innerHTML on model output). Feature-detects window.athene so the page still
// renders in a plain browser (for development/verification), with send disabled.
const api = window.athene;
const $ = (id) => document.getElementById(id);

const messagesEl = $("messages");
const inputEl = $("input");
const sendEl = $("send");
const modeEl = $("mode");
const engineEl = $("engine");

let history = []; // the active thread's [{role, content}]
let streaming = false;
let current = null; // the assistant bubble being streamed into

// ---- threads (left sidebar), persisted to localStorage ----
const THREADS_KEY = "athene.threads";
let threads = [];
let activeId = null;
try {
  threads = JSON.parse(localStorage.getItem(THREADS_KEY) || "[]");
} catch {
  threads = [];
}
const persistThreads = () => {
  try {
    localStorage.setItem(THREADS_KEY, JSON.stringify(threads.slice(0, 50)));
  } catch {
    /* ignore quota */
  }
};

// The editorial "Ask Athene" hero. Kept identical to the static markup in
// index.html so the empty state looks the same on first launch and after a
// New chat / cleared thread.
const EMPTY_INNER =
  '<div class="empty-logo" aria-hidden="true">A</div>' +
  "<h1>Ask Athene</h1>" +
  "<p>Athene drives its real agent: free frontier models with tools, read-only by default. Pick Local or Cloud in the engine selector.</p>" +
  '<div class="prompt-chips">' +
  '<button class="prompt-chip" type="button" data-prompt="What does this project do? Give me a quick tour.">What does this project do?</button>' +
  '<button class="prompt-chip" type="button" data-prompt="Explain how the main entry point works, step by step.">Explain the main entry point</button>' +
  '<button class="prompt-chip" type="button" data-prompt="Find the most complex file in this codebase and summarize what it does.">Find the most complex file</button>' +
  "</div>";

// ---- light, safe markdown: code fences + inline code, everything else text ----
function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // fenced code block — optional leading language token on the first line
      let lang = "";
      let code = part;
      const nl = part.indexOf("\n");
      if (nl >= 0) {
        const first = part.slice(0, nl);
        if (first.length <= 20 && /^[A-Za-z0-9+#._-]*$/.test(first)) {
          lang = first;
          code = part.slice(nl + 1);
        }
      }
      frag.appendChild(codeCard(code, lang));
    } else if (part) {
      // inline `code` within plain text
      part.split(/(`[^`]+`)/).forEach((seg) => {
        if (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1) {
          const c = document.createElement("code");
          c.className = "inline-code";
          c.textContent = seg.slice(1, -1);
          frag.appendChild(c);
        } else if (seg) {
          frag.appendChild(document.createTextNode(seg));
        }
      });
    }
  });
  return frag;
}

// A monospace code card with a header (language label + copy affordance).
function codeCard(code, lang) {
  const card = document.createElement("div");
  card.className = "code-card";
  const head = document.createElement("div");
  head.className = "code-head";
  const label = document.createElement("span");
  label.className = "code-lang";
  label.textContent = lang || "code";
  const copy = document.createElement("button");
  copy.className = "code-copy";
  copy.type = "button";
  copy.textContent = "Copy";
  head.append(label, copy);
  const pre = document.createElement("pre");
  const c = document.createElement("code");
  c.textContent = code;
  pre.appendChild(c);
  card.append(head, pre);
  return card;
}

function addRow(role) {
  // Remove whichever empty-state hero is currently shown (static or re-rendered).
  messagesEl.querySelector(".empty")?.remove();
  const row = document.createElement("div");
  row.className = `row ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = role === "user" ? "" : "A"; // user avatar drawn in CSS

  const col = document.createElement("div");
  col.className = "msg-col";
  const name = document.createElement("div");
  name.className = "msg-name";
  name.textContent = role === "user" ? "You" : "Athene";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  col.append(name, bubble);

  row.append(avatar, col);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function setBubble(bubble, text, withCursor) {
  bubble.textContent = "";
  bubble.appendChild(renderMarkdown(text));
  if (withCursor) {
    const cur = document.createElement("span");
    cur.className = "cursor";
    bubble.appendChild(cur);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// A tool call from the agent (read/edit/bash/…), rendered as a compact chip.
const TOOL_VERBS = {
  read: "Read",
  read_file: "Read",
  edit: "Edit",
  multi_edit: "Edit",
  write: "Write",
  write_file: "Write",
  bash: "Run",
  shell: "Run",
  run: "Run",
  grep: "Search",
  search: "Search",
  search_code: "Search",
  glob: "Find",
  ls: "List",
  list: "List",
  task: "Task",
  todo: "Plan",
  plan: "Plan",
  web: "Fetch",
  fetch: "Fetch",
  web_fetch: "Fetch",
};
function toolActivity(name) {
  const raw = String(name || "tool");
  const verb = TOOL_VERBS[raw.toLowerCase()];
  const el = document.createElement("div");
  el.className = "activity";
  const dot = document.createElement("span");
  dot.className = "activity-dot";
  dot.setAttribute("aria-hidden", "true");
  el.appendChild(dot);
  if (verb) {
    const b = document.createElement("span");
    b.className = "activity-verb";
    b.textContent = verb;
    el.appendChild(b);
  }
  const code = document.createElement("span");
  code.className = "activity-name";
  code.textContent = raw;
  el.appendChild(code);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function statusLine(text, kind) {
  const s = document.createElement("div");
  s.className = kind ? `status status-${kind}` : "status";
  s.textContent = text;
  messagesEl.appendChild(s);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function send() {
  const text = inputEl.value.trim();
  if (!text || streaming || !api) return;
  history.push({ role: "user", content: text });
  addRow("user").textContent = text;
  inputEl.value = "";
  autogrow();

  streaming = true;
  sendEl.disabled = true;
  let acc = "";
  current = addRow("assistant");
  setBubble(current, "", true);
  api.chat(history, modeEl.value);
  // chunk/done/error handlers (registered once below) drive `current`/`acc`.
  window.__acc = () => acc;
  window.__pushAcc = (d) => {
    acc += d;
    setBubble(current, acc, true);
  };
  window.__finishAcc = () => {
    setBubble(current, acc, false);
    history.push({ role: "assistant", content: acc });
    streaming = false;
    sendEl.disabled = false;
    current = null;
    saveActive();
  };
}

function autogrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}

// ---- threads ----
function showEmpty() {
  const e = document.createElement("div");
  e.className = "empty";
  e.innerHTML = EMPTY_INNER;
  messagesEl.appendChild(e);
}
function renderThreads() {
  const ul = $("threads");
  ul.innerHTML = "";
  for (const t of threads) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = t.title || "New chat";
    if (t.id === activeId) b.className = "active";
    b.onclick = () => loadThread(t.id);
    li.appendChild(b);
    ul.appendChild(li);
  }
}
function renderMessages() {
  messagesEl.innerHTML = "";
  if (history.length === 0) {
    showEmpty();
    return;
  }
  for (const m of history) {
    const bubble = addRow(m.role);
    if (m.role === "user") bubble.textContent = m.content;
    else setBubble(bubble, m.content, false);
  }
}
function newChat() {
  if (streaming) return;
  const t = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: "", messages: [] };
  threads.unshift(t);
  activeId = t.id;
  history = [];
  messagesEl.innerHTML = "";
  showEmpty();
  renderThreads();
  inputEl.focus();
}
function loadThread(id) {
  if (streaming) return;
  const t = threads.find((x) => x.id === id);
  if (!t) return;
  activeId = id;
  history = t.messages.slice();
  renderMessages();
  renderThreads();
}
function saveActive() {
  let t = threads.find((x) => x.id === activeId);
  if (!t) {
    t = { id: activeId || Date.now().toString(36), title: "", messages: [] };
    threads.unshift(t);
    activeId = t.id;
  }
  t.messages = history.slice();
  if (!t.title && history[0]) t.title = history[0].content.slice(0, 40);
  persistThreads();
  renderThreads();
}

// ---- wire up ----
if (api) {
  api.onChunk((d) => window.__pushAcc && window.__pushAcc(d));
  api.onTool((name) => toolActivity(name));
  api.onDone((info) => {
    window.__finishAcc && window.__finishAcc();
    if (info?.model) engineEl.textContent = "via " + info.model;
  });
  api.onError((msg) => {
    if (current) {
      current.classList.add("bubble-error");
      setBubble(current, msg, false);
    } else {
      statusLine(msg, "error");
    }
    streaming = false;
    sendEl.disabled = false;
    current = null;
  });
  api.onStatus((msg) => statusLine(msg));

  const enginePill = engineEl.closest(".engine-pill");
  let needsKey = false; // last-known: no model key set anywhere

  // Show the real Athene engine (serve child) status; fall back to naming the
  // direct engines if the agent server didn't come up. Returns true when ready.
  const showEngine = async () => {
    try {
      const e = await api.getEngine();
      needsKey = !!e?.needsKey;
      if (e?.ready) {
        engineEl.textContent = `Athene agent, ${e.writable ? "writable" : "read-only"}`;
        engineEl.title = (e.engines && e.engines[0]) || "engine";
        enginePill?.classList.add("online");
        return true;
      }
      enginePill?.classList.remove("online");
      if (needsKey) engineEl.textContent = "no key — click Key to add one";
    } catch {
      /* fall through */
    }
    return false;
  };
  const pollEngine = () =>
    showEngine().then(async (ok) => {
      if (ok) return;
      // Engine still starting / needs a key — retry briefly, then show status.
      let tries = 0;
      const iv = setInterval(async () => {
        if ((await showEngine()) || ++tries > 10) {
          clearInterval(iv);
          if (tries > 10 && !needsKey) {
            const { ollama, cloudKeys } = await api.models();
            const bits = [];
            if (ollama?.length) bits.push(`${ollama.length} local`);
            if (cloudKeys?.length) bits.push(`${cloudKeys.length} cloud`);
            engineEl.textContent = bits.length
              ? "agent down — " + bits.join(", ") + " direct"
              : "no engine — click Key or start Ollama";
          }
        }
      }, 800);
    });
  pollEngine();

  // ---- BYO-key onboarding overlay ----
  const overlay = $("onboarding");
  const provEl = $("key-provider");
  const keyEl = $("key-input");
  const saveEl = $("key-save");
  const cancelEl = $("key-cancel");
  const getKeyEl = $("get-key");
  const msgEl = $("onboarding-msg");
  const settingsEl = $("settings");

  // provider → { where to get a free key, input placeholder }
  const PROVIDERS = {
    NVIDIA_API_KEY: { url: "https://build.nvidia.com", label: "NVIDIA NIM", ph: "nvapi-…" },
    GROQ_API_KEY: { url: "https://console.groq.com/keys", label: "Groq", ph: "gsk_…" },
    CEREBRAS_API_KEY: { url: "https://cloud.cerebras.ai", label: "Cerebras", ph: "csk-…" },
    OPENROUTER_API_KEY: { url: "https://openrouter.ai/keys", label: "OpenRouter", ph: "sk-or-…" },
    GEMINI_API_KEY: { url: "https://aistudio.google.com/app/apikey", label: "Gemini", ph: "AIza…" },
    HF_TOKEN: { url: "https://huggingface.co/settings/tokens", label: "Hugging Face", ph: "hf_…" },
  };
  const syncProvider = () => {
    const p = PROVIDERS[provEl.value] || PROVIDERS.NVIDIA_API_KEY;
    keyEl.placeholder = p.ph;
    getKeyEl.textContent = `Get a free ${p.label} key →`;
  };
  const setMsg = (text, kind) => {
    msgEl.textContent = text || "";
    msgEl.className = "onboarding-msg" + (kind ? " is-" + kind : "");
  };
  const openOnboarding = (firstRun) => {
    overlay.hidden = false;
    cancelEl.hidden = !!firstRun; // no "cancel" on first run (no key yet to keep)
    setMsg("");
    syncProvider();
    keyEl.value = "";
    keyEl.focus();
  };
  const closeOnboarding = () => {
    overlay.hidden = true;
  };

  provEl.addEventListener("change", syncProvider);
  getKeyEl.addEventListener("click", (e) => {
    e.preventDefault();
    const p = PROVIDERS[provEl.value] || PROVIDERS.NVIDIA_API_KEY;
    api.openExternal(p.url);
  });
  settingsEl.addEventListener("click", async () => {
    let firstRun = false;
    try {
      const s = await api.configStatus();
      firstRun = !s?.hasKey;
    } catch {
      /* ignore */
    }
    openOnboarding(firstRun);
  });
  cancelEl.addEventListener("click", closeOnboarding);
  keyEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveEl.click();
    }
  });
  saveEl.addEventListener("click", async () => {
    const value = keyEl.value.trim();
    if (!value) {
      setMsg("Paste a key first.", "error");
      keyEl.focus();
      return;
    }
    saveEl.disabled = true;
    setMsg("Saving & starting the engine…", "");
    try {
      const r = await api.saveKey(provEl.value, value);
      if (!r?.ok) {
        setMsg(r?.error || "Could not save the key.", "error");
        saveEl.disabled = false;
        return;
      }
      if (r.engineReady) {
        setMsg("Engine ready — you're set.", "ok");
        setTimeout(closeOnboarding, 650);
      } else if (r.needsKey) {
        setMsg("Key didn't register — check it and try again.", "error");
      } else {
        // saved; engine still spinning up — close and let the pill poll it.
        setMsg("Saved. Starting…", "ok");
        setTimeout(closeOnboarding, 650);
      }
      pollEngine();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e), "error");
    } finally {
      saveEl.disabled = false;
    }
  });

  // First run: no key set anywhere → show onboarding immediately.
  (async () => {
    try {
      const s = await api.configStatus();
      if (!s?.hasKey) openOnboarding(true);
    } catch {
      /* ignore */
    }
  })();
} else {
  engineEl.textContent = "preview (run `npm start` for the full app)";
  sendEl.disabled = true;
}

// Delegated clicks inside the message area: example-prompt chips + code copy.
messagesEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".prompt-chip");
  if (chip) {
    inputEl.value = chip.dataset.prompt || chip.textContent.trim();
    autogrow();
    inputEl.focus();
    return;
  }
  const copyBtn = e.target.closest(".code-copy");
  if (copyBtn) {
    const codeEl = copyBtn.closest(".code-card")?.querySelector("pre code");
    const txt = codeEl ? codeEl.textContent : "";
    try {
      navigator.clipboard?.writeText(txt);
      copyBtn.textContent = "Copied";
      setTimeout(() => {
        copyBtn.textContent = "Copy";
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  }
});

sendEl.addEventListener("click", send);
inputEl.addEventListener("input", autogrow);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$("new").addEventListener("click", newChat);

// startup: resume the most recent thread, or start a fresh one.
renderThreads();
if (threads.length && threads[0].messages.length) loadThread(threads[0].id);
else newChat();
