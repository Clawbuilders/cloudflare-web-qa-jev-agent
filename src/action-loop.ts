import type { Page } from "@cloudflare/puppeteer";
import type { Env } from "./types";
import { redact } from "./redact";

// page.evaluate()/ElementHandle.evaluate() callbacks below run inside the
// remote browser's DOM context, not the Worker's — see explorer.ts's own
// note on why these ambient declarations exist instead of pulling in
// lib.dom.d.ts.
declare const window: any; // eslint-disable-line @typescript-eslint/no-explicit-any

const INTERACTIVE_SELECTOR = "a[href], button, input, textarea, select, [role='button']";
const MAX_ELEMENTS = 25;

type ElementKind = "link" | "button" | "input" | "other";

interface InteractiveElement {
  index: number;
  kind: ElementKind;
  label: string;
  inputType?: string;
}

interface JevActionResponse {
  answers: { next_action: { choice: string } };
}

const FILLER_VALUES: Record<string, string> = {
  email: "qa-agent@example.com",
  password: "Qa-Test-Password1!",
  tel: "5555550100",
  number: "1",
  url: "https://example.com",
  search: "test",
};

function fillerFor(inputType: string | undefined): string {
  return (inputType && FILLER_VALUES[inputType]) || "QA test input";
}

/**
 * One atomic snapshot: query all interactive elements once, keep both the
 * live ElementHandles and their description in the same index order. Acting
 * on `handles[i]` later never needs a second DOM query (and therefore can't
 * hit a different element than the one Jev was shown) — this is the
 * "atomic DOM snapshot" half of the browser-use/jev-ultrafast pattern this
 * loop ports; a real DOM mutation between steps is handled by re-snapshotting
 * on the next iteration, not by revalidating a stale handle.
 */
async function snapshot(page: Page): Promise<{ handles: Awaited<ReturnType<Page["$$"]>>; elements: InteractiveElement[] }> {
  const handles = await page.$$(INTERACTIVE_SELECTOR);
  const elements: InteractiveElement[] = [];

  for (let index = 0; index < handles.length && elements.length < MAX_ELEMENTS; index++) {
    const info = await handles[index]!.evaluate((el: any) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      if (!visible || el.disabled) return null;

      const tag = el.tagName.toLowerCase();
      const kind: ElementKind =
        tag === "a"
          ? "link"
          : tag === "button" || el.getAttribute("role") === "button"
            ? "button"
            : tag === "input" || tag === "textarea" || tag === "select"
              ? "input"
              : "other";
      const label =
        el.innerText?.trim().slice(0, 60) ||
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        el.href ||
        tag;

      return { kind, label: String(label).slice(0, 60), inputType: tag === "input" ? el.type : undefined };
    }).catch(() => null);

    if (info) elements.push({ index, ...info });
  }

  return { handles, elements };
}

/**
 * Ports the core idea from browser-use/jev-ultrafast: one DOM snapshot of
 * visible interactive elements per step, one Jev call picks the next
 * indexed action (or "done"), repeat up to ACTION_BUDGET times. This is
 * what turns the crawl from "follow <a href> links and read" into "act
 * like a QA tester" — filling in forms and clicking through flows.
 *
 * Any single failed interaction or an unreachable Jev call just ends the
 * loop early rather than throwing — the page's own console/network/error
 * listeners (wired by the caller in explorer.ts) already captured anything
 * genuinely broken up to that point.
 */
export async function runActionLoop(
  env: Env,
  page: Page,
  goal: string,
): Promise<{ actionsAttempted: string[] }> {
  const budget = Math.max(1, Math.min(10, parseInt(env.ACTION_BUDGET, 10) || 4));
  const actionsAttempted: string[] = [];

  for (let step = 0; step < budget; step++) {
    const { handles, elements } = await snapshot(page).catch(() => ({ handles: [], elements: [] }));
    if (elements.length === 0) break;

    const criteria: Record<string, string> = {
      done: "Nothing more useful to interact with here — move on to the next page",
    };
    for (const el of elements) {
      criteria[String(el.index)] = `${el.kind}: ${redact(el.label)}`;
    }

    let choice: string;
    try {
      const response = (await env.AI.run("typesafe/jev", {
        state: { goal, step: step + 1, of: budget },
        questions: {
          next_action: {
            type: "choice",
            instructions:
              "Acting as an automated QA tester pursuing the stated goal, which element on this page is most worth interacting with next? Prefer forms, buttons, and unexplored elements over ones already tried this run.",
            criteria,
          },
        },
      })) as unknown as JevActionResponse;
      choice = response.answers.next_action.choice;
    } catch {
      break;
    }

    if (choice === "done") break;

    const chosenIndex = parseInt(choice, 10);
    const chosen = elements.find((el) => el.index === chosenIndex);
    const handle = handles[chosenIndex];
    if (!chosen || !handle) break;

    try {
      if (chosen.kind === "input") {
        const value = fillerFor(chosen.inputType);
        await handle.type(value, { delay: 10 });
        actionsAttempted.push(`typed into ${chosen.label || "input"}`);
      } else {
        await handle.click({ delay: 10 });
        actionsAttempted.push(`clicked ${chosen.kind} "${chosen.label}"`);
        await page.waitForNetworkIdle({ timeout: 3000 }).catch(() => undefined);
      }
    } catch (err) {
      actionsAttempted.push(`failed to interact with ${chosen.kind} "${chosen.label}": ${redact(String(err)).slice(0, 120)}`);
    }
  }

  return { actionsAttempted };
}
