// scripts/before-pack.cjs — electron-builder `beforePack` hook (CommonJS).
//
// Guarantees the vendored engine exists before packaging. If vendor/athene is
// missing (e.g. a bare `electron-builder` invocation), it runs prepare-engine
// so the shipped app is never silently missing its engine. Idempotent + fast
// when the engine is already vendored.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

exports.default = async function beforePack(context) {
  const appRoot = context.packager.projectDir;
  const cli = path.join(appRoot, "vendor", "athene", "dist", "cli.js");
  if (fs.existsSync(cli)) {
    console.log("[before-pack] vendored engine present:", cli);
    return;
  }
  console.log("[before-pack] vendored engine missing — running prepare-engine …");
  const r = spawnSync(process.execPath, [path.join(appRoot, "scripts", "prepare-engine.mjs")], {
    cwd: appRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("prepare-engine failed; cannot package without the engine.");
};
