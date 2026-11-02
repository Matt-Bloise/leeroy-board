// Display-size image pipeline. Node 22, no npm dependencies.
//
//   node tools/images.mjs            report what would be made (dry run)
//   node tools/images.mjs --write    write the WebP and AVIF variants next to the originals
//   add --only <substring> to limit to paths containing it, --root <dir> to run against another tree
//
// Encoders (already installed on the dev and CI images, nothing is added to the repo):
//   WebP: ImageMagick `convert` (libwebp)      AVIF: `ffmpeg` with libaom-av1 (ImageMagick here can only read AVIF)
// A missing encoder is reported and that format is skipped; the run never fails because of it.
//
// What it makes, for every png, jpg and webp under img/ (originals are never touched, moved or deleted):
//   <name>.w<N>.webp and <name>.w<N>.avif, where N is the width the image is actually shown at times 2 (a
//   2x display), capped at the original width (never upscaled). The display width is read from the source:
//     css/*.css and scenes/*.css   `url(img/x) ... / Npx`, `background-size: Npx`, or `width: Npx` in the same rule
//     index.html, js/, scenes/*.js `width="N"` / `width: N` within 240 characters after the image path
//   The largest width found for an image wins. An image with no width found keeps its own width and is only
//   re-encoded. A variant is written only if it is at least 10% smaller than the original file.
//   Full-bleed art that must stay sharp at several densities is listed in LADDER and gets one variant per width.
//   AVIF is skipped for images with an alpha channel (the ffmpeg AVIF muxer cannot write the alpha plane);
//   those get WebP only, which keeps alpha.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.resolve(opt("--root") || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const WRITE = flag("--write"), ONLY = opt("--only");
const DPR = 2, MIN_SAVING = 0.9, WEBP_Q = 78, AVIF_CRF = 34;
/* explicit width ladders (px) for full-bleed art: a 390 px phone at 3x needs about 1266 px */
const LADDER = { "img/tavern-hero.jpg": [640, 1200, 1672] };

const RASTER = /\.(?:png|jpe?g|webp)$/i, VARIANT = /\.w\d+\.(?:webp|avif)$/i;
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p, out) : out.push(p); } return out; };
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const images = walk(path.join(ROOT, "img")).filter((p) => RASTER.test(p) && !VARIANT.test(p) && (!ONLY || rel(p).includes(ONLY))).sort();

/* ---- display widths from the source ---- */
const widths = new Map();
const note = (img, px) => { if (px > 0 && px < 4000) widths.set(img, Math.max(widths.get(img) || 0, px)); };
const IMGREF = /(?:\.\.\/|\/|\.\/)?(img\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp))/g;
function scanCss(file) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const body = m[1];
    if (!/img\//.test(body)) continue;
    const w = body.match(/(?:^|[;\s])width:\s*(\d+(?:\.\d+)?)px/), bs = body.match(/background-size:\s*(\d+(?:\.\d+)?)px/), sl = body.match(/\)[^;{}]*\/\s*(\d+(?:\.\d+)?)px/);
    const px = Number((sl || bs || w || [])[1]);
    if (!px) continue;
    for (const r of body.matchAll(IMGREF)) note(r[1], px);
  }
}
function scanText(file) {
  const text = fs.readFileSync(file, "utf8");
  for (const r of text.matchAll(IMGREF)) {
    const tail = text.slice(r.index, r.index + r[0].length + 240);
    const m = tail.match(/width["']?\s*[:=]\s*["']?(\d+)/);
    if (m) note(r[1], Number(m[1]));
  }
}
const under = (d, re) => (fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d)).filter((p) => re.test(p)) : []);
for (const f of [...under("css", /\.css$/), ...under("scenes", /\.css$/)]) scanCss(f);
for (const f of [path.join(ROOT, "index.html"), ...under("js", /\.js$/), ...under("scenes", /\.js$/)]) if (fs.existsSync(f)) scanText(f);

/* ---- encoders ---- */
const ok = (cmd, a) => { const r = spawnSync(cmd, a, { encoding: "utf8" }); return !r.error && r.status === 0; };
const CONVERT = ok("convert", ["-version"]);
const FFMPEG = ok("ffmpeg", ["-version"]) && /libaom-av1/.test(spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout || "");
if (!CONVERT) console.log("WARN ImageMagick `convert` not found: nothing can be measured or written");
if (!FFMPEG) console.log("WARN ffmpeg with libaom-av1 not found: AVIF skipped");
const probe = (p) => { const r = spawnSync("convert", [p + "[0]", "-format", "%w %A", "info:"], { encoding: "utf8" }); const [w, a] = (r.stdout || "").trim().split(" "); return { w: +w, alpha: /^(true|blend)$/i.test(a) }; };

let made = 0, skipped = 0, bytesIn = 0, bytesOut = 0; const rows = [];
if (CONVERT) for (const file of images) {
  const key = rel(file), orig = fs.statSync(file).size, { w: iw, alpha } = probe(file);
  if (!iw) continue;
  const disp = widths.get(key), targets = LADDER[key] || [disp ? Math.min(iw, Math.round(disp * DPR)) : iw];
  for (const tw of [...new Set(targets.map((t) => Math.min(iw, t)))]) {
    const stem = file.replace(/\.[^.]+$/, ""), resize = tw < iw ? ["-resize", `${tw}x`] : [];
    const jobs = [];
    if (!(/\.webp$/i.test(file) && !resize.length)) jobs.push(["webp", `${stem}.w${tw}.webp`, (dst) => spawnSync("convert", [file, ...resize, "-quality", String(WEBP_Q), "-define", "webp:method=6", dst])]);
    if (FFMPEG && !alpha) jobs.push(["avif", `${stem}.w${tw}.avif`, (dst) => spawnSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `scale=${tw}:-2`, "-c:v", "libaom-av1", "-still-picture", "1", "-crf", String(AVIF_CRF), "-cpu-used", "6", "-pix_fmt", "yuv420p", dst])]);
    for (const [fmt, dst, run] of jobs) {
      const tmp = `${dst}.tmp.${fmt}`;
      run(tmp);
      const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      if (size && size <= orig * MIN_SAVING) {
        if (WRITE) fs.renameSync(tmp, dst); else fs.rmSync(tmp);
        made++; bytesIn += orig; bytesOut += size; rows.push(`${rel(dst)}  ${size}  (orig ${orig}, shown ${disp ? disp + "px" : "?"})`);
      } else { if (fs.existsSync(tmp)) fs.rmSync(tmp); skipped++; }
    }
  }
}
for (const r of rows) console.log(r);
console.log(`${WRITE ? "wrote" : "would write"} ${made} variants, skipped ${skipped} (not 10% smaller than the original); same sources: ${bytesIn} -> ${bytesOut} bytes`);
