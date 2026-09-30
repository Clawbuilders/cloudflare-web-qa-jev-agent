# WebMCP probe — manual, dev-only (not wired into the automated pipeline)

[WebMCP](https://developers.cloudflare.com/browser-run/features/webmcp/) lets
a site expose typed tools (`searchFlights()`, `bookTicket()`-style functions)
that an agent can call directly instead of clicking through the DOM. It's the
highest-value tier in this agent's design — see the main app repo's
`docs/phases/phase-51-web-qa-agent-tiered-browser-pipeline.md` §51.2 — but it
is **not implemented in `src/`**, on purpose, for two reasons confirmed
directly against Cloudflare's own docs:

1. **WebMCP only works on sites that implement it.** `navigator.modelContext`
   / `navigator.modelContextTesting` don't exist on an arbitrary page — the
   site has to register tools itself. Realistically, that means
   `clawbuilders.club` (once it has WebMCP tool definitions added to
   `crates/app`) and a handful of Google demo sites, not third-party crawl
   targets.
2. **WebMCP requires a Chrome 146 beta "lab session," which Browser Run's own
   docs say plainly is not yet automatable from a Worker:**
   > "The `lab` parameter is not yet supported in `@cloudflare/puppeteer` or
   > `@cloudflare/playwright`. Acquire the session manually and connect with
   > `sessionId`." — and separately: "Lab sessions are experimental and
   > should not be used for production workloads."

Shipping a `src/webmcp.ts` that silently no-ops or throws in the scheduled
cron would be worse than shipping nothing — so this stays a manual step until
Cloudflare's client libraries actually support it, or until there's a real
reason to hand-roll the raw CDP session negotiation for a beta-only feature.

## How to probe manually, today

1. **Acquire a lab session** (requires `wrangler` logged into the account
   that owns Browser Rendering, and the `keepAlive` sets how long it stays up
   in seconds):

   ```sh
   npm i -g wrangler@latest
   wrangler browser create --lab --keepAlive 300
   ```

   This opens a live view of the session in your browser.

2. **Navigate to the target page** (e.g. `clawbuilders.club/events/toronto`,
   once WebMCP tools exist there) and open DevTools → Console.

3. **List available tools:**

   ```js
   navigator.modelContextTesting.listTools();
   ```

   An empty array means this page doesn't expose anything yet — normal for
   every page until §51.2's frontend work lands.

4. **Execute a tool**, if one showed up:

   ```js
   await navigator.modelContextTesting.executeTool("tool_name", JSON.stringify({ param: "value" }));
   ```

## Revisit automating this when

- `@cloudflare/puppeteer`/`@cloudflare/playwright` add real `lab: true`
  support (their `WorkersLaunchOptions` type already has a `lab?: boolean`
  field as of this writing, but Cloudflare's own docs say it isn't wired up
  yet — check before trusting the type alone), **or**
- WebMCP adoption grows enough that probing arbitrary third-party crawl
  targets is worth the lab-session overhead, not just `clawbuilders.club`
  itself.

Until then, the fastest path to real value here is adding WebMCP tool
definitions to `crates/app` for `clawbuilders.club`'s own high-value flows
(event registration, agent-application submission, publish) — that's
separate frontend work, not something this repo can do on its own.
