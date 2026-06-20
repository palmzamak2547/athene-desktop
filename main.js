// main.js — Athene Desktop (Electron main process, ESM).
//
// Creates the window, loads the renderer, and bridges chat to the free-model
// engine: a "chat" message streams tokens back to the renderer with failover
// across local Ollama → free cloud providers.
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamText } from "ai";
import { candidates, ollamaModels } from "./lib/providers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SYSTEM =
  "You are Athene, a helpful, concise AI assistant running locally in the user's desktop app. Be direct and useful. Use Markdown when it helps.";

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0f1115",
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

// Which engines are available, for the renderer's status line.
ipcMain.handle("models", async () => {
  const ollama = await ollamaModels();
  const cloud = ["NVIDIA_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY"].filter(
    (k) => process.env[k],
  );
  return { ollama, cloudKeys: cloud };
});

// Stream a chat completion with failover. The renderer listens for
// chat:chunk / chat:done / chat:error / chat:status.
ipcMain.on("chat", async (event, payload) => {
  const send = (ch, data) => {
    if (!event.sender.isDestroyed()) event.sender.send(ch, data);
  };
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const mode = payload?.mode === "local" || payload?.mode === "cloud" ? payload.mode : "auto";

  let cands;
  try {
    cands = await candidates(mode);
  } catch {
    cands = [];
  }
  if (cands.length === 0) {
    send(
      "chat:error",
      "No model available. Start Ollama (a local model), or set NVIDIA_API_KEY — free at build.nvidia.com.",
    );
    return;
  }

  let lastErr = "";
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    try {
      const result = streamText({
        model: c.model,
        system: SYSTEM,
        messages,
        maxRetries: 0,
      });
      let sawText = false;
      for await (const delta of result.textStream) {
        sawText = true;
        send("chat:chunk", delta);
      }
      send("chat:done", { model: c.label, local: c.local });
      return;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      // Only fail over if we hadn't started emitting text for this model.
      if (i < cands.length - 1) send("chat:status", `${c.label} unavailable — trying the next engine…`);
    }
  }
  send("chat:error", `All engines failed. Last error: ${lastErr}`);
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
