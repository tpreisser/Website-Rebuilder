// Foundry originality check (plan §8.3): is the new build measurably distinct
// from every piece of inspiration material?
//
//   1. Perceptual hash (dHash via sharp): every build screenshot vs. every
//      inspiration screenshot. Similarity ≥ 0.88 = blocking.
//   2. DOM structure: tag-sequence 4-shingle Jaccard between build pages and
//      captured competitor DOM. ≥ 0.60 = blocking (template-level resemblance).
//   3. Copy n-grams: shared 8-word sequences between build copy and competitor
//      copy inventories. Any hit (minus allowlisted phrases) = blocking.
//
// Usage:
//   npx tsx tools/similarity-check.ts <out-file.json> \
//     --build-shots <dir> --inspo-shots <dir> [<dir>...] \
//     [--build-dom <dir>] [--inspo-dom <dir>...] \
//     [--build-copy <file.md>] [--inspo-copy <file.md>...] \
//     [--allow-phrases <file>]   (one phrase per line: brand names, addresses)

import sharp from "sharp";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { writeJson } from "./lib.js";

const THRESHOLDS = { phash: 0.88, dom: 0.6, ngramSize: 8 };

function argList(flag: string): string[] {
  const out: string[] = [];
  let i = process.argv.indexOf(flag);
  if (i === -1) return out;
  for (i += 1; i < process.argv.length && !process.argv[i].startsWith("--"); i++) out.push(process.argv[i]);
  return out;
}
const outFile = process.argv[2];
if (!outFile || outFile.startsWith("--")) {
  console.error("usage: tsx tools/similarity-check.ts <out-file.json> --build-shots <dir> --inspo-shots <dir>... [--build-dom <dir>] [--inspo-dom <dir>...] [--build-copy <md>] [--inspo-copy <md>...]");
  process.exit(1);
}

const filesIn = (dir: string, exts: RegExp): string[] =>
  existsSync(dir) && statSync(dir).isDirectory()
    ? readdirSync(dir).filter((f) => exts.test(f)).map((f) => join(dir, f))
    : [];

// ---- 1. Perceptual hash (dHash 16x16 -> 256-bit) ----------------------------
async function dhash(file: string): Promise<bigint> {
  const W = 17, H = 16;
  const { data } = await sharp(file)
    .resize(W, H, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let hash = 0n;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W - 1; x++) {
      hash <<= 1n;
      if (data[y * W + x] > data[y * W + x + 1]) hash |= 1n;
    }
  return hash;
}
function hashSimilarity(a: bigint, b: bigint): number {
  let diff = a ^ b, dist = 0;
  while (diff) { dist += Number(diff & 1n); diff >>= 1n; }
  return 1 - dist / 256;
}

// ---- 2. DOM structure shingles ----------------------------------------------
function tagSequence(html: string): string[] {
  const tags = [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)[\s>/]/g)].map((m) => m[1].toLowerCase());
  return tags.filter((t) => !["script", "style", "meta", "link", "br", "noscript"].includes(t));
}
function shingleJaccard(a: string[], b: string[], k = 4): number {
  const sh = (seq: string[]) => new Set(Array.from({ length: Math.max(0, seq.length - k + 1) }, (_, i) => seq.slice(i, i + k).join(">")));
  const A = sh(a), B = sh(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const s of A) if (B.has(s)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---- 3. Copy n-grams ---------------------------------------------------------
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
}
function ngramOverlap(buildText: string, inspoText: string, n: number, allow: string[]): string[] {
  const bw = words(buildText), iw = words(inspoText);
  const inspoGrams = new Set(Array.from({ length: Math.max(0, iw.length - n + 1) }, (_, i) => iw.slice(i, i + n).join(" ")));
  const hits = new Set<string>();
  for (let i = 0; i + n <= bw.length; i++) {
    const g = bw.slice(i, i + n).join(" ");
    if (inspoGrams.has(g) && !allow.some((a) => g.includes(a))) hits.add(g);
  }
  return [...hits];
}

async function main() {
  const findings: { check: string; severity: "blocking" | "info"; detail: string }[] = [];

  // 1. screenshots
  const buildShots = argList("--build-shots").flatMap((d) => filesIn(d, /\.png$/i));
  const inspoShots = argList("--inspo-shots").flatMap((d) => filesIn(d, /\.png$/i));
  const buildHashes = new Map<string, bigint>();
  for (const f of buildShots) buildHashes.set(f, await dhash(f));
  let worstVisual = { score: 0, pair: "" };
  for (const inspo of inspoShots) {
    const ih = await dhash(inspo);
    for (const [bf, bh] of buildHashes) {
      const s = hashSimilarity(bh, ih);
      if (s > worstVisual.score) worstVisual = { score: s, pair: `${basename(bf)} vs ${basename(inspo)}` };
      if (s >= THRESHOLDS.phash)
        findings.push({ check: "phash", severity: "blocking", detail: `visual similarity ${s.toFixed(3)} ≥ ${THRESHOLDS.phash}: ${basename(bf)} vs ${basename(inspo)}` });
    }
  }

  // 2. DOM
  const buildDom = argList("--build-dom").flatMap((d) => filesIn(d, /\.html?$/i));
  const inspoDom = argList("--inspo-dom").flatMap((d) => filesIn(d, /\.html?$/i));
  let worstDom = { score: 0, pair: "" };
  for (const bf of buildDom) {
    const bseq = tagSequence(readFileSync(bf, "utf8"));
    for (const inf of inspoDom) {
      const s = shingleJaccard(bseq, tagSequence(readFileSync(inf, "utf8")));
      if (s > worstDom.score) worstDom = { score: s, pair: `${basename(bf)} vs ${basename(inf)}` };
      if (s >= THRESHOLDS.dom)
        findings.push({ check: "dom", severity: "blocking", detail: `DOM-structure similarity ${s.toFixed(3)} ≥ ${THRESHOLDS.dom}: ${basename(bf)} vs ${basename(inf)}` });
    }
  }

  // 3. copy
  const allowFile = argList("--allow-phrases")[0];
  const allow = allowFile && existsSync(allowFile)
    ? readFileSync(allowFile, "utf8").split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean)
    : [];
  const buildCopyFiles = argList("--build-copy").filter(existsSync);
  const inspoCopyFiles = argList("--inspo-copy").filter(existsSync);
  const buildText = buildCopyFiles.map((f) => readFileSync(f, "utf8")).join("\n");
  for (const f of inspoCopyFiles) {
    const hits = ngramOverlap(buildText, readFileSync(f, "utf8"), THRESHOLDS.ngramSize, allow);
    for (const h of hits.slice(0, 25))
      findings.push({ check: "copy", severity: "blocking", detail: `shared ${THRESHOLDS.ngramSize}-gram with ${basename(f)}: "${h}"` });
  }

  const pass = !findings.some((f) => f.severity === "blocking");
  writeJson(outFile, {
    checkedAt: new Date().toISOString(),
    thresholds: THRESHOLDS,
    inputs: {
      buildShots: buildShots.length, inspoShots: inspoShots.length,
      buildDom: buildDom.length, inspoDom: inspoDom.length,
      buildCopyFiles: buildCopyFiles.length, inspoCopyFiles: inspoCopyFiles.length,
    },
    worstVisual, worstDom, pass, findings,
  });
  console.log(pass
    ? `ORIGINALITY: PASS (worst visual ${worstVisual.score.toFixed(3)}, worst DOM ${worstDom.score.toFixed(3)})`
    : `ORIGINALITY: FAIL (${findings.length} findings)`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
