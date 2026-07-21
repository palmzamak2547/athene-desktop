// main.js — Athene Desktop (Electron main process, ESM).
//
// Owns the window AND the engine. On startup it SPAWNS Athene's headless agent
// server (`athene serve`) as a child process and, by default, routes every chat
// turn through it — so the desktop drives the real Athene agent (tools + free-
// model failover, read-only by default), not a bare chat completion. The old
// direct paths (local Ollama / free cloud) remain as secondary modes.
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamText } from "ai";
import { candidates, ollamaModels } from "./lib/providers.js";
import { resolveAtheneCli, startAtheneServer, streamAtheneChat } from "./lib/engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SYSTEM =
  "You are Athene, a helpful, concise AI assistant running locally in the user's desktop app. Be direct and useful. Use Markdown when it helps.";

// The Athene serve child + its connection info. Populated by startEngine().
let engine = { child: null, baseUrl: "", token: "", health: null, cliPath: null, error: "", writable: false };

// Spawn `athene serve` and wait for it to be healthy. Never throws — on failure
// it records `engine.error`, and the app still runs (the renderer can fall back
// to the Local/Cloud direct modes).
async function startEngine() {
  const cliPath = resolveAtheneCli({
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  engine.cliPath = cliPath;
  if (!cliPath) {
    engine.error =
      "Athene engine not found. Set ATHENE_CLI to the athene-cli dist/cli.js, install it, or bundle it (npm run prepare-engine).";
    console.error("[engine] " + engine.error);
    return;
  }
  // read-only agent by default; ATHENE_DESKTOP_YOLO=1 lets it write (auto-approved).
  const yolo = process.env.ATHENE_DESKTOP_YOLO === "1";
  // The dir the agent inspects/operates on. Read-only unless yolo; home is a safe default.
  const cwd = process.env.ATHENE_PROJECT || app.getPath("home");
  try {
    const started = await startAtheneServer({
      cliPath,
      execPath: process.execPath, // Electron binary…
      runAsNode: true, // …run as Node (works packaged, no system Node needed)
      cwd,
      yolo,
      logger: (m) => process.stdout.write("[athene] " + m + "\n"),
    });
    engine.child = started.child;
    engine.baseUrl = started.baseUrl;
    engine.token = started.token;
    started.child.on("exit", (code) => {
      console.error(`[engine] athene serve exited (code ${code})`);
      engine.health = null;
    });
    engine.health = await started.ready;
    engine.writable = !!engine.health?.writable;
    console.log(
      `[engine] ready at ${engine.baseUrl} (${engine.writable ? "writable" : "read-only"}) engines=${(engine.health?.engines || []).join(", ")}`,
    );
  } catch (e) {
    engine.error = e instanceof Error ? e.message : String(e);
    console.error("[engine] " + engine.error);
  }
}

function stopEngine() {
  try {
    engine.child?.kill();
  } catch {
    /* ignore */
  }
  engine.child = null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#12100e",
    title: "Athene Desktop",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // External links open in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// Engine info for the renderer (base URL + token exposed per the contextBridge;
// the token stays inside the trusted preload/main — the renderer streams through
// IPC, not a direct fetch, because the server rejects browser-origin requests).
ipcMain.handle("engine:info", async () => ({
  ready: !!engine.health,
  baseUrl: engine.baseUrl,
  token: engine.token,
  writable: engine.writable,
  engines: engine.health?.engines || [],
  cliPath: engine.cliPath,
  error: engine.error,
}));

// Which DIRECT engines are available (for the Local/Cloud fallback modes).
ipcMain.handle("models", async () => {
  const ollama = await ollamaModels();
  const cloud = ["NVIDIA_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY"].filter(
    (k) => process.env[k],
  );
  return { ollama, cloudKeys: cloud };
});

// mode → effort for the Athene agent tiers.
function atheneEffort(mode) {
  if (mode === "athene-fast") return "fast";
  if (mode === "athene-deep") return "deep";
  return "balanced";
}

// Stream a chat turn. The renderer listens for chat:chunk / chat:tool /
// chat:status / chat:done / chat:error.
ipcMain.on("chat", async (event, payload) => {
  const send = (ch, data) => {
    if (!event.sender.isDestroyed()) event.sender.send(ch, data);
  };
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const mode = typeof payload?.mode === "string" ? payload.mode : "athene";

  // DEFAULT: the real Athene agent (serve child), streaming text + tool activity.
  if (mode.startsWith("athene")) {
    if (!engine.health) {
      send(
        "chat:error",
        engine.error
          ? `Athene engine unavailable: ${engine.error}  (or pick Local/Cloud in the selector).`
          : "Athene engine is still starting — try again in a moment, or pick Local/Cloud.",
      );
      return;
    }
    try {
      const { model } = await streamAtheneChat({
        baseUrl: engine.baseUrl,
        token: engine.token,
        messages,
        effort: atheneEffort(mode),
        onText: (t) => send("chat:chunk", t),
        onTool: (name) => send("chat:tool", name),
        onStatus: (s) => send("chat:status", s),
      });
      send("chat:done", { model: model || "athene", local: false });
    } catch (e) {
      send("chat:error", e instanceof Error ? e.message : String(e));
    }
    return;
  }

  // SECONDARY: direct model paths (local Ollama / free cloud), no agent/tools.
  const directMode = mode === "local" ? "local" : "cloud";
  let cands;
  try {
    cands = await candidates(directMode);
  } catch {
    cands = [];
  }
  if (cands.length === 0) {
    send(
      "chat:error",
      "No direct model available. Start Ollama (a local model), or set NVIDIA_API_KEY — free at build.nvidia.com.",
    );
    return;
  }
  let lastErr = "";
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    try {
      const result = streamText({ model: c.model, system: SYSTEM, messages, maxRetries: 0 });
      for await (const delta of result.textStream) send("chat:chunk", delta);
      send("chat:done", { model: c.label, local: c.local });
      return;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (i < cands.length - 1) send("chat:status", `${c.label} unavailable — trying the next engine…`);
    }
  }
  send("chat:error", `All engines failed. Last error: ${lastErr}`);
});

app.whenReady().then(() => {
  createWindow();
  // Kick off the engine in the background; the renderer polls engine:info.
  startEngine();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopEngine();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", stopEngine);
app.on("will-quit", stopEngine);
