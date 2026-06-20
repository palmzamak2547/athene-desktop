// renderer.js — the chat UI logic. XSS-safe (builds DOM with textContent, never
// innerHTML on model output). Feature-detects window.athene so the page still
// renders in a plain browser (for development/verification), with send disabled.
const api = window.athene;
const $ = (id) => document.getElementById(id);

const messagesEl = $("messages");
const emptyEl = $("empty");
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

// ---- light, safe markdown: code fences + inline code, everything else text ----
function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = part.replace(/^[a-zA-Z0-9]*\n/, "");
      pre.appendChild(code);
      frag.appendChild(pre);
    } else if (part) {
      // inline `code` within plain text
      part.split(/(`[^`]+`)/).forEach((seg) => {
        if (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1) {
          const c = document.createElement("code");
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

function addRow(role) {
  emptyEl?.remove();
  const row = document.createElement("div");
  row.className = `row ${role}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "you" : "A";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  row.append(who, bubble);
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
    cur.innerHTML = "&nbsp;";
    bubble.appendChild(cur);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function statusLine(text) {
  const s = document.createElement("div");
  s.className = "status";
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
  e.innerHTML =
    '<div class="empty-logo">A</div><h1>Ask Athene</h1><p>Runs your local Ollama models when available, free frontier models otherwise. Private by default.</p>';
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
  api.onDone((info) => {
    window.__finishAcc && window.__finishAcc();
    if (info?.model) engineEl.textContent = "via " + info.model;
  });
  api.onError((msg) => {
    if (current) setBubble(current, "⚠️ " + msg, false);
    else statusLine("⚠️ " + msg);
    streaming = false;
    sendEl.disabled = false;
    current = null;
  });
  api.onStatus((msg) => statusLine(msg));
  api.models().then(({ ollama, cloudKeys }) => {
    const bits = [];
    if (ollama?.length) bits.push(`${ollama.length} local`);
    if (cloudKeys?.length) bits.push(`${cloudKeys.length} cloud`);
    engineEl.textContent = bits.length ? bits.join(" · ") + " engine" + (bits.length > 1 ? "s" : "") : "no engine — start Ollama or set NVIDIA_API_KEY";
  });
} else {
  engineEl.textContent = "preview (run `npm start` for the full app)";
  sendEl.disabled = true;
}

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
