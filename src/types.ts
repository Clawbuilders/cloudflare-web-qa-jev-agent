export interface Env {
  AI: Ai;
  BROWSER: Fetcher;
  /** Cross-run coverage memory (src/coverage.ts) — which pages/elements
   * have been tried before and whether they found something. */
  COVERAGE: KVNamespace;

  TARGET_URL: string;
  /** GitHub App identity — this Worker posts as the App's bot account, no
   * personal access token (see src/github-app-auth.ts). */
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  RUN_TOKEN: string;
  /** Optional — only needed if the App's webhook is turned on so a GitHub
   * comment can trigger a run (src/webhook.ts). Unset means /webhook/github
   * always 404s; the cron and /run?token= triggers still work either way. */
  GITHUB_WEBHOOK_SECRET?: string;

  MAX_PAGES: string;
  ESCALATION_FLOOR: string;
  ISSUE_LABEL: string;

  /** Free-text QA goal fed to the router (src/router.ts) and action loop
   * (src/action-loop.ts) — what the agent should prioritize testing, not
   * just "crawl and read." Falls back to a generic goal if unset. */
  QA_GOAL?: string;
  /** Max Jev-picked interactions per page before moving on (src/action-loop.ts). */
  ACTION_BUDGET: string;
  /** Comma-separated substrings that always route to Chromium regardless of
   * the Jev router's call — e.g. known-authenticated paths (src/router.ts). */
  CHROMIUM_ONLY_PATTERNS: string;
  /** Fraction (0-1) of MAX_PAGES reserved for regression-checking known
   * pages instead of discovering new ones (src/coverage.ts, src/explorer.ts). */
  REVISIT_RATE: string;
}

export interface PageSignals {
  url: string;
  title: string;
  consoleErrors: string[];
  failedRequests: { url: string; status: number }[];
  pageErrors: string[];
  textExcerpt: string;
  screenshot: Uint8Array | null;
  /** Which engine actually served this page — "kitesurf" (default, cheap),
   * "chromium" (Jev-routed or fail-up escalation). Named in every finding
   * filed, same transparency precedent as the cloudflare-code-reviewer
   * triage gate naming which tier produced a judgment. */
  engine: "kitesurf" | "chromium";
  /** What the Jev-driven action loop actually did on this page, in order —
   * e.g. "clicked button \"Submit\"", "typed into Email". Empty if the loop
   * found nothing worth interacting with, or wasn't reached. */
  actionsAttempted: string[];
  /** Stable signatures (src/coverage.ts) for each entry in actionsAttempted,
   * same order — used to write coverage history back after triage. */
  actionSignatures: string[];
}

export interface TriageResult {
  url: string;
  isRealBug: number;
  severity: number;
  severityLabel: string;
  category: string;
}

export interface Finding {
  url: string;
  title: string;
  description: string;
  severityLabel: string;
  category: string;
  screenshot: Uint8Array | null;
  engine: "kitesurf" | "chromium";
  actionsAttempted: string[];
}
