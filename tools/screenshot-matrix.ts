// Foundry screenshot matrix: render every page of a build at the 4 canonical
// widths plus key interaction states. Feeds the visual-truth gate (§8.2) and
// the critics.
//
// Usage: npx tsx tools/screenshot-matrix.ts <base-url> <out-dir> [--pages /,/about,/services]
// Without --pages, does a shallow same-origin crawl (≤ 25 pages) of the build.

import { chromium } from "playwright";
import { join } from "node:path";
import { ensureDir, writeJson, slugifyUrl, sameOrigin, normalizeUrl, isHtmlLink, LAUNCH_OPTS, TLS_CTX } from "./lib.js";

const [baseUrl, outDir] = process.argv.slice(2);
if (!baseUrl || !outDir) {
  console.error("usage: tsx tools/screenshot-matrix.ts <base-url> <out-dir> [--pages /a,/b]");
  process.exit(1);
}
const pagesArg = process.argv.indexOf("--pages");

const WIDTHS = [320, 768, 1280, 1920] as const;
const HEIGHTS: Record<number, number> = { 320: 640, 768: 1024, 1280: 800, 1920: 1080 };

async function discoverPages(): Promise<string[]> {
  if (pagesArg > -1) {
    return process.argv[pagesArg + 1].split(",").map((p) => new URL(p, baseUrl).href);
  }
  const browser = await chromium.launch(LAUNCH_OPTS);
  const page = await browser.newPage(TLS_CTX);
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>([normalizeUrl(baseUrl)]);
  const queue = [...seen];
  const found: string[] = [];
  while (queue.length && found.length < 25) {
    const url = queue.shift()!;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      found.push(url);
      const hrefs = await page.locator("a[href]").evaluateAll(
        (els) => els.map((e) => (e as HTMLAnchorElement).href));
      for (const h of hrefs) {
        try {
          const n = normalizeUrl(h);
          if (sameOrigin(n, origin) && isHtmlLink(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
        } catch { /* ignore */ }
      }
    } catch { /* unreachable page is the audit's problem, not the matrix's */ }
  }
  await browser.close();
  return found;
}

async function main() {
  const urls = await discoverPages();
  ensureDir(outDir);
  const browser = await chromium.launch(LAUNCH_OPTS);
  const manifest: { url: string; slug: string; shots: string[]; consoleErrors: string[] }[] = [];

  for (const url of urls) {
    const slug = slugifyUrl(url);
    const shots: string[] = [];
    const consoleErrors: string[] = [];

    for (const width of WIDTHS) {
      const ctx = await browser.newContext({
        ...TLS_CTX,
        viewport: { width, height: HEIGHTS[width] },
        deviceScaleFactor: width <= 768 ? 2 : 1,
        hasTouch: width <= 768,
      });
      const page = await ctx.newPage();
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning") consoleErrors.push(`[${width}] ${m.type()}: ${m.text()}`);
      });
      page.on("pageerror", (e) => consoleErrors.push(`[${width}] pageerror: ${e.message}`));

      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(400); // let entrance animation settle

        const base = `${slug}.${width}`;
        await page.screenshot({ path: join(outDir, `${base}.png`), fullPage: true });
        shots.push(`${base}.png`);

        // Interaction states (best-effort, never fatal)
        if (width <= 768) {
          const toggle = page.locator(
            'button[aria-label*="menu" i], button[aria-expanded], [class*="hamburger" i], [class*="menu-toggle" i], nav button',
          ).first();
          if (await toggle.isVisible().catch(() => false)) {
            await toggle.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(500);
            await page.screenshot({ path: join(outDir, `${base}.nav-open.png`) });
            shots.push(`${base}.nav-open.png`);
          }
        }
        const field = page.locator("input:visible, textarea:visible").first();
        if (await field.isVisible().catch(() => false)) {
          await field.focus().catch(() => {});
          await page.screenshot({ path: join(outDir, `${base}.form-focus.png`) });
          shots.push(`${base}.form-focus.png`);
        }
      } catch (e) {
        consoleErrors.push(`[${width}] capture failed: ${(e as Error).message.slice(0, 120)}`);
      }
      await ctx.close();
    }
    manifest.push({ url, slug, shots, consoleErrors });
    console.log(`matrix: ${slug} → ${shots.length} shots, ${consoleErrors.length} console issues`);
  }

  await browser.close();
  writeJson(join(outDir, "matrix-manifest.json"), {
    baseUrl, generatedAt: new Date().toISOString(), widths: WIDTHS, pages: manifest,
    totalConsoleErrors: manifest.reduce((s, p) => s + p.consoleErrors.length, 0),
  });
  console.log(`done: ${manifest.length} pages × ${WIDTHS.length} widths → ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
