// Installs the pinned card browser (tools/cards/chromium.json) into tools/cards/.chromium/<version>/ and prints the executable's path.
//   node tools/cards/install-chromium.mjs
// Downloads Chrome for Testing's headless shell from Google's public bucket with curl (which honours an HTTPS proxy), refuses it unless the
// size and the SHA-256 match the pin, then unpacks it with unzip. Does nothing when that version is already installed and stamped.
// Linux x64 only: the cards are drawn and checked on ubuntu-24.04 runners, and a browser for another platform would draw other pixels.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PIN = JSON.parse(fs.readFileSync(path.join(HERE, "chromium.json"), "utf8"));
export const INSTALL_DIR = path.join(HERE, ".chromium", PIN.version);
export const EXECUTABLE = path.join(INSTALL_DIR, PIN.executable);
const STAMP = path.join(INSTALL_DIR, "INSTALLED.sha256");

export const installed = () => fs.existsSync(EXECUTABLE) && fs.existsSync(STAMP) && fs.readFileSync(STAMP, "utf8").trim() === PIN.sha256;

export function install() {
  if (installed()) return EXECUTABLE;
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error(`the card browser is pinned for linux x64; this is ${process.platform} ${process.arch}`);
  if (!/^https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\/[0-9.]+\/linux64\/chrome-headless-shell-linux64\.zip$/.test(PIN.url)) throw new Error("tools/cards/chromium.json: unexpected download URL");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leeroy-cards-chromium-"));
  try {
    const zip = path.join(tmp, "chrome-headless-shell.zip");
    execFileSync("curl", ["-fsSL", "--retry", "3", "--retry-delay", "5", "--max-time", "600", "-o", zip, PIN.url], { stdio: ["ignore", "inherit", "inherit"] });
    const bytes = fs.statSync(zip).size;
    if (bytes !== PIN.bytes) throw new Error(`downloaded ${bytes} bytes, the pin says ${PIN.bytes}`);
    const sha = crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
    if (sha !== PIN.sha256) throw new Error(`SHA-256 ${sha} does not match the pin ${PIN.sha256}`);
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    execFileSync("unzip", ["-q", "-o", zip, "-d", INSTALL_DIR], { stdio: ["ignore", "inherit", "inherit"] });
    if (!fs.existsSync(EXECUTABLE)) throw new Error(`the archive has no ${PIN.executable}`);
    fs.writeFileSync(STAMP, `${PIN.sha256}\n`);
    return EXECUTABLE;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  try {
    console.log(install());
  } catch (e) {
    console.error(`cards: could not install the pinned browser: ${e && e.message}`);
    process.exit(1);
  }
}
