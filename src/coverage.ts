import type { Env } from "./types";

const INDEX_KEY = "site-index:v1";
const MAX_INDEX_PAGES = 300;
const MAX_ACTIONS_PER_PAGE = 15;

export interface ActionRecord {
  tries: number;
  lastTriedAt: string;
  /** Whether the PAGE this action was tried on got flagged by triage that
   * run. Not true per-action attribution (triage judges a whole page's
   * signals, not one interaction) — an approximation, documented as such
   * in the README, not something this code pretends is more precise than
   * it is. */
  lastHadFinding: boolean;
}

export interface PageRecord {
  visits: number;
  lastVisitedAt: string;
  lastHadFinding: boolean;
  actions: Record<string, ActionRecord>;
}

export interface SiteIndex {
  pages: Record<string, PageRecord>;
}

/** Stable-ish key for "the same interactive element" across runs. Element
 * labels can drift across deploys (copy changes, re-ordering), so this is
 * a best-effort identity, not a guaranteed one — a changed label just
 * looks like a brand-new action, which is a safe failure mode (worst case,
 * under-counts history) rather than a dangerous one (misattributing
 * history to the wrong element). */
export function actionSignature(kind: string, label: string): string {
  return `${kind}:${label.trim().toLowerCase()}`.slice(0, 120);
}

/**
 * One read at the start of a crawl. Coverage memory is a nice-to-have that
 * biases exploration order — it should never fail the crawl itself, so
 * any read error or first-ever run just yields an empty index.
 */
export async function loadIndex(env: Env): Promise<SiteIndex> {
  try {
    const raw = await env.COVERAGE.get(INDEX_KEY);
    if (!raw) return { pages: {} };
    return JSON.parse(raw) as SiteIndex;
  } catch {
    return { pages: {} };
  }
}

/**
 * Picks up to `count` already-known pages worth revisiting as a
 * regression check, prioritized by: pages that previously found
 * something first (did the fix hold, or is it still broken?), then the
 * most stale pages among the rest. Returns URLs only; the caller still
 * runs them through the normal visit/action-loop pipeline.
 */
export function pickRevisitCandidates(index: SiteIndex, count: number): string[] {
  if (count <= 0) return [];
  const entries = Object.entries(index.pages);
  entries.sort(([, a], [, b]) => {
    if (a.lastHadFinding !== b.lastHadFinding) return a.lastHadFinding ? -1 : 1;
    return new Date(a.lastVisitedAt).getTime() - new Date(b.lastVisitedAt).getTime();
  });
  return entries.slice(0, count).map(([url]) => url);
}

export interface PageOutcome {
  url: string;
  hadFinding: boolean;
  actionSignatures: { signature: string; hadFinding: boolean }[];
}

/**
 * Merges this run's visits and action outcomes into the index and writes
 * it back in one call. Evicts the stalest pages/actions first when over
 * the caps so the index can't grow unbounded on a large or long-lived
 * site. Called once, after triage, from pipeline.ts — explorer.ts only
 * reads coverage (for crawl-order bias), it never writes.
 */
export async function saveCoverage(env: Env, index: SiteIndex, outcomes: PageOutcome[]): Promise<void> {
  const now = new Date().toISOString();

  for (const outcome of outcomes) {
    const existing: PageRecord = index.pages[outcome.url] ?? {
      visits: 0,
      lastVisitedAt: now,
      lastHadFinding: false,
      actions: {},
    };
    existing.visits += 1;
    existing.lastVisitedAt = now;
    existing.lastHadFinding = outcome.hadFinding;

    for (const action of outcome.actionSignatures) {
      const prior = existing.actions[action.signature];
      existing.actions[action.signature] = {
        tries: (prior?.tries ?? 0) + 1,
        lastTriedAt: now,
        lastHadFinding: action.hadFinding,
      };
    }

    const actionEntries = Object.entries(existing.actions);
    if (actionEntries.length > MAX_ACTIONS_PER_PAGE) {
      actionEntries.sort(([, a], [, b]) => new Date(b.lastTriedAt).getTime() - new Date(a.lastTriedAt).getTime());
      existing.actions = Object.fromEntries(actionEntries.slice(0, MAX_ACTIONS_PER_PAGE));
    }

    index.pages[outcome.url] = existing;
  }

  const pageEntries = Object.entries(index.pages);
  if (pageEntries.length > MAX_INDEX_PAGES) {
    pageEntries.sort(([, a], [, b]) => new Date(b.lastVisitedAt).getTime() - new Date(a.lastVisitedAt).getTime());
    index.pages = Object.fromEntries(pageEntries.slice(0, MAX_INDEX_PAGES));
  }

  try {
    await env.COVERAGE.put(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Best-effort — a failed write just means next run's memory is a bit
    // stale, not a broken pipeline.
  }
}
