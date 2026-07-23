// lib/config.js
//
// Tiny, dependency-free config store for the user's BYO model key. Persisted as
// a small JSON file in Electron's userData dir (per-user, per-machine) — NEVER
// in the repo or the app bundle. The key is a FREE model key the user brings
// (NVIDIA NIM / Groq / Cerebras / OpenRouter / Gemini / HF), stored locally.
//
// Shape on disk (athene-config.json):
//   { "keys": { "NVIDIA_API_KEY": "nvapi-…", "GROQ_API_KEY": "gsk_…" } }
import fs from "node:fs";
import path from "node:path";

// The env var each provider reads (must match the engine's src/providers.ts).
export const KEY_ENVS = [
  "NVIDIA_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "HF_TOKEN",
];

function configPath(userDataDir) {
  return path.join(userDataDir, "athene-config.json");
}

// Read the stored config; never throws (returns {} on any problem).
export function loadConfig(userDataDir) {
  try {
    const raw = fs.readFileSync(configPath(userDataDir), "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

// The keys stored on disk (env is layered on top separately, in getEffectiveKeys).
export function storedKeys(userDataDir) {
  const cfg = loadConfig(userDataDir);
  const keys = cfg.keys && typeof cfg.keys === "object" ? cfg.keys : {};
  const out = {};
  for (const k of KEY_ENVS) {
    if (typeof keys[k] === "string" && keys[k].trim()) out[k] = keys[k].trim();
  }
  return out;
}

// Effective keys the engine should see = env (dev / power users) OVERLAID with
// stored keys (a stored key wins over a blank env; env wins if the user hasn't
// stored one). Returns { KEY_ENV: value }.
export function getEffectiveKeys(userDataDir) {
  const out = {};
  for (const k of KEY_ENVS) {
    const env = typeof process.env[k] === "string" ? process.env[k].trim() : "";
    if (env) out[k] = env;
  }
  Object.assign(out, storedKeys(userDataDir)); // stored keys take precedence
  return out;
}

export function hasAnyKey(userDataDir) {
  return Object.keys(getEffectiveKeys(userDataDir)).length > 0;
}

// Which providers are configured, and from where — WITHOUT leaking the secret.
export function keyStatus(userDataDir) {
  const stored = storedKeys(userDataDir);
  const providers = [];
  for (const k of KEY_ENVS) {
    const env = typeof process.env[k] === "string" && process.env[k].trim() ? "env" : "";
    const src = stored[k] ? "stored" : env; // stored wins
    if (src) providers.push({ env: k, source: src });
  }
  return { hasKey: providers.length > 0, providers };
}

// Save ONE provider key (validated: known env + non-empty). Atomic write.
export function saveKey(userDataDir, envName, value) {
  if (!KEY_ENVS.includes(envName)) throw new Error(`unknown key env: ${envName}`);
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new Error("empty key");
  const cfg = loadConfig(userDataDir);
  cfg.keys = cfg.keys && typeof cfg.keys === "object" ? cfg.keys : {};
  cfg.keys[envName] = v;
  writeAtomic(userDataDir, cfg);
  return keyStatus(userDataDir);
}

// Remove all stored keys (env keys, if any, remain — they're not ours to clear).
export function clearStoredKeys(userDataDir) {
  const cfg = loadConfig(userDataDir);
  cfg.keys = {};
  writeAtomic(userDataDir, cfg);
  return keyStatus(userDataDir);
}

function writeAtomic(userDataDir, cfg) {
  const p = configPath(userDataDir);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}
