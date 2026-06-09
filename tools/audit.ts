// Foundry technical audit: Lighthouse (mobile+desktop) + axe-core + link check
// + meta/OG completeness, judged against the hard gates in plan §8.1.
//
// Usage: npx tsx tools/audit.ts <base-url> <out-file.json> [--pages /,/about]
//        [--lenient]   (smoke-test mode: run everything, don't gate)

import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import lighthouse from "lighthouse";
import { launch as launchChrome } from "chrome-launcher";
import { writeJson, sameOrigin, normalizeUrl, isHtmlLink, LAUNCH_OPTS, TLS_CTX, IGNORE_TLS } from "./lib.js";

const [baseUrl, outFile] = process.argv.slice(2);
if (!baseUrl || !outFile) {
  console.error("usage: tsx tools/audit.ts <base-url> <out-file.json> [--pages /a,/b] [--lenient]");
  process.exit(1);
}
const pagesArg = process.argv.indexOf("--pages");
const LENIENT = process.argv.includes("--lenient");

// Hard gates (plan §8.1)
const GATES = {
  lighthouse: { performance: 95, accessibility: 100, "best-practices": 100, seo: 100 },
  lcpMs: 1800,
  cls: 0,
  jsBudgetKb: 150,
};

async function discoverPages(): Promise<string[]> {
  if (pagesArg > -1) return process.argv[pagesArg + 1].split(",").map((p) => new URL(p, baseUrl).href);
  const browser = await chromium.launch(LAUNCH_OPTS);
  const page = await browser.newPage(TLS_CTX);
  const origin = new URL(baseUrl).origin;
  const seen = new Set([normalizeUrl(baseUrl)]);
  const queue = [...seen];
  const found: string[] = [];
  while (queue.length && found.length < 25) {
    const url = queue.shift()!;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      found.push(url);
      for (const h of await page.locator("a[href]").evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href))) {
        try {
          const n = normalizeUrl(h);
          if (sameOrigin(n, origin) && isHtmlLink(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  await browser.close();
  return found;
}

async function runLighthouse(url: string, formFactor: "mobile" | "desktop") {
  const chrome = await launchChrome({
    chromeFlags: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
      ...(IGNORE_TLS ? ["--ignore-certificate-errors"] : []),
    ],
  });
  try {
    const result = await lighthouse(url, {
      port: chrome.port,
      output: "json",
      logLevel: "error",
      formFactor,
      screenEmulation: formFactor === "mobile"
        ? { mobile: true, width: 390, height: 844, deviceScaleFactor: 2, disabled: false }
        : { mobile: false, width: 1280, height: 800, deviceScaleFactor: 1, disabled: false },
      throttlingMethod: "simulate",
    });
    const lhr = result!.lhr;
    const scores = Object.fromEntries(
      Object.entries(lhr.categories).map(([k, v]) => [k, Math.round(((v as { score: number | null }).score ?? 0) * 100)]),
    ) as Record<string, number>;
    return {
      scores,
      lcpMs: lhr.audits["largest-contentful-paint"]?.numericValue ?? null,
      cls: lhr.audits["cumulative-layout-shift"]?.numericValue ?? null,
      ttiMs: lhr.audits["interactive"]?.numericValue ?? null,
      jsBytes: lhr.audits["total-byte-weight"]?.details
        ? (lhr.audits["network-requests"]?.details as { items?: { resourceType?: string; transferSize?: number }[] })
            ?.items?.filter((i) => i.resourceType === "Script")
            .reduce((s, i) => s + (i.transferSize ?? 0), 0) ?? null
        : null,
    };
  } finally {
    chrome.kill();
  }
}

async function main() {
  const urls = await discoverPages();
  console.log(`auditing ${urls.length} pages of ${baseUrl}`);
  const origin = new URL(baseUrl).origin;
  const browser = await chromium.launch(LAUNCH_OPTS);

  const pageReports: Record<string, unknown>[] = [];
  const allLinkTargets = new Map<string, string[]>(); // target -> referencing pages

  for (const url of urls) {
    // explicit context: AxeBuilder rejects pages from browser.newPage()'s implicit context
    const ctx = await browser.newContext(TLS_CTX);
    const page = await ctx.newPage();
    const consoleIssues: string[] = [];
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleIssues.push(`${m.type()}: ${m.text()}`); });
    page.on("pageerror", (e) => consoleIssues.push(`pageerror: ${e.message}`));
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });

    // axe
    // cast: @axe-core/playwright pins its own playwright-core, type-incompatible with ours
    const axe = await new AxeBuilder({ page: page as any }).analyze();
    const axeSerious = axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious");

    // meta/OG completeness
    // no inner function declarations: tsx/esbuild injects a __name helper that
    // doesn't exist inside the browser context
    const meta = await page.evaluate(() => ({
      title: document.title || null,
      description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? null,
      ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null,
      ogDescription: document.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? null,
      ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? null,
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
      lang: document.documentElement.lang || null,
    }));
    const metaMissing = Object.entries(meta).filter(([, v]) => !v).map(([k]) => k);

    // collect link + image targets
    for (const href of await page.locator("a[href]").evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href))) {
      if (/^https?:/.test(href)) allLinkTargets.set(href, [...(allLinkTargets.get(href) ?? []), url]);
    }
    for (const src of await page.locator("img[src]").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src))) {
      if (/^https?:/.test(src)) allLinkTargets.set(src, [...(allLinkTargets.get(src) ?? []), url]);
    }
    await ctx.close();

    // Lighthouse both form factors
    let lhMobile = null, lhDesktop = null, lhError: string | null = null;
    try {
      lhMobile = await runLighthouse(url, "mobile");
      lhDesktop = await runLighthouse(url, "desktop");
    } catch (e) {
      lhError = (e as Error).message.slice(0, 200);
    }

    pageReports.push({
      url, consoleIssues, meta, metaMissing,
      axe: { critical_serious: axeSerious.length, violations: axeSerious.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })) },
      lighthouse: { mobile: lhMobile, desktop: lhDesktop, error: lhError },
    });
    console.log(`audited ${url}: axe c/s=${axeSerious.length}, console=${consoleIssues.length}, LH-mobile=${JSON.stringify(lhMobile?.scores ?? lhError)}`);
  }
  await browser.close();

  // Link check (HEAD with GET fallback), gentle on external hosts
  const broken: { url: string; status: number | string; referencedBy: string[] }[] = [];
  for (const [target, refs] of allLinkTargets) {
    try {
      let res = await fetch(target, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15000) });
      if (res.status === 405 || res.status === 501) res = await fetch(target, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15000) });
      if (res.status >= 400) broken.push({ url: target, status: res.status, referencedBy: [...new Set(refs)] });
    } catch (e) {
      broken.push({ url: target, status: (e as Error).name, referencedBy: [...new Set(refs)] });
    }
    if (!sameOrigin(target, origin)) await new Promise((r) => setTimeout(r, 250));
  }

  // Gate evaluation
  const failures: string[] = [];
  for (const p of pageReports as any[]) {
    if (p.consoleIssues.length) failures.push(`${p.url}: ${p.consoleIssues.length} console errors/warnings`);
    if (p.axe.critical_serious) failures.push(`${p.url}: ${p.axe.critical_serious} critical/serious axe violations`);
    if (p.metaMissing.length) failures.push(`${p.url}: missing meta [${p.metaMissing.join(", ")}]`);
    for (const ff of ["mobile", "desktop"] as const) {
      const lh = p.lighthouse[ff];
      if (!lh) { failures.push(`${p.url}: Lighthouse ${ff} did not run (${p.lighthouse.error})`); continue; }
      for (const [cat, min] of Object.entries(GATES.lighthouse)) {
        if ((lh.scores[cat] ?? 0) < min) failures.push(`${p.url} [${ff}]: ${cat} ${lh.scores[cat]} < ${min}`);
      }
      if (ff === "mobile" && lh.lcpMs != null && lh.lcpMs > GATES.lcpMs) failures.push(`${p.url}: mobile LCP ${Math.round(lh.lcpMs)}ms > ${GATES.lcpMs}ms`);
      if (lh.cls != null && lh.cls > GATES.cls) failures.push(`${p.url} [${ff}]: CLS ${lh.cls} > ${GATES.cls}`);
      if (lh.jsBytes != null && lh.jsBytes > GATES.jsBudgetKb * 1024) failures.push(`${p.url} [${ff}]: JS ${Math.round(lh.jsBytes / 1024)}KB > ${GATES.jsBudgetKb}KB`);
    }
  }
  if (broken.length) failures.push(...broken.map((b) => `broken: ${b.url} (${b.status}) on ${b.referencedBy.join(", ")}`));

  const pass = failures.length === 0;
  writeJson(outFile, {
    baseUrl, auditedAt: new Date().toISOString(), gates: GATES,
    pass, failures, pages: pageReports, brokenLinks: broken,
  });
  console.log(pass ? "GATE: PASS" : `GATE: FAIL (${failures.length} failures)`);
  process.exit(pass || LENIENT ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
