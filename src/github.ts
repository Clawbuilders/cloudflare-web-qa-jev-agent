import type { Env, Finding } from "./types";
import { getGitHubAppToken } from "./github-app-auth";

const GITHUB_API = "https://api.github.com";

async function headers(env: Env): Promise<HeadersInit> {
  const token = await getGitHubAppToken(env);
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cloudflare-web-qa-jev-agent",
  };
}

interface OpenIssue {
  number: number;
  title: string;
}

export async function listOpenIssues(env: Env): Promise<OpenIssue[]> {
  const url = new URL(`${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`);
  url.searchParams.set("state", "open");
  url.searchParams.set("labels", env.ISSUE_LABEL);
  url.searchParams.set("per_page", "50");

  const resp = await fetch(url, { headers: await headers(env) });
  if (!resp.ok) throw new Error(`Listing open issues failed: ${resp.status} ${await resp.text()}`);
  const issues = (await resp.json()) as OpenIssue[];
  return issues.map((issue) => ({ number: issue.number, title: issue.title }));
}

/**
 * Dedup gate — a Jev Choice call over the new finding plus every currently
 * open (agent-labeled) issue's title. Returns the matched issue number, or
 * null if this genuinely looks new. Cheap guard against re-filing the same
 * bug on every run.
 */
export async function findDuplicate(
  env: Env,
  finding: Finding,
  openIssues: OpenIssue[],
): Promise<number | null> {
  if (openIssues.length === 0) return null;

  const criteria: Record<string, string> = { new: "This is a new, different issue" };
  for (const issue of openIssues) {
    criteria[String(issue.number)] = issue.title;
  }

  const response = (await env.AI.run("typesafe/jev", {
    state: {
      new_finding_title: finding.title,
      new_finding_url: finding.url,
      new_finding_description: finding.description,
    },
    questions: {
      match: {
        type: "choice",
        instructions:
          "Does this new finding describe the same underlying bug as one of the already-open issues below, or is it new?",
        criteria,
      },
    },
  })) as { answers: { match: { choice: string } } };

  const choice = response.answers.match.choice;
  return choice === "new" ? null : parseInt(choice, 10);
}

export async function commentOnIssue(env: Env, issueNumber: number, body: string): Promise<void> {
  const resp = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
    { method: "POST", headers: await headers(env), body: JSON.stringify({ body }) },
  );
  if (!resp.ok) throw new Error(`Commenting on issue failed: ${resp.status} ${await resp.text()}`);
}

async function uploadScreenshot(env: Env, finding: Finding): Promise<string | null> {
  if (!finding.screenshot) return null;

  const slug = finding.url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
  const path = `qa-screenshots/${slug}-${Date.now()}.jpg`;
  let base64 = "";
  const bytes = finding.screenshot;
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    base64 += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  base64 = btoa(base64);

  const resp = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: await headers(env),
      body: JSON.stringify({
        message: `Add QA screenshot for ${finding.url}`,
        content: base64,
      }),
    },
  );
  if (!resp.ok) return null; // non-fatal — the issue still gets filed without an image
  const body = (await resp.json()) as { content?: { download_url?: string } };
  return body.content?.download_url ?? null;
}

export async function createIssue(env: Env, finding: Finding): Promise<{ number: number; url: string }> {
  const imageUrl = await uploadScreenshot(env, finding);

  const body = [
    finding.description,
    "",
    `**Severity:** ${finding.severityLabel}  |  **Category:** ${finding.category}  |  **Engine:** ${finding.engine}`,
    `**Page:** ${finding.url}`,
    finding.actionsAttempted.length > 0
      ? `**Actions attempted:** ${finding.actionsAttempted.join("; ")}`
      : "",
    imageUrl ? `\n![screenshot](${imageUrl})` : "",
    "",
    "_Filed automatically by [cloudflare-web-qa-jev-agent](https://github.com/Clawbuilders/cloudflare-web-qa-jev-agent)._",
  ]
    .filter(Boolean)
    .join("\n");

  const resp = await fetch(`${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`, {
    method: "POST",
    headers: await headers(env),
    body: JSON.stringify({ title: finding.title, body, labels: [env.ISSUE_LABEL] }),
  });
  if (!resp.ok) throw new Error(`Creating issue failed: ${resp.status} ${await resp.text()}`);
  const created = (await resp.json()) as { number: number; html_url: string };
  return { number: created.number, url: created.html_url };
}
