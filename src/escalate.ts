import type { Env, Finding, PageSignals, TriageResult } from "./types";
import { redact } from "./redact";

/**
 * The expensive tier — only called for pages Jev already flagged. Jev is
 * text-only, so it can't judge a layout glitch or a broken image; this is
 * where a vision-capable model looks at the actual screenshot and writes
 * up what it sees, grounded in the same signals Jev already judged.
 */
export async function draftFinding(
  env: Env,
  page: PageSignals,
  triageResult: TriageResult,
): Promise<Finding> {
  const prompt = redact(
    `You are a QA engineer writing up a bug report from an automated crawl.
Page: ${page.url}
Title: ${page.title}
Detected category: ${triageResult.category}
Detected severity: ${triageResult.severityLabel}
Console errors: ${JSON.stringify(page.consoleErrors.slice(0, 5))}
Failed requests: ${JSON.stringify(page.failedRequests.slice(0, 5))}
Page errors: ${JSON.stringify(page.pageErrors.slice(0, 5))}

Look at the attached screenshot of this page. Write a short bug report as
plain markdown (no code fences) with exactly two parts:
Line 1: a short, specific bug title (under 12 words).
Then a blank line, then 2-4 sentences describing what's visibly and
technically wrong, and a likely cause. Do not include any secrets, API
keys, or tokens even if you see something that looks like one — describe
its presence generically instead.`,
  );

  let text = "";
  if (page.screenshot) {
    const response = (await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      image: [...page.screenshot],
      prompt,
    })) as { description?: string; response?: string };
    text = response.description ?? response.response ?? "";
  }

  const cleaned = redact(text).trim();
  const [firstLine, ...rest] = cleaned.split("\n").filter((line) => line.trim().length > 0);

  return {
    url: page.url,
    title: firstLine?.replace(/^#+\s*/, "").slice(0, 120) || `${triageResult.category} on ${page.url}`,
    description: rest.join("\n\n") || cleaned || "Automated crawl flagged this page; no further detail generated.",
    severityLabel: triageResult.severityLabel,
    category: triageResult.category,
    screenshot: page.screenshot,
  };
}
