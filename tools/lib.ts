// Shared helpers for Foundry tools.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import robotsParserImport from "robots-parser";

interface RobotsChecker {
  isAllowed(url: string, ua?: string): boolean | undefined;
}
// robots-parser ships CJS with ambient typings that confuse NodeNext resolution.
const robotsParser = ((robotsParserImport as any).default ?? robotsParserImport) as (
  url: string,
  robotstxt: string,
) => RobotsChecker;

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface FoundryConfig {
  capture: { max_pages: number; rate_limit_ms: number; user_agent: string };
  [k: string]: unknown;
}

export function loadConfig(): FoundryConfig {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, "foundry.config.json"), "utf8"));
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// FOUNDRY_IGNORE_TLS=1: trust-broken egress proxies (sandboxed CI only — never
// set in production; cert errors on a prospect's site are a weakness FINDING).
export const IGNORE_TLS = process.env.FOUNDRY_IGNORE_TLS === "1";
export const LAUNCH_OPTS = {
  headless: true,
  args: IGNORE_TLS ? ["--ignore-certificate-errors"] : [],
};
export const TLS_CTX = IGNORE_TLS ? { ignoreHTTPSErrors: true } : {};
if (IGNORE_TLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // node fetch (robots, link check)

/** Polite same-origin crawler scaffolding: robots.txt + rate limit. */
export class PoliteFetcher {
  private lastRequest = 0;
  private robots: RobotsChecker | null = null;
  constructor(
    private origin: string,
    private userAgent: string,
    private rateLimitMs: number,
  ) {}

  async init(): Promise<void> {
    const robotsUrl = new URL("/robots.txt", this.origin).href;
    try {
      const res = await fetch(robotsUrl, { headers: { "user-agent": this.userAgent } });
      const body = res.ok ? await res.text() : "";
      this.robots = robotsParser(robotsUrl, body);
    } catch {
      this.robots = robotsParser(robotsUrl, "");
    }
  }

  isAllowed(url: string): boolean {
    return this.robots ? (this.robots.isAllowed(url, this.userAgent) ?? true) : true;
  }

  /** Await this before every request to the origin (≤ 1 req / rateLimitMs). */
  async throttle(): Promise<void> {
    const wait = this.lastRequest + this.rateLimitMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequest = Date.now();
  }
}

export function slugifyUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "") || "/index";
  return (
    path
      .replace(/^\//, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .slice(0, 80) || "index"
  );
}

export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function normalizeUrl(url: string): string {
  const u = new URL(url);
  u.hash = "";
  u.search = ""; // local-business sites: query params are almost always tracking noise
  if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.href;
}

const SKIP_EXTENSIONS = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|css|js|mp4|mp3|zip|docx?|xlsx?|pptx?|woff2?|ttf)$/i;
export function isHtmlLink(url: string): boolean {
  try {
    return !SKIP_EXTENSIONS.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
