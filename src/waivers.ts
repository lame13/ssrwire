import type { AuditTarget, Finding, TargetAuditResult, WaiverRecord } from "./types.js";

/** Waiver codes that are informational about the waiver policy itself, not about a target. */
export const EXPIRED_WAIVER_CODE = "waiver-expired";
export const UNUSED_WAIVER_CODE = "waiver-unused";

export interface WaiverOutcome {
  readonly results: readonly TargetAuditResult[];
  /** Waivers that suppressed at least one finding in this run. */
  readonly applied: readonly WaiverRecord[];
  readonly waived: number;
}

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A waiver is valid through the end of its `until` date, so a waiver dated today still applies.
 * Dates are compared as ISO strings, which sorts identically to calendar order.
 */
export function isWaiverExpired(waiver: WaiverRecord, now: Date): boolean {
  return waiver.until !== undefined && todayUtc(now) > waiver.until;
}

function matchesTarget(waiver: WaiverRecord, target: AuditTarget): boolean {
  if (waiver.target === undefined) {
    return true;
  }
  return waiver.target === target.id || waiver.target === target.url;
}

function matchesFinding(waiver: WaiverRecord, target: AuditTarget, finding: Finding): boolean {
  if (waiver.code !== "*" && waiver.code !== finding.code) {
    return false;
  }
  if (!matchesTarget(waiver, target)) {
    return false;
  }
  if (waiver.agent !== undefined && waiver.agent !== finding.agent) {
    return false;
  }
  return true;
}

function diagnostic(
  code: string,
  severity: Finding["severity"],
  waiver: WaiverRecord,
  url: string,
  detail: string,
): Finding {
  return {
    code,
    severity,
    message: `${detail} Reason: ${waiver.reason}`,
    url,
    ...(waiver.agent === undefined ? {} : { agent: waiver.agent }),
    evidence: {
      waiverCode: waiver.code,
      ...(waiver.target === undefined ? {} : { target: waiver.target }),
      ...(waiver.until === undefined ? {} : { until: waiver.until }),
      reason: waiver.reason,
    },
  };
}

/**
 * Apply waived findings and report on the waiver policy itself.
 *
 * Suppression happens before summarizing so that waived findings neither fail a run nor inflate
 * its warning count. Expired waivers stop suppressing and say so, and waivers that matched
 * nothing are reported as unused.
 */
export function applyWaivers(
  results: readonly TargetAuditResult[],
  waivers: readonly WaiverRecord[],
  now: Date = new Date(),
): WaiverOutcome {
  if (waivers.length === 0) {
    return { results, applied: [], waived: 0 };
  }

  const usage = new Map<WaiverRecord, number>(waivers.map((waiver) => [waiver, 0]));
  let waived = 0;

  const nextResults = results.map((result) => {
    const kept: Finding[] = [];
    for (const finding of result.findings) {
      const candidates = waivers.filter((waiver) => matchesFinding(waiver, result.target, finding));
      const active = candidates.find((waiver) => !isWaiverExpired(waiver, now));
      if (active === undefined) {
        kept.push(finding);
        continue;
      }
      usage.set(active, (usage.get(active) ?? 0) + 1);
      waived += 1;
    }
    return { ...result, findings: kept };
  });

  // Waiver diagnostics are reported once, attached to a target the waiver plausibly concerns so
  // that terminal and HTML reports have somewhere to show them.
  const anchorFor = (waiver: WaiverRecord): TargetAuditResult | undefined =>
    nextResults.find((result) => waiver.target === result.target.id) ??
    nextResults.find((result) => waiver.target === result.target.url) ??
    nextResults[0];

  const diagnostics: Finding[] = [];
  for (const waiver of waivers) {
    const used = usage.get(waiver) ?? 0;
    const anchor = anchorFor(waiver);
    if (anchor === undefined) {
      continue;
    }
    if (isWaiverExpired(waiver, now)) {
      diagnostics.push(
        diagnostic(
          EXPIRED_WAIVER_CODE,
          "warning",
          waiver,
          anchor.target.url,
          `Waiver expired on ${waiver.until ?? "an earlier date"}, so it no longer suppresses ` +
            `${waiver.code}. Remove it or extend the date.`,
        ),
      );
      continue;
    }
    if (used === 0) {
      diagnostics.push(
        diagnostic(
          UNUSED_WAIVER_CODE,
          "info",
          waiver,
          anchor.target.url,
          `Waiver for ${waiver.code} suppressed no findings in this run. Check whether it is still needed.`,
        ),
      );
    }
  }

  if (diagnostics.length === 0) {
    return {
      results: nextResults,
      applied: waivers.filter((waiver) => (usage.get(waiver) ?? 0) > 0),
      waived,
    };
  }

  const grouped = new Map<TargetAuditResult, Finding[]>();
  for (const finding of diagnostics) {
    const anchor =
      nextResults.find((result) => result.target.url === finding.url) ?? nextResults[0];
    if (anchor === undefined) continue;
    grouped.set(anchor, [...(grouped.get(anchor) ?? []), finding]);
  }

  return {
    results: nextResults.map((result) => {
      const extra = grouped.get(result);
      return extra === undefined ? result : { ...result, findings: [...result.findings, ...extra] };
    }),
    applied: waivers.filter((waiver) => (usage.get(waiver) ?? 0) > 0),
    waived,
  };
}
