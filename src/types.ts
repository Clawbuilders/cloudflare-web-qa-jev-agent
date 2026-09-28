export interface Env {
  AI: Ai;
  BROWSER: Fetcher;

  TARGET_URL: string;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  RUN_TOKEN: string;

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
