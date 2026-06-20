# 🖥️ Athene Desktop

A free, **local-first** AI chat app on the open Athene engine. Runs your local
**Ollama** models when available (private + offline), and falls back to free
frontier models (NVIDIA NIM, Groq, Cerebras, OpenRouter) otherwise — the same
engine as [Athene CLI](https://github.com/palmzamak2547/athene-cli) and
[Athene Design](https://github.com/palmzamak2547/athene-design).

## Why

The desktop AI clients (Jan, LM Studio, Open WebUI) are great but model-acquisition
and the agent story are clunky. Athene Desktop's bet: **local-first by default**,
the free-model failover built in, and (next) the same sandboxed agent loop as the
CLI — so the desktop app *does* things, not just chats.

## Run it

```bash
npm install
# Optional local models — install Ollama + pull one:
#   ollama pull qwen2.5:7b
# Optional free cloud fallback:
export NVIDIA_API_KEY=nvapi-...        # free at build.nvidia.com
npm start
```

The mode selector picks **Auto** (local → cloud), **Local only** (Ollama), or
**Cloud only** (free providers).

## Architecture

- **main.js** (Electron, ESM) — owns the window + the model calls. A `chat`
  message streams tokens back to the renderer with failover across engines.
- **preload.cjs** — the only bridge: a tiny `window.athene` surface
  (`chat` / `onChunk` / `onDone` / `onError` / `models`). `contextIsolation`
  on, `nodeIntegration` off — no Node access leaks to the page.
- **lib/providers.js** — the free-model engine (shared shape with the CLI) +
  local Ollama via its OpenAI-compatible endpoint.
- **renderer/** — a dependency-free chat UI. Model output is rendered with
  `textContent` / DOM nodes, never `innerHTML` (XSS-safe). It feature-detects
  `window.athene`, so the page also renders in a plain browser for development.

## Status

**Phase 0** — local-first streaming chat with engine failover; clean,
XSS-safe UI; verified rendering + a syntax-clean main process.

**Next:** the agent loop + tools (the CLI's engine, sandboxed) so the desktop
app can read/edit files and run tasks; a thread sidebar; a model picker with
download UX; MCP tools.

MIT licensed.
