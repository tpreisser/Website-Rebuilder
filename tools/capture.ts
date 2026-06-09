// Foundry capture: archive a prospect's public site as raw material + evidence.
// Usage: npx tsx tools/capture.ts <start-url> <out-dir> [--max-pages N]
//
// Produces in <out-dir>:
//   screenshots/<slug>.desktop.png / .mobile.png   (full-page)
//   dom/<slug>.html                                 (rendered DOM, for structure diffs)
//   copy-inventory.md                               (all visible text, per page)
//   page-inventory.json  assets-manifest.json  tech-fingerprint.json
//
// Politeness: honors robots.txt, ≤1 req/sec (config), honest user-agent,
// public GET-rendered pages only — never submits forms or attempts logins.

import { chromium, type Page } from "playwright";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig, ensureDir, writeJson, PoliteFetcher,
  slugifyUrl, sameOrigin, normalizeUrl, isHtmlLink,
  LAUNCH_OPTS, TLS_CTX,
} from "./lib.js";

const [startUrl, outDir] = process.argv.slice(2);
if (!startUrl || !outDir) {
  console.error("usage: tsx tools/capture.ts <start-url> <out-dir> [--max-pages N]");
  process.exit(1);
}
const maxPagesArg = process.argv.indexOf("--max-pages");
const cfg = loadConfig();
const MAX_PAGES = maxPagesArg > -1 ? Number(process.argv[maxPagesArg + 1]) : cfg.capture.max_pages;
const UA = cfg.capture.user_agent;

interface PageRecord {
  url: string; slug: string; title: string; status: number | null;
  metaDescription: string | null; h1: string[]; links: string[]; loadMs: number;
}

async function extractVisibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const el = n.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;
        return n.textContent && n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const parts: string[] = [];
    while (walker.nextNode()) parts.push(walker.currentNode.textContent!.trim());
    return parts.join("\n");
  });
}

async function main() {
  const origin = new URL(startUrl).origin;
  const fetcher = new PoliteFetcher(origin, UA, cfg.capture.rate_limit_ms);
  await fetcher.init();

  ensureDir(join(outDir, "screenshots"));
  ensureDir(join(outDir, "dom"));
  const copyPath = join(outDir, "copy-inventory.md");
  writeFileSync(copyPath, `# Copy inventory — ${origin}\nCaptured ${new Date().toISOString()}\n`);

  const browser = await chromium.launch(LAUNCH_OPTS);
  const desktop = await browser.newContext({ ...TLS_CTX, userAgent: UA, viewport: { width: 1280, height: 900 } });
  const mobile = await browser.newContext({
    ...TLS_CTX,
    userAgent: UA, viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });

  const queue: string[] = [normalizeUrl(startUrl)];
  const seen = new Set<string>(queue);
  const pages: PageRecord[] = [];
  const assets = new Map<string, { type: string; pages: string[] }>();
  const scriptSrcs = new Set<string>();
  const generators = new Set<string>();
  const skipped: { url: string; reason: string }[] = [];

  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift()!;
    if (!fetcher.isAllowed(url)) { skipped.push({ url, reason: "robots.txt disallow" }); continue; }
    await fetcher.throttle();

    const slug = slugifyUrl(url);
    const dPage = await desktop.newPage();
    const t0 = Date.now();
    let status: number | null = null;
    try {
      const resp = await dPage.goto(url, { waitUntil: "networkidle", timeout: 45000 });
      status = resp?.status() ?? null;
    } catch (e) {
      skipped.push({ url, reason: `navigation failed: ${(e as Error).message.slice(0, 120)}` });
      await dPage.close();
      continue;
    }
    const loadMs = Date.now() - t0;

    const rec: PageRecord = {
      url, slug, status, loadMs,
      title: await dPage.title(),
      metaDescription: await dPage.locator('meta[name="description"]').first()
        .getAttribute("content").catch(() => null),
      h1: await dPage.locator("h1").allTextContents().catch(() => []),
      links: [],
    };

    // DOM snapshot + visible copy
    writeFileSync(join(outDir, "dom", `${slug}.html`), await dPage.content());
    const text = await extractVisibleText(dPage).catch(() => "");
    appendFileSync(copyPath, `\n\n---\n\n## ${rec.title || slug}\n<${url}>\n\n${text}\n`);

    // Assets + fingerprint signals
    for (const img of await dPage.locator("img[src]").evaluateAll(
      (els) => els.map((e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src))) {
      if (!img) continue;
      const a = assets.get(img) ?? { type: "image", pages: [] };
      a.pages.push(url); assets.set(img, a);
    }
    for (const s of await dPage.locator("script[src]").evaluateAll(
      (els) => els.map((e) => (e as HTMLScriptElement).src))) if (s) scriptSrcs.add(s);
    const gen = await dPage.locator('meta[name="generator"]').first()
      .getAttribute("content").catch(() => null);
    if (gen) generators.add(gen);

    // Same-origin link discovery
    const hrefs = await dPage.locator("a[href]").evaluateAll(
      (els) => els.map((e) => (e as HTMLAnchorElement).href));
    for (const href of hrefs) {
      try {
        const n = normalizeUrl(href);
        rec.links.push(n);
        if (sameOrigin(n, origin) && isHtmlLink(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
      } catch { /* malformed href */ }
    }

    // Screenshots: desktop then mobile (mobile re-navigates → throttle again)
    await dPage.screenshot({ path: join(outDir, "screenshots", `${slug}.desktop.png`), fullPage: true });
    await dPage.close();

    await fetcher.throttle();
    const mPage = await mobile.newPage();
    try {
      await mPage.goto(url, { waitUntil: "networkidle", timeout: 45000 });
      await mPage.screenshot({ path: join(outDir, "screenshots", `${slug}.mobile.png`), fullPage: true });
    } catch { /* desktop capture still stands */ }
    await mPage.close();

    pages.push(rec);
    console.log(`captured ${pages.length}/${MAX_PAGES}: ${url} (${status}, ${loadMs}ms)`);
  }

  await browser.close();

  // Tech fingerprint heuristics
  const sig = [...scriptSrcs].join(" ");
  const fingerprint = {
    generators: [...generators],
    builder:
      /wix\.com|parastorage/.test(sig) ? "Wix" :
      /godaddy|wsimg\.com/.test(sig) ? "GoDaddy" :
      /weebly/.test(sig) ? "Weebly" :
      /squarespace/.test(sig) ? "Squarespace" :
      /wp-content|wp-includes/.test(sig) ? "WordPress" : "unknown/custom",
    https: origin.startsWith("https:"),
    scriptSrcs: [...scriptSrcs].slice(0, 100),
    avgLoadMs: pages.length ? Math.round(pages.reduce((s, p) => s + p.loadMs, 0) / pages.length) : null,
  };

  writeJson(join(outDir, "page-inventory.json"), { origin, capturedAt: new Date().toISOString(), pages, skipped });
  writeJson(join(outDir, "assets-manifest.json"),
    [...assets.entries()].map(([url, a]) => ({ url, type: a.type, pages: [...new Set(a.pages)] })));
  writeJson(join(outDir, "tech-fingerprint.json"), fingerprint);
  console.log(`done: ${pages.length} pages, ${assets.size} assets, ${skipped.length} skipped → ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
