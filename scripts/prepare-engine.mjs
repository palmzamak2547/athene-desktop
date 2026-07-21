// scripts/prepare-engine.mjs
//
// Vendors the Athene CLI engine INTO this app so the packaged desktop app ships
// with its own engine and needs NO C:/dev/athene path at runtime.
//
// What it produces:  vendor/athene/
//   ├─ dist/cli.js          (the built engine — `athene serve` lives here)
//   ├─ package.json         (trimmed: production deps only, type:module, bin)
//   └─ node_modules/…       (the engine's PRODUCTION deps, self-contained)
//
// electron-builder then copies vendor/athene → resources/athene (extraResources),
// so the shipped app has resources/athene/dist/cli.js on real disk (outside the
// asar) with its own node_modules next to it — spawnable as a plain Node script.
//
// Engine SOURCE is a BUILD-TIME concern only (the public downloads the prebuilt
// zip). Source dir = $ATHENE_SRC or the dev default C:/dev/athene.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const SRC = process.env.ATHENE_SRC || "C:/dev/athene";
const vendorDir = path.join(appRoot, "vendor", "athene");
const distSrc = path.join(SRC, "dist", "cli.js");
const srcPkgPath = path.join(SRC, "package.json");

const log = (m) => process.stdout.write(`[prepare-engine] ${m}\n`);

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}

// 1) Ensure the engine is built at the source repo.
if (!fs.existsSync(distSrc)) {
  if (!fs.existsSync(srcPkgPath)) {
    throw new Error(
      `Athene engine source not found at ${SRC}. Set ATHENE_SRC to the athene-cli checkout.`,
    );
  }
  log(`engine dist missing — building it in ${SRC} …`);
  run("npm", ["run", "build"], SRC);
}
if (!fs.existsSync(distSrc)) throw new Error(`Build did not produce ${distSrc}`);

// 2) Read the engine's real package.json → keep ONLY what the runtime needs.
const srcPkg = JSON.parse(fs.readFileSync(srcPkgPath, "utf8"));
const enginePkg = {
  name: srcPkg.name,
  version: srcPkg.version,
  private: true,
  type: srcPkg.type || "module",
  bin: srcPkg.bin,
  // production deps only — no devDeps, no scripts (avoids prepublishOnly etc.)
  dependencies: srcPkg.dependencies || {},
};

// 3) (Re)create vendor/athene with dist + trimmed package.json.
fs.rmSync(vendorDir, { recursive: true, force: true });
fs.mkdirSync(path.join(vendorDir, "dist"), { recursive: true });
fs.copyFileSync(distSrc, path.join(vendorDir, "dist", "cli.js"));
fs.writeFileSync(path.join(vendorDir, "package.json"), JSON.stringify(enginePkg, null, 2) + "\n");
log(`copied dist/cli.js + package.json (v${enginePkg.version}) → vendor/athene`);

// 4) Install the engine's PRODUCTION deps into vendor/athene/node_modules.
log("installing engine production deps (npm install --omit=dev) …");
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], vendorDir);

// 5) Verify the result is self-contained.
const problems = [];
const cliOut = path.join(vendorDir, "dist", "cli.js");
if (!fs.existsSync(cliOut)) problems.push("vendor/athene/dist/cli.js missing");
for (const dep of Object.keys(enginePkg.dependencies)) {
  if (!fs.existsSync(path.join(vendorDir, "node_modules", dep))) {
    problems.push(`node_modules/${dep} missing`);
  }
}
if (problems.length) throw new Error("prepare-engine verify FAILED:\n  - " + problems.join("\n  - "));

const depCount = fs.readdirSync(path.join(vendorDir, "node_modules")).filter((n) => !n.startsWith(".")).length;
log(`OK — vendor/athene self-contained: dist/cli.js + ${depCount} node_modules entries.`);
