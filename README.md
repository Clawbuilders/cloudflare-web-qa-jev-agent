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

```mermaid
flowchart TD
    trigger(["Cron (monthly, or your own cadence) or GET /run?token=..."]) --> coverageRead

    coverageRead["coverage.ts<br/>read the KV coverage index"] --> queuePick["Pick crawl order:<br/>REVISIT_RATE slots to known pages<br/>(previously-flagged first), rest biased<br/>toward never-seen pages"]

    subgraph perpage ["Per page, up to MAX_PAGES"]
        queuePick --> router{{"router.ts<br/>Jev picks the engine"}}
        router -->|"plain content,<br/>no auth needed"| kitesurf["Kitesurf session<br/>(cheap default)"]
        router -->|"auth / WebGL /<br/>bot-challenge"| chromium["Chromium via<br/>Browser Rendering"]
        kitesurf -.->|"session throws<br/>(fail-up)"| chromium
        kitesurf --> actionloop
        chromium --> actionloop{{"action-loop.ts<br/>Jev picks next click/type,<br/>told each option's history"}}
        actionloop -->|"repeat up to<br/>ACTION_BUDGET"| actionloop
        actionloop --> signals["Collect signals:<br/>console errors, failed requests,<br/>page errors, screenshot, actions log"]
    end

    signals --> triage{{"triage.ts<br/>Jev: real bug? severity? category?"}}
    triage --> coverageWrite["coverage.ts<br/>write this run's visits +<br/>action outcomes back to KV"]
    coverageWrite --> gate{"above<br/>ESCALATION_FLOOR?"}
    gate -->|"no"| done(["nothing filed"])
    gate -->|"yes"| vision["escalate.ts<br/>vision model confirms + writes up"]
    vision --> dedup{{"github.ts<br/>Jev: matches an open Issue?"}}
    dedup -->|"yes"| comment(["comment on<br/>existing Issue"])
    dedup -->|"no, new"| create(["file new GitHub Issue<br/>(screenshot + engine + actions)"])
```

