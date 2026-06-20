// preload.cjs — the only bridge between the sandboxed renderer and the main
// process. Exposes a tiny, safe surface: send a chat, subscribe to streamed
// chunks, query available engines. No Node access leaks to the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("athene", {
  // Send a chat turn. messages = [{role, content}], mode = "auto"|"local"|"cloud".
  chat: (messages, mode) => ipcRenderer.send("chat", { messages, mode }),
  // Streamed responses.
  onChunk: (cb) => ipcRenderer.on("chat:chunk", (_e, t) => cb(t)),
  onDone: (cb) => ipcRenderer.on("chat:done", (_e, info) => cb(info)),
  onError: (cb) => ipcRenderer.on("chat:error", (_e, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on("chat:status", (_e, msg) => cb(msg)),
  // Which engines are available (local Ollama models + which cloud keys are set).
  models: () => ipcRenderer.invoke("models"),
});
