import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import type { Env, PageSignals } from "./types";
import { redact } from "./redact";
import { chooseEngine, type Engine } from "./router";
import { runActionLoop } from "./action-loop";
import { loadIndex, pickRevisitCandidates, type SiteIndex } from "./coverage";

// page.evaluate() callbacks below run inside the remote browser's DOM
// context, not the Worker's — these ambient declarations exist only so
// tsc can typecheck them without pulling in `lib.dom.d.ts` (which would
// clash with Workers' own global types).
declare const document: any; // eslint-disable-line @typescript-eslint/no-explicit-any

const NAV_TIMEOUT_MS = 20_000;
const DEFAULT_GOAL =
  "Explore this site like a QA tester: prioritize exercising interactive elements (forms, buttons, links) over passively reading static content, and surface anything that looks broken.";

function launchEngine(env: Env, engine: Engine): Promise<Browser> {
  return engine === "kitesurf"
    ? puppeteer.launch(env.BROWSER, { browser: "kitesurf" })
    : puppeteer.launch(env.BROWSER);
}

/**
 * Crawls up to MAX_PAGES same-origin pages starting from TARGET_URL. Each
 * page is routed to Kitesurf (cheap default) or Chromium via Browser
 * Rendering (escalation) by router.ts's Jev call, then driven by
 * action-loop.ts's Jev-picked action loop instead of passively reading —
 * see the main app repo's docs/phases/phase-51 for the full design.
 *
 * Crawl order is coverage-aware (coverage.ts): REVISIT_RATE of the
 * MAX_PAGES budget is reserved for regression-checking pages this Worker
 * has crawled before (previously-flagged pages first, then the stalest),
 * and the rest is biased toward pages never seen before over ones already
 * in the coverage index — so repeated runs spread out across the site
 * instead of retreading the same first few pages every time, while still
 * periodically re-verifying old ground since unrelated changes can break
 * something that used to work.
 *
 * Collects the same text-shaped signals a real bug tends to leave behind —
 * console errors, failed network requests, uncaught page errors, a text
 * excerpt — plus a screenshot of every page (only escalated pages end up
 * using it) and a log of what the action loop actually did.
 */
export async function explore(env: Env): Promise<{ pages: PageSignals[]; index: SiteIndex }> {
  const maxPages = Math.max(1, Math.min(10, parseInt(env.MAX_PAGES, 10) || 3));
  const revisitRate = Math.max(0, Math.min(1, parseFloat(env.REVISIT_RATE) || 0));
  const goal = env.QA_GOAL?.trim() || DEFAULT_GOAL;
  const startUrl = new URL(env.TARGET_URL);

  const index = await loadIndex(env);
  const revisitSlots = Math.round(maxPages * revisitRate);
  const revisitCandidates = pickRevisitCandidates(index, revisitSlots).filter(
    (url) => url !== startUrl.toString(),
  );

  const browsers: Partial<Record<Engine, Browser>> = {};
  const getBrowser = async (engine: Engine): Promise<Browser> => {
    let browser = browsers[engine];
    if (!browser) {
      browser = await launchEngine(env, engine);
      browsers[engine] = browser;
    }
    return browser;
  };

  const visited = new Set<string>();
  const queued = new Set<string>([...revisitCandidates, startUrl.toString()]);
  // Three lanes, drained in priority order: pre-picked regression checks,
  // then never-before-seen pages, then already-known pages as a fallback
  // (a small site may not have enough fresh links to fill the budget).
  const revisitQueue: string[] = [...revisitCandidates];
  const freshQueue: string[] = [startUrl.toString()];
  const knownQueue: string[] = [];

  const nextUrl = (): string | undefined => revisitQueue.shift() ?? freshQueue.shift() ?? knownQueue.shift();

  const results: PageSignals[] = [];

  const visit = async (url: string, engine: Engine): Promise<PageSignals> => {
    const browser = await getBrowser(engine);
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: { url: string; status: number }[] = [];
    const pageErrors: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(redact(msg.text()).slice(0, 500));
    });
    page.on("response", (res) => {
      if (res.status() >= 400) failedRequests.push({ url: res.url(), status: res.status() });
    });
    page.on("pageerror", (err) => {
      pageErrors.push(redact(String(err)).slice(0, 500));
    });

    try {
      await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });

      const { actionsAttempted, actionSignatures } = await runActionLoop(
        env,
        page,
        goal,
        index.pages[url],
      ).catch(() => ({ actionsAttempted: [] as string[], actionSignatures: [] as string[] }));

      const title = await page.title();
      const textExcerpt = redact(await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? ""));
      const screenshot = (await page.screenshot({ type: "jpeg", quality: 60 })) as Uint8Array;

      if (results.length < maxPages) {
        const links: string[] = await page.evaluate(() =>
          (Array.from(document.querySelectorAll("a[href]")) as { href: string }[])
            .map((a) => a.href)
            .slice(0, 40),
        );
        for (const link of links) {
          try {
            const parsed = new URL(link);
            const normalized = parsed.toString();
            if (parsed.origin !== startUrl.origin || visited.has(normalized) || queued.has(normalized)) continue;
            queued.add(normalized);
            if (index.pages[normalized]) knownQueue.push(normalized);
            else freshQueue.push(normalized);
          } catch {
            // ignore unparsable hrefs (mailto:, javascript:, etc.)
          }
        }
      }

      return {
        url,
        title,
        consoleErrors,
        failedRequests,
        pageErrors,
        textExcerpt,
        screenshot,
        engine,
        actionsAttempted,
        actionSignatures,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  };

  const makeFailure = (url: string, engine: Engine, message: string): PageSignals => ({
    url,
    title: "",
    consoleErrors: [],
    failedRequests: [],
    pageErrors: [message],
    textExcerpt: "",
    screenshot: null,
    engine,
    actionsAttempted: [],
    actionSignatures: [],
  });

  try {
    while (results.length < maxPages) {
      const url = nextUrl();
      if (!url) break;
      if (visited.has(url)) continue;
      visited.add(url);

      const engine = await chooseEngine(env, url, goal);

      try {
        results.push(await visit(url, engine));
      } catch (err) {
        if (engine !== "kitesurf") {
          results.push(makeFailure(url, engine, `Navigation failed: ${redact(String(err)).slice(0, 300)}`));
          continue;
        }

        // Fail up: Kitesurf can't handle everything (auth sessions, WebGL,
        // bot-challenge pages) — retry this exact page on real Chromium
        // rather than dropping it, same cascade shape as the §50.6
        // triage-gate fallback in cloudflare-code-reviewer.
        try {
          results.push(await visit(url, "chromium"));
        } catch (fallbackErr) {
          results.push(
            makeFailure(
              url,
              "chromium",
              `Kitesurf failed (${redact(String(err)).slice(0, 150)}); Chromium fallback also failed: ${redact(String(fallbackErr)).slice(0, 150)}`,
            ),
          );
        }
      }
    }
  } finally {
    await Promise.all(Object.values(browsers).map((browser) => browser?.close().catch(() => undefined)));
  }

  return { pages: results, index };
}