```
Cron Trigger (monthly by default, change it to fit your project) or GET /run?token=...
  → Coverage read (src/coverage.ts): one KV read of everything this Worker
    has crawled before. REVISIT_RATE of MAX_PAGES gets reserved for
    regression-checking known pages (ones that previously found something
    first, then the stalest); the rest is biased toward pages never seen
    before, falling back to known ones only if the site doesn't have
    enough fresh links to fill the budget.
  → For each page (up to MAX_PAGES, in that coverage-aware order):
      1. Engine router (src/router.ts): one Jev call picks Kitesurf (cheap
         default, ~3-7x less CPU/memory than Chromium) or Chromium via
         Browser Rendering (escalation) — auth sessions, WebGL/canvas/video,
         or bot-challenge domains route to Chromium. A Kitesurf session that
         actually throws fails up to Chromium regardless of what the router
         guessed, so a wrong guess is never fatal.
      2. Action loop (src/action-loop.ts): ports the core idea from
         browser-use/jev-ultrafast — one DOM snapshot of visible interactive
         elements per step, one Jev call picks the next indexed action
         (click / type / "done"), up to ACTION_BUDGET steps. Each option's
         description carries its history from the coverage index (never
         tried / tried N times and clean / tried before and found
         something), and Jev is told to prefer the genuinely new but not
         exclusively — a previously-clean element can still break from an
         unrelated change, so it's worth an occasional re-check, and a
         previously-flagged element gets real priority to verify the fix
         held. This is what actually exercises forms and buttons instead
         of only following <a href> links.
      3. Collect signals: console errors, failed network requests, page
         errors, a text excerpt, a screenshot, and a log of what the action
         loop did.
  → Fast triage: one parallel typesafe/jev call per page — "is this a real
    bug?" (Noul), "how severe?" (Score), "what kind?" (Choice) — now informed
    by what the action loop actually attempted, not just passive signals.
  → Coverage write (src/coverage.ts): this run's visits and action outcomes
    get merged back into the KV index before anything gets filed, so the
    memory update doesn't depend on the rest of the run succeeding.
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

- `src/index.ts` — Worker entrypoint: `scheduled()` (monthly cron) and
  `fetch()` (the `/run` manual-trigger route)
- `src/explorer.ts` — orchestrates the crawl: engine routing, the action
  loop, signal collection, and the Kitesurf→Chromium fail-up cascade
- `src/router.ts` — the per-page Jev call choosing Kitesurf vs. Chromium
- `src/action-loop.ts` — the per-page Jev-driven action loop (DOM snapshot →
  Jev picks next element → click/type), ported from `browser-use/jev-ultrafast`,
  annotated with each element's history from the coverage index
- `src/coverage.ts` — the cross-run memory: a KV-backed index of pages and
  actions tried before, used to bias crawl order and inform the action
  loop's choices (read once at the start of a run, written once after
  triage)
- `src/triage.ts` — the per-page "is this a real bug" Jev call
- `src/escalate.ts` — the vision-model confirm + write-up
- `src/github.ts` — list/dedup/comment/create against GitHub Issues, plus
  the screenshot upload
- `src/pipeline.ts` — wires the above into one run
- `src/redact.ts` — the secret-scrubbing pass
- `docs/webmcp-probe.md` — manual steps for probing WebMCP tool support on a
  target site; not wired into the automated pipeline (see that file for why)
- `cloudflare.config.ts` — Worker config (AI + Browser Rendering + KV
  bindings, cron); generated from `wrangler.json` via `cf migrate` and now
  the source of truth for anyone using Cloudflare's `cf` CLI. `wrangler.json`
  is kept alongside it for now as the classic-Wrangler fallback path — edit
  `cloudflare.config.ts` going forward and treat `wrangler.json` as frozen,
  since nothing currently keeps the two in sync automatically if you edit
  both.

## Setup

Cloudflare's [`cf` CLI](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)
is what this repo actually deploys with now (still open beta as of this
writing) — every step below shows the `cf` command, with the classic
`wrangler` equivalent as a fallback if you hit a beta rough edge. Install
whichever you're using:

```bash
npm i -g cf         # or: npm i -g wrangler
cf auth login       # or: wrangler login
```

> **⚠️ The bigger trap: `cf deploy` itself wipes any secret not declared in
> `cloudflare.config.ts` — every single deploy, not just when touching
> secrets.** Confirmed the hard way: after deploying with a config whose
> `env` block declared zero secrets, `wrangler secret list` came back `[]`
> — all 8 secrets gone, GitHub auth and the webhook trigger both broken.
> `cf` treats the config's declared secret set as the *desired state* and
> reconciles the live Worker to match it on every deploy, unlike classic
> Wrangler, where a secret set once just persists across deploys forever
> regardless of `wrangler.json`. **The fix**: every secret this Worker
> uses must have a matching `bindings.secret()` entry in
> `cloudflare.config.ts`'s `env` block (see that file — it's already done
> for all 8 required secrets in this repo). `bindings.secret()` takes no
> options and has no "optional" mode, though — declaring one makes `cf
> deploy` *refuse to deploy at all* if it isn't set, which is why the
> genuinely-optional `QA_GOAL` (§7) is deliberately left undeclared: if
> you set it, know that the next unrelated `cf deploy` (no code change,
> just re-running deploy) will silently drop it again, and you'll need to
> re-set it afterward.
>
> **On top of that**, `cf workers secrets update` replaces the Worker's
> *entire* secret set with just the one secret you're setting — it does
> not patch, even once secrets are properly declared. Confirmed
> separately: setting one secret via `update` on a Worker that already had
> 7 others silently dropped all 7. `update` issues a `PUT` to the plain
> `/secrets` collection endpoint (full replace); the fix is `cf workers
> secrets bulk`, which issues a `PATCH` to `/secrets-bulk` (RFC 7396 JSON
> Merge Patch — "secrets not included in the request are left unchanged",
> straight from its own `--help`). Every secret command below uses `bulk`
> for exactly this reason.
>
> **A third consequence of the same design, verified directly (both via
> the CLI and the actual one-click button): a brand-new Worker's *first*
> deploy needs every required secret value up front, not after.** Since
> every secret this Worker needs is declared with `bindings.secret()` (so
> that redeploys don't wipe them — see above), `cf deploy` on a Worker
> that doesn't exist yet refuses outright: *"This Worker does not exist
> yet, so secrets cannot be set in advance with `wrangler secret put`...
> supply them via a secrets file."* The **Deploy to Cloudflare Workers**
> button behaves the same way for the same reason — every declared secret
> shows up as a required field on its one setup screen, and the button's
> own form validation (not a server error) refuses to submit until all of
> them are filled in. Practically: **gather every value below (steps 1-4)
> before you attempt to deploy in step 5**, whichever path you use — this
> is the opposite order from a classic-Wrangler project, where deploying
> first and setting secrets afterward always worked fine.

### 1. Create a GitHub App

This Worker posts as a real bot identity — a GitHub App, not a personal
access token. No PAT fallback: `src/github-app-auth.ts` JWT-signs with the
App's private key (Web Crypto, `crypto.subtle`, no npm deps) and exchanges
it for a short-lived installation token on every call. Same approach as
[`cloudflare-code-reviewer`'s Advanced Track](https://github.com/Clawbuilders/cloudflare-code-reviewer).

Outbound calls (listing/creating/commenting on Issues) don't need a
webhook — the App's own REST auth handles that. Only set up the webhook
step below if you also want [step 6's comment trigger](#6-optional-trigger-a-run-by-commenting-run-qa),
otherwise leave it inactive.

1. Register under your **org** (not personal account):
   `github.com/organizations/<org>/settings/apps/new`.
2. Name it without "bot" in the name — GitHub auto-appends `[bot]` in
   comments/commits (`web-qa-jev-agent` → `web-qa-jev-agent[bot]`).
3. Skip **Identifying and authorizing users** entirely (delete the empty
   Redirect URI row).
4. **Webhook**: leave inactive, *unless* you want step 6's comment trigger —
   in that case: Active, URL = `https://<your-worker>.workers.dev/webhook/github`,
   generate + save the webhook secret immediately (GitHub only shows it
   once).
