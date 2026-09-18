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
}

export interface PageSignals {
  url: string;
  title: string;
  consoleErrors: string[];
  failedRequests: { url: string; status: number }[];
  pageErrors: string[];
  textExcerpt: string;
  screenshot: Uint8Array | null;
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
}
