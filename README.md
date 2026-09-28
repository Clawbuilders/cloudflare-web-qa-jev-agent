# cloudflare-web-qa-jev-agent

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Clawbuilders/cloudflare-web-qa-jev-agent)

A Cloudflare Worker that acts like a QA tester on a web app — not just
crawling and reading, but clicking through forms and buttons — using
[`typesafe/jev`](https://developers.cloudflare.com/ai/models/typesafe/jev/)
(Cloudflare's decision model — fast, cheap, calibrated yes/no,
multiple-choice, and score judgments) for every decision along the way:
which browser engine a page needs, what to click next, whether a finding is
real, and whether it's a duplicate. A vision model confirms the real findings
and writes them up as deduped GitHub Issues. Built as a bonus track for
ClawBuilders Episode 5, alongside
[`cloudflare-code-reviewer`](https://github.com/Clawbuilders/cloudflare-code-reviewer)
and [`clawbuilders-story-agent`](https://github.com/Clawbuilders/clawbuilders-story-agent).

It's the web equivalent of what a mobile agent like Google's ARTEMIS does for
Android — natural-language-driven autonomous testing — except this one runs
entirely on Cloudflare and writes its findings straight to GitHub. Formerly
`web-qa-jev-agent`; renamed and substantially redesigned as part of
`docs/phases/phase-51-web-qa-agent-tiered-browser-pipeline.md` in the main
app repo, which has the full architecture writeup and the alternatives
(Stagehand, browser-use, Skyvern, WebMCP) considered and why.

## How it works

```
Cron Trigger (daily) or GET /run?token=...
  → For each same-origin page (up to MAX_PAGES, BFS from TARGET_URL):
      1. Engine router (src/router.ts): one Jev call picks Kitesurf (cheap
         default, ~3-7x less CPU/memory than Chromium) or Chromium via
         Browser Rendering (escalation) — auth sessions, WebGL/canvas/video,
         or bot-challenge domains route to Chromium. A Kitesurf session that
         actually throws fails up to Chromium regardless of what the router
         guessed, so a wrong guess is never fatal.
      2. Action loop (src/action-loop.ts): ports the core idea from
         browser-use/jev-ultrafast — one DOM snapshot of visible interactive
         elements per step, one Jev call picks the next indexed action
         (click / type / "done"), up to ACTION_BUDGET steps. This is what
         actually exercises forms and buttons instead of only following
         <a href> links.
      3. Collect signals: console errors, failed network requests, page
         errors, a text excerpt, a screenshot, and a log of what the action
         loop did.
  → Fast triage: one parallel typesafe/jev call per page — "is this a real
    bug?" (Noul), "how severe?" (Score), "what kind?" (Choice) — now informed
    by what the action loop actually attempted, not just passive signals.
  → Escalation gate: only pages Jev flags above ESCALATION_FLOOR go further
  → Confirm + draft: a vision model (@cf/meta/llama-3.2-11b-vision-instruct)
    looks at that page's screenshot and writes up the finding
  → Dedup: another Jev call — does this match an already-open Issue, or is
    it new?
  → Write-back: new findings become a GitHub Issue (screenshot, engine used,
    and actions attempted all included for transparency); repeat findings
    get a comment on the existing Issue
```

### Why Jev *and* a vision model — not just one

[`typesafe/jev`](https://developers.cloudflare.com/ai/models/typesafe/jev/)
is **text-only** — its own docs are explicit that images, audio, and video
aren't supported. It can't tell you a layout is broken from a screenshot, and
it can't drive a browser by itself. What it's genuinely good at: fast,
calibrated judgments over *text* — which engine a page needs, which indexed
DOM element to interact with next, whether console errors are a real bug,
whether a new finding duplicates an open issue — all at
$0.042 per **million** input tokens with free output, cheap enough to call
several times per page without a second thought.

So the split is deliberate: Jev makes every cheap, high-frequency decision
(routing, navigation, triage, dedup); a vision-capable model only gets called
for the small fraction of pages Jev actually flags, to look at the screenshot
and write the human-readable report. Most of a crawl's cost stays near zero;
only the real findings cost real tokens.

### Where Stagehand and WebMCP were considered, and why they aren't here

- **Stagehand** needs real Chromium (pinned to `@browserbasehq/stagehand`
  v2.5.x, Playwright-based, not Kitesurf-compatible) and its AI-driven
  `act()` duplicates exactly what `action-loop.ts`'s Jev call already does,
  at a higher per-step cost. Not adopted.
- **WebMCP** is the actually-higher-value idea for testing `clawbuilders.club`
  itself once it exposes typed tools — see `docs/webmcp-probe.md` for why
  it's documented as a manual dev step rather than wired into this pipeline
  (short version: it needs a Chrome 146 beta lab session that Cloudflare's
  own docs say isn't yet supported by `@cloudflare/puppeteer`, and only works
  on sites that implement it).

### Redaction, same as the other two bots

Console errors, failed request URLs, page text, and every Jev prompt/state
payload pass through a regex secret-scrubber (`src/redact.ts`) before
reaching any model or any public GitHub Issue — a misconfigured page
printing its own API key into an error message should never end up quoted in
a public bug report.

## Repo layout

- `src/index.ts` — Worker entrypoint: `scheduled()` (daily cron) and
  `fetch()` (the `/run` manual-trigger route)
- `src/explorer.ts` — orchestrates the crawl: engine routing, the action
  loop, signal collection, and the Kitesurf→Chromium fail-up cascade
- `src/router.ts` — the per-page Jev call choosing Kitesurf vs. Chromium
- `src/action-loop.ts` — the per-page Jev-driven action loop (DOM snapshot →
  Jev picks next element → click/type), ported from `browser-use/jev-ultrafast`
- `src/triage.ts` — the per-page "is this a real bug" Jev call
- `src/escalate.ts` — the vision-model confirm + write-up
- `src/github.ts` — list/dedup/comment/create against GitHub Issues, plus
  the screenshot upload
- `src/pipeline.ts` — wires the above into one run
- `src/redact.ts` — the secret-scrubbing pass
- `docs/webmcp-probe.md` — manual steps for probing WebMCP tool support on a
  target site; not wired into the automated pipeline (see that file for why)
- `wrangler.json` — Worker config (AI + Browser Rendering bindings, cron)

## Setup

### 1. Deploy

Click the **Deploy to Cloudflare Workers** button above, or clone and run
`wrangler deploy` yourself (see "Local development" below).

### 2. Enable Browser Rendering

Browser Rendering isn't on by default — enable it for your account in the
Cloudflare dashboard (**Workers & Pages → Browser Rendering**) if you
haven't used it before. Free-tier limits matter here: **10 browser-minutes
a day, 3 concurrent sessions, 6 requests/minute** — plenty for the daily
cron with a small `MAX_PAGES`, tight if you mash the manual `/run` route
repeatedly while testing, and tighter still now that the action loop spends
extra time per page interacting rather than just reading it. `wrangler.json`'s
`MAX_PAGES` defaults to `3` and is hard-capped at `10` in code; `ACTION_BUDGET`
defaults to `4` and is hard-capped at `10`. No separate setup is needed for
Kitesurf — it's a typed option (`{ browser: "kitesurf" }`) on the same
`BROWSER` binding, not a different binding or API token.

### 3. Accept the vision model's license

The first time any Worker on your account calls
`@cf/meta/llama-3.2-11b-vision-instruct`, Cloudflare requires you to accept
Meta's license for it — do this once in the dashboard's Workers AI model
page before your first real run, or the escalation step will fail on every
flagged page.

### 4. Create a GitHub token, and point the Worker at your repos

Create a **fine-grained personal access token** scoped to the repo you want
Issues filed in, with:

- Repository permissions → **Issues: Read and write**
- Repository permissions → **Contents: Read and write** (for uploading
  screenshots into `qa-screenshots/`)

Then set it, the target site, and the report repo, all as secrets (kept out
of the committed config on purpose — same reasoning as the other two bots):

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_OWNER   # e.g. your GitHub org or username
npx wrangler secret put GITHUB_REPO    # the repo name, without the owner
npx wrangler secret put TARGET_URL     # the site to crawl, e.g. https://clawbuilders.club
```

### 5. Set the run-trigger secret

```bash
npx wrangler secret put RUN_TOKEN   # any random string
```

### 6. (Optional) Tune the QA goal and engine routing

```bash
npx wrangler secret put QA_GOAL   # e.g. "Test the event registration flow end to end"
```

`CHROMIUM_ONLY_PATTERNS` (a `wrangler.json` var, default empty) is a
comma-separated list of URL substrings that always route to Chromium
regardless of what the Jev router decides — useful for known-authenticated
paths you don't want the router guessing about.

### 7. Deploy

```bash
npm install
npm run deploy
```

### 8. Verify

```bash
curl "https://web-qa-jev-agent.<your-subdomain>.workers.dev/run?token=<RUN_TOKEN>"
```

(The deployed Worker's own name/URL is left as `web-qa-jev-agent` on
purpose — only the repo and package were renamed, so the live URL from
before this redesign keeps working. Rename the Worker yourself in
`wrangler.json` and redeploy if you want the URL to match.)

Returns a JSON summary (`pagesVisited`, `flagged`, `filed`, `duplicates`,
`engineBreakdown`). Check the target repo's Issues tab — anything filed
carries the `web-qa-jev-agent` label, the engine used, actions attempted,
plus a screenshot committed under `qa-screenshots/`.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values, never commit this file
npm install
npm run dev   # wrangler dev --remote — Browser Rendering does NOT work in local mode
```

`npm run typecheck` runs `tsc --noEmit`.

## Schedule

The cron in `wrangler.json` (`0 14 * * *`, UTC) runs once daily. Adjust it,
or lean on the `/run` route for on-demand checks — both call the exact same
pipeline.

## Limitations (read before treating this as a real QA tool)

- **Text-only triage/routing/navigation, vision-only confirmation.** Jev
  never sees pixels — the vision model only sees a JPEG screenshot per
  flagged page, not a full interaction trace. Subtle visual bugs a real
  tester would catch by scrolling or resizing won't be found here.
- **The action loop's DOM-index approach has the same known risk every
  lightweight browser-automation agent using this pattern accepts**: the
  snapshot and the click both come from one atomic `page.$$()` query, so an
  index can't point at the wrong element *within* a step, but a page that
  mutates its own DOM between steps (not in response to the action taken)
  could make step N+1's snapshot describe something already stale. Handled
  by re-snapshotting every step, not by validating element freshness before
  each click the way `jev-ultrafast` itself does — a real gap if a target
  page re-renders on a timer.
- **Kitesurf can't do everything** — no video/WebGL, no bot-challenge TLS
  fingerprinting, no long-running authenticated sessions. The router and the
  fail-up fallback both exist because of this; neither is a substitute for
  telling the router about a known-authenticated path via
  `CHROMIUM_ONLY_PATTERNS` if you already know it needs Chromium.
- **Form fill-ins are generic placeholders** (`src/action-loop.ts`'s
  `FILLER_VALUES`), not realistic per-field values from a small
  text-generating model the way `jev-ultrafast` itself does — good enough to
  exercise a form's validation/submit path, not to actually complete a
  real multi-step flow requiring specific values.
- **WebMCP is documented, not automated** — see `docs/webmcp-probe.md`.
- **The vision model's write-up is best-effort text parsing**, not a strict
  schema — it's asked for a title line + description and that split is done
  with simple string splitting, not JSON.
- **Free-tier Browser Rendering caps the crawl volume.** See setup step 2 —
  now tighter per page than before, since the action loop spends real
  session time interacting, not just reading.