5. **Permissions**: only
   - Repository permissions → **Issues: Read and write**
   - Repository permissions → **Contents: Read and write** (for uploading
     screenshots into `qa-screenshots/`)
   - If you enabled the webhook in step 4: a **Subscribe to events**
     checkbox for **Issue comment** appears once the Issues permission is
     set above — check it, or GitHub delivers nothing, silently, forever
     (same gotcha the code-reviewer's Advanced Track docs already call out
     for `pull_request`; diagnose via the App's own **Settings → Advanced
     → Recent Deliveries**, not the Worker's logs, if this happens to you).
6. **Where can this be installed?** → Only on this account.
7. **Create GitHub App**, then **Generate a private key** (downloads a
   `.pem`) and note the **App ID** on the same page.
8. **Install App** on just the target repo. The installation URL's last
   path segment is the **installation ID** you'll need below (e.g.
   `github.com/organizations/<org>/settings/installations/12345678` → `12345678`).

Convert the key format — GitHub gives you PKCS#1, Cloudflare's Web Crypto
needs PKCS#8:
```bash
openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out pkcs8-key.pem
```

You now have everything this step needs: the **App ID**, the converted
**private key file**, and the **installation ID**. Don't set them as
secrets yet — that happens together with every other value in step 5, as
part of the very first deploy.

> **Never let raw private-key material pass through a chat/AI coding
> assistant** — copy it directly from the local file into the terminal
> prompt or the Cloudflare dashboard. If it ever leaks into a session
> anyway, treat it as compromised and rotate immediately (generating a new
> private key invalidates the old one instantly).

### 2. Create your own KV namespace for coverage memory

`cloudflare.config.ts`'s `COVERAGE` binding ships with the real namespace ID
from this repo's own deployed account, since KV namespace IDs are
account-scoped and a template can't meaningfully commit one that works for
everyone. If you're deploying your own copy (not just redeploying this
exact Worker), create your own and swap the ID in:

```bash
cf kv namespaces create COVERAGE
# paste the "id" it prints into cloudflare.config.ts's COVERAGE binding
# (wrangler equivalent: npx wrangler kv namespace create COVERAGE, into wrangler.json's kv_namespaces entry)
```

The 1-click **Deploy to Cloudflare Workers** button path may provision
this automatically depending on your account; the CLI path above always
works and is the one this was actually tested against.

### 3. Enable Browser Rendering

Browser Rendering isn't on by default, so enable it for your account in the
Cloudflare dashboard (**Workers & Pages → Browser Rendering**) if you
haven't used it before. Free-tier limits matter here: **10 browser-minutes
a day, 3 concurrent sessions, 6 requests/minute.** `cloudflare.config.ts`
now defaults `MAX_PAGES` and `ACTION_BUDGET` to 10 and 10 (both hard-capped at
10 in code regardless of what's configured), running once a month instead
of daily: a once-a-month run can afford to spend a full session's worth of
budget in one go, rather than rationing a small budget across 30 daily
runs.

This has not been measured against a real deploy. 10 pages times up to 10
interactions each, with every interaction involving a DOM snapshot, a Jev
call, and a click or type with its own wait, could plausibly approach or
exceed the 10-browser-minute/day cap in a single run; watch the first real
run's logs for this. If it happens, lower `ACTION_BUDGET` first (each
interaction is the expensive part), then `MAX_PAGES` if needed. Kitesurf
being the default engine doesn't necessarily help here: Cloudflare's own
benchmarks show it uses less CPU and memory than Chromium but runs 1.7 to
1.8 times slower in wall-clock time, and the free-tier cap is a wall-clock
browser-minutes budget, not a CPU budget.

