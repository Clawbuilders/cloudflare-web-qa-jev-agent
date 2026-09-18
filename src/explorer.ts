import puppeteer from "@cloudflare/puppeteer";
import type { Env, PageSignals } from "./types";
import { redact } from "./redact";

// page.evaluate() callbacks below run inside the remote browser's DOM
// context, not the Worker's — these ambient declarations exist only so
// tsc can typecheck them without pulling in `lib.dom.d.ts` (which would
// clash with Workers' own global types).
declare const document: any; // eslint-disable-line @typescript-eslint/no-explicit-any

const NAV_TIMEOUT_MS = 20_000;

/**
 * Crawls up to MAX_PAGES same-origin pages starting from TARGET_URL,
 * collecting the text-shaped signals a real bug tends to leave behind:
 * console errors, failed network requests, uncaught page errors, and a
 * text excerpt. Takes a screenshot of every page too, but only the pages
 * that end up escalated later actually use it — cheaper than re-visiting
 * a page just to grab its screenshot after the fact.
 */
export async function explore(env: Env): Promise<PageSignals[]> {
  const maxPages = Math.max(1, Math.min(10, parseInt(env.MAX_PAGES, 10) || 3));
  const startUrl = new URL(env.TARGET_URL);

  const browser = await puppeteer.launch(env.BROWSER);
  const visited = new Set<string>();
  const queue: string[] = [startUrl.toString()];
  const results: PageSignals[] = [];

  try {
    while (queue.length > 0 && results.length < maxPages) {
      const url = queue.shift();
      if (!url || visited.has(url)) continue;
      visited.add(url);

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

        const title = await page.title();
        const textExcerpt = redact(
          await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? ""),
        );
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
              if (parsed.origin === startUrl.origin && !visited.has(parsed.toString())) {
                queue.push(parsed.toString());
              }
            } catch {
              // ignore unparsable hrefs (mailto:, javascript:, etc.)
            }
          }
        }

        results.push({
          url,
          title,
          consoleErrors,
          failedRequests,
          pageErrors,
          textExcerpt,
          screenshot,
        });
      } catch (err) {
        results.push({
          url,
          title: "",
          consoleErrors,
          failedRequests,
          pageErrors: [...pageErrors, `Navigation failed: ${redact(String(err)).slice(0, 300)}`],
          textExcerpt: "",
          screenshot: null,
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}
