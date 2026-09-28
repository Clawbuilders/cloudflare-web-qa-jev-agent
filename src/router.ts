import type { Env } from "./types";

export type Engine = "kitesurf" | "chromium";

interface JevRouteResponse {
  answers: { engine: { choice: Engine } };
}

const ENGINE_SIGNALS: Record<Engine, string> = {
  kitesurf:
    "This page/goal is plain content, forms, or simple navigation — no login required, no WebGL/canvas/video, and the domain isn't known to run bot-challenge fingerprinting",
  chromium:
    "This page/goal needs an authenticated session, renders WebGL/canvas/video, or the domain is known to run bot-challenge (Cloudflare/Akamai/PerimeterX-style) fingerprinting",
};

/**
 * Cheap per-page engine choice, asked once per URL before it's ever
 * visited. Kitesurf (`puppeteer.launch(env.BROWSER, { browser: "kitesurf" })`
 * — a real, typed option on the existing Browser Rendering binding, not a
 * separate CDP/API-token path) is the default since it's 3-7x cheaper than
 * Chromium for plain extraction/interaction; Jev only needs to catch the
 * minority of pages/goals that actually need Chromium.
 *
 * A wrong "kitesurf" guess here is never fatal — explorer.ts always fails
 * up to Chromium if a Kitesurf session throws mid-visit, same cascade shape
 * as the free-tier fallback in cloudflare-code-reviewer's triage gate.
 */
export async function chooseEngine(env: Env, url: string, goal: string): Promise<Engine> {
  const forcedPatterns = (env.CHROMIUM_ONLY_PATTERNS ?? "")
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (forcedPatterns.some((pattern) => url.includes(pattern))) return "chromium";

  try {
    const response = (await env.AI.run("typesafe/jev", {
      state: { url, goal },
      questions: {
        engine: {
          type: "choice",
          instructions: "Given this URL and QA goal, which browser engine does visiting/testing it need?",
          criteria: ENGINE_SIGNALS,
        },
      },
    })) as unknown as JevRouteResponse;

    return response.answers.engine.choice === "chromium" ? "chromium" : "kitesurf";
  } catch {
    // Router itself failing shouldn't block the crawl — default to the
    // cheap tier and let the real fail-up fallback in explorer.ts catch it
    // if Kitesurf genuinely can't handle this page.
    return "kitesurf";
  }
}
