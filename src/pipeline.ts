import type { Env } from "./types";
import { explore } from "./explorer";
import { triage } from "./triage";
import { draftFinding } from "./escalate";
import { listOpenIssues, findDuplicate, commentOnIssue, createIssue } from "./github";

export interface RunSummary {
  pagesVisited: number;
  flagged: number;
  filed: { number: number; url: string; title: string }[];
  duplicates: { issueNumber: number; title: string }[];
  engineBreakdown: { kitesurf: number; chromium: number };
}

export async function runPipeline(env: Env): Promise<RunSummary> {
  const floor = parseFloat(env.ESCALATION_FLOOR) || 0.6;

  const pages = await explore(env);
  const triageResults = await Promise.all(pages.map((page) => triage(env, page)));

  const flagged = pages
    .map((page, i) => ({ page, triageResult: triageResults[i]! }))
    .filter(({ triageResult }) => triageResult.isRealBug >= floor);

  const engineBreakdown = pages.reduce(
    (acc, page) => {
      acc[page.engine]++;
      return acc;
    },
    { kitesurf: 0, chromium: 0 },
  );

  const summary: RunSummary = {
    pagesVisited: pages.length,
    flagged: flagged.length,
    filed: [],
    duplicates: [],
    engineBreakdown,
  };
  if (flagged.length === 0) return summary;

  const openIssues = await listOpenIssues(env);

  for (const { page, triageResult } of flagged) {
    const finding = await draftFinding(env, page, triageResult);
    const duplicateOf = await findDuplicate(env, finding, openIssues);

    if (duplicateOf !== null) {
      await commentOnIssue(
        env,
        duplicateOf,
        `Reproduced again by the automated QA run on ${new Date().toISOString().slice(0, 10)} at ${finding.url}.`,
      );
      const matched = openIssues.find((issue) => issue.number === duplicateOf);
      summary.duplicates.push({ issueNumber: duplicateOf, title: matched?.title ?? "" });
    } else {
      const created = await createIssue(env, finding);
      summary.filed.push({ ...created, title: finding.title });
      openIssues.push({ number: created.number, title: finding.title });
    }
  }

  return summary;
}