No separate setup is needed for Kitesurf itself: it's a typed option
(`{ browser: "kitesurf" }`) on the same `BROWSER` binding, not a different
binding or API token.

### 4. Accept the vision model's license

The first time any Worker on your account calls
`@cf/meta/llama-3.2-11b-vision-instruct`, Cloudflare requires you to accept
Meta's license for it — do this once in the dashboard's Workers AI model
page before your first real run, or the escalation step will fail on every
flagged page.

### 5. Decide your remaining values, then deploy

You need four more plain values before deploying — none of these are
created anywhere, just decided:

- **`GITHUB_OWNER`** — your GitHub org or username (the one that owns the
  App from step 1).
- **`GITHUB_REPO`** — the repo Issues should be filed on, without the
  owner (e.g. `clawbuilders-main`, not `Clawbuilders/clawbuilders-main` —
  it's easy to grab the wrong one if you copy a folder name instead of
  checking `git remote -v`).
- **`TARGET_URL`** — the site to crawl, e.g. `https://clawbuilders.club`.
- **`RUN_TOKEN`** — any random string, gates the manual `/run` route:
  `openssl rand -hex 24` works fine.

Now deploy — **choose one path**:

**A. One-click button.** Click **Deploy to Cloudflare Workers** above. Its
setup screen shows a field for every required secret (`GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_OWNER`,
`GITHUB_REPO`, `TARGET_URL`, `RUN_TOKEN`) plus a KV namespace picker with a
**+ Create new** option — fill in every field (the button won't let you
submit with any left blank; that's its own native form validation, not a
network round-trip) and click **Deploy**.

**B. CLI, with a secrets file.** A bare `cf deploy` on a Worker that
doesn't exist yet fails on purpose — verified directly: *"This Worker does
not exist yet, so secrets cannot be set in advance... supply them via a
secrets file."* Build one and deploy with it:

```bash
cat > secrets.env << 'EOF'
GITHUB_APP_ID=<your App ID>
GITHUB_APP_INSTALLATION_ID=<your installation ID>
GITHUB_OWNER=<your GitHub org or username>
GITHUB_REPO=<the repo name, without the owner>
TARGET_URL=https://clawbuilders.club
RUN_TOKEN=<the random string you generated above>
EOF
```

