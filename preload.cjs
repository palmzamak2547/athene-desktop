// preload.cjs — the only bridge between the sandboxed renderer and the main
// process. Exposes a tiny, safe surface: send a chat, subscribe to streamed
// chunks + tool activity, query the engine. No Node access leaks to the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("athene", {
  // Send a chat turn. messages = [{role, content}].
  // mode = "athene" | "athene-fast" | "athene-deep" (real agent, default)
  //      | "local" (Ollama-direct) | "cloud" (free-cloud direct).
  chat: (messages, mode) => ipcRenderer.send("chat", { messages, mode }),
  // Streamed responses from the agent.
  onChunk: (cb) => ipcRenderer.on("chat:chunk", (_e, t) => cb(t)),
  onTool: (cb) => ipcRenderer.on("chat:tool", (_e, name) => cb(name)),
  onStatus: (cb) => ipcRenderer.on("chat:status", (_e, msg) => cb(msg)),
  onDone: (cb) => ipcRenderer.on("chat:done", (_e, info) => cb(info)),
  onError: (cb) => ipcRenderer.on("chat:error", (_e, msg) => cb(msg)),
  // The real Athene engine: base URL + token + health (the serve child).
  getEngine: () => ipcRenderer.invoke("engine:info"),
  // Which DIRECT engines are available (local Ollama + which cloud keys are set).
  models: () => ipcRenderer.invoke("models"),

  // --- BYO-key config (onboarding + settings) ---
  // Whether a key is set + which providers (never returns the secret value).
  configStatus: () => ipcRenderer.invoke("config:status"),
  // Save one provider key ({env, value}); restarts the engine, returns new status.
  saveKey: (env, value) => ipcRenderer.invoke("config:saveKey", { env, value }),
  // Clear all stored keys; restarts the engine, returns new status.
  clearKeys: () => ipcRenderer.invoke("config:clearKeys"),
  // Open a URL in the system browser (for the "get a free key" link).
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
});
