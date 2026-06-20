// lib/providers.js
//
// The same free-model engine as the Athene CLI + Design, plus LOCAL models via
// Ollama (its OpenAI-compatible endpoint at 127.0.0.1:11434). "Local first":
// if Ollama is running we try it before any cloud — private + free + offline —
// and fall back to the free cloud providers otherwise.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434/v1";

const CLOUD = {
  nim: { baseURL: "https://integrate.api.nvidia.com/v1", keyEnv: "NVIDIA_API_KEY" },
  groq: { baseURL: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  cerebras: { baseURL: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
};

// Cloud chain, fast-first (same shape as the CLI's balanced tier).
const CLOUD_CHAIN = [
  ["groq", "openai/gpt-oss-120b"],
  ["cerebras", "llama-3.3-70b"],
  ["nim", "meta/llama-3.3-70b-instruct"],
  ["openrouter", "qwen/qwen3-coder:free"],
];

// Is a local Ollama server up? (short timeout; never throws)
export async function ollamaModels() {
  try {
    const res = await fetch(OLLAMA_URL.replace(/\/v1$/, "") + "/api/tags", {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

// Build the ordered candidate list. `mode` = "auto" (local then cloud),
// "local" (Ollama only), or "cloud" (free providers only).
export async function candidates(mode = "auto") {
  const out = [];
  if (mode !== "cloud") {
    const local = await ollamaModels();
    if (local.length) {
      const provider = createOpenAICompatible({ name: "ollama", baseURL: OLLAMA_URL, apiKey: "ollama" });
      // Prefer a small instruct/tool model if present, else the first one.
      const pick =
        local.find((m) => /qwen|llama|gemma|mistral|phi/i.test(m)) ?? local[0];
      out.push({ model: provider(pick), label: `ollama:${pick}`, local: true });
    }
  }
  if (mode !== "local") {
    for (const [provKey, modelId] of CLOUD_CHAIN) {
      const def = CLOUD[provKey];
      const apiKey = process.env[def.keyEnv];
      if (!apiKey) continue;
      const provider = createOpenAICompatible({ name: provKey, baseURL: def.baseURL, apiKey });
      out.push({ model: provider(modelId), label: `${provKey}:${modelId}`, local: false });
    }
  }
  return out;
}
