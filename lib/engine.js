// lib/engine.js
//
// The REAL Athene engine binding for the desktop app. Instead of talking to a
// model directly, the desktop app now spawns Athene's headless agent server
// (`athene serve`, from the athene-cli repo) as a child process and streams its
// SSE output — so the desktop drives the same sandboxed agent (tools + failover)
// as the CLI, not a bare chat completion.
//
// Server contract (athene-cli src/server.ts):
//   • binds 127.0.0.1 ONLY, token-gated (Authorization: Bearer <token>)
//   • GET  /health  -> { ok, writable, engines[] }
//   • POST /v1/chat -> text/event-stream of {type:"text"|"tool"|"status"|"done"|"error", …}
//   • writes are DENIED unless the server was started with --yolo (read-only agent)
//   • cross-origin requests are rejected — so we call it from the MAIN process
//     (Node fetch sends no Origin header), never from the sandboxed renderer.
import { spawn } from "node:child_process";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Locate the Athene CLI bundle (dist/cli.js). Resolution order:
//   1. ATHENE_CLI env (explicit override)
//   2. bundled with the packaged app  (resources/athene/dist/cli.js)
//   3. dev sibling repo               (<app>/../athene/dist/cli.js)
//   4. a last-ditch dev default       (C:/dev/athene/dist/cli.js)
export function resolveAtheneCli({ resourcesPath, appPath } = {}) {
  const tries = [];
  if (process.env.ATHENE_CLI) tries.push(process.env.ATHENE_CLI);
  if (resourcesPath) tries.push(path.join(resourcesPath, "athene", "dist", "cli.js"));
  if (appPath) tries.push(path.join(appPath, "..", "athene", "dist", "cli.js"));
  tries.push("C:/dev/athene/dist/cli.js");
  for (const c of tries) {
    try {
      if (c && fs.existsSync(c)) return path.resolve(c);
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Ask the OS for a free loopback port.
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Start `athene serve` as a child process.
//   • execPath  — the runtime to launch. In a packaged Electron app pass
//     process.execPath together with ELECTRON_RUN_AS_NODE=1 (set below) so it
//     runs as Node without requiring a system Node install.
//   • We set ATHENE_SERVER_TOKEN ourselves, so we know the token up front and
//     don't have to scrape it from stderr.
// Returns { child, baseUrl, token, port, ready } where `ready` resolves with the
// /health payload once the server is up (or rejects on timeout).
export async function startAtheneServer({
  cliPath,
  execPath,
  extraEnv = {},
  cwd,
  yolo = false,
  runAsNode = false,
  logger = () => {},
}) {
  if (!cliPath) throw new Error("Athene CLI not found (set ATHENE_CLI or install the engine).");
  const port = await freePort();
  const token = crypto.randomBytes(24).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;
  const args = [cliPath, "serve", "--port", String(port)];
  if (yolo) args.push("--yolo");

  const env = {
    ...process.env,
    ...extraEnv,
    ATHENE_SERVER_TOKEN: token,
  };
  if (runAsNode) env.ELECTRON_RUN_AS_NODE = "1";

  const child = spawn(execPath, args, {
    env,
    cwd: cwd || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => logger(String(d).trimEnd()));
  child.stderr.on("data", (d) => logger(String(d).trimEnd()));

  const ready = waitHealthy(baseUrl, token, 20000);
  return { child, baseUrl, token, port, ready };
}

async function waitHealthy(baseUrl, token, ms) {
  const deadline = Date.now() + ms;
  let lastErr = "starting";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(baseUrl + "/health", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) return await r.json();
      lastErr = "HTTP " + r.status;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Athene server did not become healthy: " + lastErr);
}

// Stream one chat turn against /v1/chat, parsing the SSE frames and invoking
// callbacks. Resolves { model } on the "done" event; throws on "error".
export async function streamAtheneChat({
  baseUrl,
  token,
  messages,
  effort = "balanced",
  signal,
  onText,
  onTool,
  onStatus,
}) {
  const res = await fetch(baseUrl + "/v1/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messages, effort }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`serve /v1/chat HTTP ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let doneModel = null;
  let errText = null;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      let obj;
      try {
        obj = JSON.parse(dataLine.slice(6));
      } catch {
        continue;
      }
      switch (obj.type) {
        case "text":
          onText?.(obj.text || "");
          break;
        case "tool":
          onTool?.(obj.name || "tool");
          break;
        case "status":
          onStatus?.(obj.text || "");
          break;
        case "done":
          doneModel = obj.model || null;
          break outer;
        case "error":
          errText = obj.error || "engine error";
          break outer;
      }
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  if (errText) throw new Error(errText);
  return { model: doneModel };
}
