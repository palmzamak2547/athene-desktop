# 🖥️ Athene Desktop

A free AI chat app that drives the real, sandboxed **Athene agent** (tools +
free-model failover, read-only by default) — the same engine as
[Athene CLI](https://github.com/palmzamak2547/athene-cli) and
[Athene Design](https://github.com/palmzamak2547/athene-design). The engine is
**bundled inside the app**, so there's nothing to install: download, paste a
free model key, chat.

## Why

The desktop AI clients (Jan, LM Studio, Open WebUI) are great but model-acquisition
and the agent story are clunky. Athene Desktop's bet: the engine ships **in the
app**, you bring **one free key**, and you get the same sandboxed agent loop as
the CLI — so the desktop app *does* things, not just chats. Optional local
**Ollama** and direct free-cloud modes are still in the engine selector.

## For users (download & run)

1. Download `Athene-win-x64-portable.zip`, unzip anywhere, run `Athene.exe`
   (no installer, no admin, no code-signing).
2. On first launch, paste a **free** model key — get one in a minute at
   [build.nvidia.com](https://build.nvidia.com) (NVIDIA NIM), or use Groq /
   Cerebras / OpenRouter / Gemini / Hugging Face.
3. The key is stored **only on your machine** (in the app's user-data folder).
   Change it anytime via the **Key** button in the sidebar.

## Run from source

```bash
npm install
npm run prepare-engine     # vendors the Athene engine into vendor/athene
npm start                  # paste a free key on first run (or set NVIDIA_API_KEY)
```

`prepare-engine` needs the [athene-cli](https://github.com/palmzamak2547/athene-cli)
checkout (defaults to `C:/dev/athene`; override with `ATHENE_SRC`). It builds the
engine if needed and copies `dist/cli.js` + its production deps into
`vendor/athene/` (gitignored build artifact).

## Build a distributable

```bash
npm run portable   # → dist/win-unpacked/  +  dist/Athene-win-x64-portable.zip
npm run dist       # → NSIS installer + zip (may need code-signing tools)
```

`npm run pack`/`portable` auto-run `prepare-engine` (via the `beforePack` hook),
so the shipped app always contains the engine at `resources/athene/`.

## Architecture

- **main.js** (Electron, ESM) — owns the window + the engine. On startup it
  spawns the bundled Athene agent server (`athene serve`) as a child process
  and streams its SSE output; a `chat` message routes through it (or the direct
  Local/Cloud modes).
- **lib/engine.js** — resolves the bundled engine (packaged:
  `resources/athene/dist/cli.js`; dev: `vendor/athene/…`), spawns it, and
  streams `/v1/chat`. The `C:/dev/athene` path is only a last-ditch dev fallback.
- **lib/config.js** — the BYO-key store. The user's free key lives in a small
  JSON in `app.getPath('userData')` (never in the repo/bundle); it's injected
  into the engine child's env at spawn.
- **preload.cjs** — the only bridge: a tiny `window.athene` surface (`chat`,
  `getEngine`, `configStatus`, `saveKey`, …). `contextIsolation` on,
  `nodeIntegration` off — no Node access leaks to the page.
- **lib/providers.js** — the direct free-model engine (Local Ollama / free cloud
  fallback modes).
- **renderer/** — a dependency-free chat UI + first-run key onboarding overlay.
  Model output is rendered with `textContent` / DOM nodes, never `innerHTML`
  (XSS-safe). It feature-detects `window.athene`.

## Status

**Public-ready** — the engine ships inside the app (no dev path), first-run
BYO-key onboarding, and a portable ZIP that runs on a blank Windows machine.

MIT licensed.
