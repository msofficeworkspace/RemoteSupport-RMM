import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const repoRoot = path.resolve(serverRoot, "..");
const sourceDir = path.join(repoRoot, "agent", "publish");
const sourceExe = path.join(sourceDir, "RemoteSupportAgent.exe");
const destinationDir = path.join(serverRoot, "dist", "assets");
const destinationExe = path.join(destinationDir, "RemoteSupportAgent.exe");

if (!fs.existsSync(sourceExe)) {
  throw new Error(
    `Missing ${sourceExe}. Build/publish the Windows agent first.`
  );
}

fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(sourceExe, destinationExe);

const sizeMb = fs.statSync(destinationExe).size / 1024 / 1024;
console.log(`Bundled RemoteSupportAgent.exe (${sizeMb.toFixed(1)} MiB)`);
