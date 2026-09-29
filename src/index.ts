import type { Env } from "./types";
import { runPipeline } from "./pipeline";
import { handleGitHubWebhook } from "./webhook";
import { listOpenIssues } from "./github";

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPipeline(env).catch((err) => console.error("Scheduled run failed:", err)));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook/github" && request.method === "POST") {
      return handleGitHubWebhook(request, env, ctx);
    }

    if (url.pathname === "/debug/github") {
      const token = url.searchParams.get("token");
      if (!token || token !== env.RUN_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Read-only: exercises the full GitHub App auth chain (JWT sign →
      // installation token → REST call) without creating or changing
      // anything, so it can verify the App is wired up correctly on its
      // own — the main /run pipeline only ever calls GitHub once triage
      // actually flags a page, so a clean crawl with nothing flagged never
      // proves this path works.
      try {
        const openIssues = await listOpenIssues(env);
        return new Response(JSON.stringify({ ok: true, openIssueCount: openIssues.length }, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(`GitHub auth check failed: ${(err as Error).message}`, { status: 500 });
      }
    }

    if (url.pathname === "/run") {
      const token = url.searchParams.get("token");
      if (!token || token !== env.RUN_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const summary = await runPipeline(env);
        return new Response(JSON.stringify(summary, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(`Run failed: ${(err as Error).message}`, { status: 500 });
      }
    }

    return new Response("Not found. Try /run?token=<RUN_TOKEN>", { status: 404 });
  },
};
