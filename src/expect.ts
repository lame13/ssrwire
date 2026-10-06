import { compareAudits } from "./compare.js";
import type { AuditComparison, AuditResult, CompareAuditOptions } from "./types.js";

const DETAIL_LIMIT = 5;

/**
 * Thrown by {@link expectNoRegressions} so a test runner reports the regressions themselves
 * rather than only the fact that an assertion failed.
 */
export class RegressionError extends Error {
  public readonly comparison: AuditComparison;

  public constructor(comparison: AuditComparison) {
    const regressions = comparison.results.flatMap((result) =>
      result.changes
        .filter((change) => change.kind === "regression")
        .map((change) => `${result.key}: ${change.code} — ${change.message}`),
    );
    const shown = regressions.slice(0, DETAIL_LIMIT).map((line) => `  - ${line}`);
    const extra =
      regressions.length > DETAIL_LIMIT
        ? `\n  …and ${regressions.length - DETAIL_LIMIT} more regression(s).`
        : "";
    super(
      `SSRWire found ${regressions.length} regression(s) between the baseline and candidate ` +
        `reports:\n${shown.join("\n")}${extra}`,
    );
    this.name = "RegressionError";
    this.comparison = comparison;
  }
}

/**
 * Compare two audits and throw when the candidate regressed, so deployment checks can live in a
 * test suite next to the rest of the assertions instead of only in a CLI step.
 *
 * @returns the full comparison when there is nothing to fail on.
 */
export function expectNoRegressions(
  baseline: AuditResult,
  candidate: AuditResult,
  options: CompareAuditOptions = {},
): AuditComparison {
  const comparison = compareAudits(baseline, candidate, options);
  if (comparison.summary.regressions > 0) {
    throw new RegressionError(comparison);
  }
  return comparison;
}
