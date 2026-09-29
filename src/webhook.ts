import type { Env } from "./types";
import { verifyWebhookSignature } from "./github-app-auth";
import { commentOnIssue } from "./github";
import { runPipeline } from "./pipeline";

/** Type anywhere in an issue/PR comment to kick off a run on demand,
 * instead of waiting for the monthly cron or hitting /run?token=. */
const TRIGGER_PHRASE = "/run-qa";

/** Only these can trigger a real (paid — Browser Rendering + Workers AI)
 * run. Everyone else's comment is silently ignored — see README's webhook
 * section for the reasoning (single-collaborator private repo, so this is
 * mostly a guard against a stray forged request, not a real attacker). */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

interface IssueCommentPayload {
  action: string;
  comment: { id: number; body: string; author_association: string };
  issue: { number: number };
}

/**
 * Handles POST /webhook/github — GitHub's issue_comment delivery. Always
 * acks fast (GitHub retries on non-2xx or timeout) and does the actual
 * crawl via ctx.waitUntil, same pattern as the scheduled() cron handler.
 */
export async function handleGitHubWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) return new Response("Webhook not configured", { status: 404 });

  const rawBody = await request.text();
  const valid = await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, request.headers.get("X-Hub-Signature-256"));
  if (!valid) return new Response("Bad signature", { status: 401 });

  if (request.headers.get("X-GitHub-Event") !== "issue_comment") {
    return new Response("Ignored (not an issue_comment event)", { status: 200 });
  }

  const payload = JSON.parse(rawBody) as IssueCommentPayload;
  if (
    payload.action !== "created" ||
    !payload.comment.body.toLowerCase().includes(TRIGGER_PHRASE) ||
    !TRUSTED_ASSOCIATIONS.has(payload.comment.author_association)
  ) {
    return new Response("Ignored", { status: 200 });
  }

  const issueNumber = payload.issue.number;
  ctx.waitUntil(
    runPipeline(env)
      .then((summary) =>
        commentOnIssue(
          env,
          issueNumber,
          `QA run finished: visited ${summary.pagesVisited} page(s), flagged ${summary.flagged}, ` +
            `filed ${summary.filed.length} new issue(s), matched ${summary.duplicates.length} existing one(s).`,
        ),
      )
      .catch((err) => commentOnIssue(env, issueNumber, `QA run failed: ${(err as Error).message}`).catch(() => {})),
  );

  return new Response("Run started", { status: 202 });
}