`GITHUB_APP_PRIVATE_KEY` needs its own file, converted from what GitHub
gave you (PKCS#1) to what Cloudflare's Web Crypto needs (PKCS#8) — do this
before deploying:

```bash
openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out pkcs8-key.pem
echo "GITHUB_APP_PRIVATE_KEY=$(cat pkcs8-key.pem)" >> secrets.env
cf deploy --secrets-file secrets.env
rm secrets.env pkcs8-key.pem
```

> **Never let raw private-key material pass through a chat/AI coding
> assistant** — copy it directly from the local file into the terminal
> prompt or the Cloudflare dashboard. If it ever leaks into a session
> anyway, treat it as compromised and rotate immediately (generating a new
> private key invalidates the old one instantly).

Once this first deploy succeeds, every later `cf deploy` is a plain,
argument-free `cf deploy` — verified directly that a bare redeploy
afterward correctly keeps all the secrets you just set, because they're
each declared with `bindings.secret()` in `cloudflare.config.ts`.
`wrangler deploy` still works too and never had any of the above problem
in the first place, since it never required secrets to exist before a
first deploy — see "Local development" below.

### 6. (Optional) Enable a run-on-demand comment trigger

Only relevant if you turned the webhook on in step 1. `GITHUB_WEBHOOK_SECRET`
is deliberately **not** one of the required secrets above — it's genuinely
optional (`src/webhook.ts` 404s cleanly without it), and `bindings.secret()`
has no "optional" mode, so declaring it would force everyone to set it just
to get any deploy through. Set it any time after your first successful
deploy:

```bash
cf workers secrets bulk --worker web-qa-jev-agent --body '{"GITHUB_WEBHOOK_SECRET": {"type": "secret_text", "text": "<the secret you generated in step 1>"}}'
# wrangler equivalent: npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

Then comment `/run-qa` anywhere in the body of any issue or PR on the
target repo — the webhook verifies the delivery's `X-Hub-Signature-256`
against that secret, checks the commenter's `author_association` is
`OWNER`/`MEMBER`/`COLLABORATOR` (a run costs real Browser Rendering +
Workers AI usage, so it's gated to people with write access, not every
public commenter), and kicks off the same pipeline the cron runs — then
comments back on that issue/PR with the result once it finishes (page
count, findings, issues filed/matched).

**Because it's undeclared, not just unset, a plain `cf deploy` after you've
set it will silently drop it again** — same mechanism as the "bigger trap"
above, just deliberately accepted here rather than fixed, since there's no
way to declare an optional secret. Re-run the `bulk` command above after
any deploy that happens to follow setting this one.

### 7. (Optional) Tune the QA goal and engine routing

`QA_GOAL` has the exact same undeclared-on-purpose tradeoff as
`GITHUB_WEBHOOK_SECRET` above — set any time after your first deploy, but
know a later plain `cf deploy` will drop it again:

```bash
cf workers secrets bulk --worker web-qa-jev-agent --body '{"QA_GOAL": {"type": "secret_text", "text": "Test the event registration flow end to end"}}'
# wrangler equivalent: npx wrangler secret put QA_GOAL
```

`CHROMIUM_ONLY_PATTERNS` (a `cloudflare.config.ts` var, default empty) is a
comma-separated list of URL substrings that always route to Chromium
regardless of what the Jev router decides. Useful for known-authenticated
paths you don't want the router guessing about.

`REVISIT_RATE` (a `cloudflare.config.ts` var, default `0.3`) is the fraction of
`MAX_PAGES` reserved for regression-checking pages this Worker has crawled
before, instead of finding new ones. `0` disables it entirely (pure
exploration, closer to the old behavior); closer to `1` spends most of the
budget re-verifying known ground. `0.3` means roughly a third of a run's
pages are deliberate re-checks and the rest are biased toward new ones.

### 8. Verify

```bash
curl "https://web-qa-jev-agent.<your-subdomain>.workers.dev/run?token=<RUN_TOKEN>"
```

(The deployed Worker's own name/URL is left as `web-qa-jev-agent` on
purpose — only the repo and package were renamed, so the live URL from
before this redesign keeps working. Rename the Worker yourself in
`cloudflare.config.ts`'s `worker.name` and redeploy if you want the URL to
match.)

Returns a JSON summary (`pagesVisited`, `flagged`, `filed`, `duplicates`,
`engineBreakdown`). Check the target repo's Issues tab — anything filed
carries the `web-qa-jev-agent` label, the engine used, actions attempted,
plus a screenshot committed under `qa-screenshots/`.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values, never commit this file
npm install
npm run dev   # cf dev — remote resources by default; Browser Rendering does NOT work in local mode
             # (wrangler equivalent: wrangler dev --remote)
```

`npm run typecheck` runs `tsc --noEmit`.

## Schedule

The cron in `cloudflare.config.ts` (`0 14 1 * *`, UTC) runs once a month, on the
1st. Standard cron has no native "every 4 weeks" (there's no week-counter
field, only day-of-month/month/day-of-week), so a fixed day each month is
the practical equivalent, roughly every 4.3 weeks rather than exactly 4.
Chosen deliberately over a daily run: a site's content and behavior mostly
doesn't change day to day, so a daily crawl with a small budget was mostly
re-testing the same few things over and over; running less often but with
the budget maxed out gets more real coverage per run instead.

**Monthly is a default for this project, not a recommendation for yours.**
Change `cloudflare.config.ts`'s cron trigger to whatever matches how often your own site
actually changes: a project shipping multiple times a day probably wants
weekly or even daily again, now that the coverage memory below (not the
old budget-less daily loop) is what actually spreads exploration out
across runs. Lean on the `/run` route for on-demand checks any time; it
calls the exact same pipeline as the cron.

## Limitations (read before treating this as a real QA tool)

- **Coverage memory is real now, but approximate.** `src/coverage.ts` keeps
  a KV-backed index of pages and actions tried before, and both the crawl
  order and the action loop's per-element choice now actually use it
  (fixed: the action loop used to be *told* to prefer unexplored elements
  while being given no data to know what "already tried" even meant.
  `state` now carries this visit's history, and each element's KV history
  is in its description). Two real approximations remain, not hidden:
  element identity is a `kind:label` string hash (`actionSignature()`), so
  a copy change across deploys looks like a brand-new element rather than
  the same one, which under-counts history rather than misattributing it;
  and "did this action find something" is really "did the *page* it was
  tried on get flagged," since triage judges a whole page's signals, not
  one interaction: a reasonable proxy, not precise per-action causality.
- **No coordination between overlapping runs.** The coverage index is one
  KV value, read once at the start of a run and written once after
  triage. Two runs overlapping (a cron firing while a manual `/run` is
  still going) could race and the slower one's write would clobber the
  faster one's. Not a real risk at a monthly or weekly cadence with no
  concurrency, but worth knowing before cranking the cron frequency way up.
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
