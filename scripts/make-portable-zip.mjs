// scripts/make-portable-zip.mjs
//
// Produces a downloadable, installer-free portable ZIP of the packaged app by
// zipping dist/win-unpacked/ directly. This is the reliable fallback for the
// known electron-builder winCodeSign symlink limitation on Windows Dev Mode —
// the --dir output assembles fine; we just zip it ourselves.
//
// Prefers the `7za` binary electron-builder already ships (correct forward-slash
// zip entries, portable across all extractors); falls back to PowerShell
// Compress-Archive if 7za isn't present.
//
// Output: dist/Athene-win-x64-portable.zip
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const unpacked = path.join(appRoot, "dist", "win-unpacked");
const outZip = path.join(appRoot, "dist", "Athene-win-x64-portable.zip");

if (!fs.existsSync(path.join(unpacked, "Athene.exe"))) {
  throw new Error(`No packaged app at ${unpacked} (run \`npm run pack\` first).`);
}
fs.rmSync(outZip, { force: true });

const sevenZip = path.join(appRoot, "node_modules", "7zip-bin", "win", "x64", "7za.exe");

let made = false;
if (fs.existsSync(sevenZip)) {
  // 7za: archive the CONTENTS of win-unpacked at the zip root, forward slashes.
  const r = spawnSync(sevenZip, ["a", "-tzip", "-mx=7", "-bd", outZip, "*"], {
    cwd: unpacked,
    stdio: "inherit",
  });
  made = r.status === 0 && fs.existsSync(outZip);
}
if (!made) {
  // Fallback — PowerShell Compress-Archive (always available on Windows).
  const psScript = `Compress-Archive -Path '${unpacked}\\*' -DestinationPath '${outZip}' -CompressionLevel Optimal -Force`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
    stdio: "inherit",
  });
  if (r.status !== 0 || !fs.existsSync(outZip)) throw new Error(`zip failed (exit ${r.status}).`);
}

const bytes = fs.statSync(outZip).size;
process.stdout.write(`[portable-zip] ${outZip} (${(bytes / 1024 / 1024).toFixed(1)} MB)\n`);
