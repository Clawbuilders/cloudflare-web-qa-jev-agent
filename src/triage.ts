import type { Env, PageSignals, TriageResult } from "./types";

const SEVERITY_LEVELS = ["Cosmetic", "Minor", "Major", "Broken"];

interface JevResponse {
  answers: {
    is_real_bug: { noul: number };
    severity: { score: number; legend: Record<string, string> };
    category: { choice: string };
  };
}

/**
 * One Jev call per page, asking every question in parallel (speculative
 * fan-out — no extra latency for asking more than we might need). This is
 * the cheap tier: code already knows structurally whether console errors
 * or failed requests exist; Jev's job is the semantic layer code can't do
 * — deciding whether that raw signal is actually a problem a user would
 * notice, versus benign noise (an ad blocker's 404, a deprecation warning).
 */
export async function triage(env: Env, page: PageSignals): Promise<TriageResult> {
  if (
    page.consoleErrors.length === 0 &&
    page.failedRequests.length === 0 &&
    page.pageErrors.length === 0
  ) {
    return { url: page.url, isRealBug: 0, severity: 0, severityLabel: "Cosmetic", category: "none" };
  }

  const state = {
    url: page.url,
    title: page.title,
    console_errors: page.consoleErrors,
    failed_requests: page.failedRequests,
    page_errors: page.pageErrors,
    text_excerpt: page.textExcerpt,
  };

  const response = (await env.AI.run("typesafe/jev", {
    state,
    questions: {
      is_real_bug: {
        type: "noul",
        instructions:
          "Given this page's console errors, failed network requests, and page errors, does this look like an actual bug a real user would notice or be affected by — not just benign warnings, ad-blocked trackers, expected redirects, or analytics failures?",
      },
      severity: {
        type: "score",
        instructions: "If this is a real issue, how severe does it look for a real user?",
        criteria: SEVERITY_LEVELS,
      },
      category: {
        type: "choice",
        instructions: "What kind of issue is this, if any?",
        criteria: {
          none: "No real issue — signals are benign noise",
          broken_link_or_404: "A link or resource that 404s or fails to load",
          api_or_server_error: "A backend/API call returning a 5xx or other server error",
          javascript_error: "An uncaught JS exception affecting page behavior",
          content_or_layout_anomaly: "Something in the page text/structure looks wrong",
        },
      },
    },
  })) as unknown as JevResponse;

  return {
    url: page.url,
    isRealBug: response.answers.is_real_bug.noul,
    severity: response.answers.severity.score,
    severityLabel:
      SEVERITY_LEVELS[Math.round(response.answers.severity.score)] ?? "Minor",
    category: response.answers.category.choice,
  };
}
