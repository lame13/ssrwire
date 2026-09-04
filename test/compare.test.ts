import { describe, expect, it } from "vitest";
import { ComparisonError, compareAudits } from "../src/compare.js";
import type {
  AuditResult,
  AuditTarget,
  Finding,
  ProbeResult,
  TargetAuditResult,
} from "../src/types.js";

const agent = {
  key: "twitterbot",
  label: "Twitterbot",
  userAgent: "Twitterbot/1.0",
  requiresHeadMetadata: true,
} as const;

function target(url: string, id = "page"): AuditTarget {
  return {
    id,
    url,
    expectations: {
      statuses: [200],
      requireTitle: true,
      requireDescription: true,
      requireCanonical: true,
      requireH1: true,
      requireMainText: true,
      requireOpenGraph: false,
      requireTwitterCard: false,
    },
  };
}

interface ProbeOverrides {
  readonly title?: string;
  readonly titleLocation?: "head" | "body";
  readonly status?: number;
  readonly completion?: ProbeResult["completion"];
  readonly firstByteMs?: number;
  readonly completeMs?: number;
}

function probe(url: string, overrides: ProbeOverrides = {}): ProbeResult {
  const title = overrides.title ?? "Example";
  const titleLocation = overrides.titleLocation ?? "head";
  const completion = overrides.completion ?? "complete";
  const firstByteMs = overrides.firstByteMs ?? 100;
  const completeMs = overrides.completeMs ?? 1_000;
  return {
    requestedUrl: url,
    finalUrl: url,
    agent,
    ...(overrides.status === undefined && completion !== "complete"
      ? {}
      : { status: overrides.status ?? 200 }),
    redirects: [],
    headers: { values: { "content-type": "text/html" }, setCookiePresent: false },
    timings: {
      headersMs: 80,
      ...(completion === "network-error" ? {} : { firstByteMs }),
      ...(completion === "complete" ? { completeMs } : {}),
    },
    bytesRead: completion === "complete" ? 1_000 : 100,
    signals: {
      title: { value: title, location: titleLocation, atMs: 110, observedByByte: 100 },
      descriptions: [{ value: "Description", location: "head", atMs: 120, observedByByte: 180 }],
      canonicals: [{ value: url, location: "head", atMs: 130, observedByByte: 240 }],
      robots: [],
      socialMetadata: [],
      h1s: [{ value: "Heading", location: "body", atMs: 160, observedByByte: 500 }],
      firstMainText: { value: "Main", location: "body", atMs: 180, observedByByte: 600 },
      jsonLd: [],
    },
    completion,
  };
}

function result(
  auditTarget: AuditTarget,
  probes: readonly ProbeResult[],
  findings: readonly Finding[] = [],
): TargetAuditResult {
  return { target: auditTarget, probes, findings };
}

function audit(results: readonly TargetAuditResult[], repeat = 1): AuditResult {
  const findings = results.flatMap((item) => item.findings);
  const probes = results.flatMap((item) => item.probes);
  return {
    schemaVersion: 1,
    version: "0.4.1",
    generatedAt: "2026-09-01T00:00:00.000Z",
    durationMs: 100,
    ...(repeat === 1 ? {} : { repeat }),
    results,
    summary: {
      targets: results.length,
      probes: probes.length,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      info: findings.filter((finding) => finding.severity === "info").length,
      incomplete: probes.filter((item) => item.completion !== "complete").length,
    },
  };
}

function finding(code: string, severity: Finding["severity"], url: string): Finding {
  return { code, severity, message: `${code} message`, url, agent: agent.key };
}

describe("compareAudits", () => {
  it("matches stable target ids across origins and records neutral metadata changes", () => {
    const baselineTarget = target("https://www.example.com/page");
    const candidateTarget = target("https://preview.example.net/page");
    const comparison = compareAudits(
      audit([result(baselineTarget, [probe(baselineTarget.url, { title: "Before" })])]),
      audit([result(candidateTarget, [probe(candidateTarget.url, { title: "After" })])]),
    );

    const compared = comparison.results[0];
    expect(compared).toMatchObject({ key: "page", id: "page", status: "matched" });
    expect(compared?.changes).toContainEqual(
      expect.objectContaining({
        kind: "changed",
        scope: "metadata",
        field: "title",
        baseline: "Before",
        candidate: "After",
      }),
    );
    expect(compared?.changes.some((change) => change.code === "final-url-changed")).toBe(false);
    expect(comparison.summary.regressions).toBe(0);
    expect(compared?.timelines[0]?.baseline?.events).toContainEqual(
      expect.objectContaining({ key: "title", medianMs: 110, location: "head" }),
    );
  });

  it("classifies new policy findings as regressions and resolved findings as fixes", () => {
    const page = target("https://example.com/page");
    const comparison = compareAudits(
      audit([
        result(page, [probe(page.url)], [finding("missing-description", "warning", page.url)]),
      ]),
      audit([
        result(page, [probe(page.url)], [finding("head-metadata-in-body", "error", page.url)]),
      ]),
    );

    expect(comparison.results[0]?.changes).toContainEqual(
      expect.objectContaining({ kind: "regression", code: "head-metadata-in-body" }),
    );
    expect(comparison.results[0]?.changes).toContainEqual(
      expect.objectContaining({ kind: "fixed", code: "missing-description" }),
    );
    expect(comparison.summary).toMatchObject({ regressions: 1, fixed: 1 });
  });

  it("requires both timing floors before reporting median regressions", () => {
    const page = target("https://example.com/page");
    const baseline = audit([result(page, [probe(page.url)])]);
    const slow = audit([result(page, [probe(page.url, { firstByteMs: 500, completeMs: 1_500 })])]);
    const noisy = audit([result(page, [probe(page.url, { firstByteMs: 300, completeMs: 1_100 })])]);

    const slowComparison = compareAudits(baseline, slow);
    const regressions = slowComparison.results[0]?.changes.filter(
      (change) => change.code === "timing-regression",
    );
    expect(regressions).toContainEqual(
      expect.objectContaining({ field: "first-byte", baseline: 100, candidate: 500 }),
    );
    expect(regressions).toContainEqual(
      expect.objectContaining({ field: "complete", baseline: 1_000, candidate: 1_500 }),
    );
    expect(
      compareAudits(baseline, noisy).results[0]?.changes.some(
        (change) => change.code === "timing-regression",
      ),
    ).toBe(false);
  });

  it("does not compare required-signal timing when the required policy changed", () => {
    const baselineTarget = target("https://example.com/page");
    const candidateTarget: AuditTarget = {
      ...baselineTarget,
      expectations: { ...baselineTarget.expectations, requireMainText: false },
    };
    const comparison = compareAudits(
      audit([result(baselineTarget, [probe(baselineTarget.url)])]),
      audit([result(candidateTarget, [probe(candidateTarget.url)])]),
      { timingRegressionMs: 0, timingRegressionPercent: 0 },
    );

    expect(comparison.results[0]?.changes).toContainEqual(
      expect.objectContaining({ code: "target-policy-changed" }),
    );
    expect(
      comparison.results[0]?.changes.some(
        (change) => change.scope === "timing" && change.field === "critical-signals",
      ),
    ).toBe(false);
  });

  it("treats newly incomplete probes and findings on added targets as regressions", () => {
    const existing = target("https://example.com/page");
    const added = target("https://example.com/new", "new");
    const candidate = audit([
      result(existing, [probe(existing.url, { completion: "timeout" })]),
      result(added, [probe(added.url)], [finding("missing-title", "error", added.url)]),
    ]);
    const comparison = compareAudits(audit([result(existing, [probe(existing.url)])]), candidate);

    expect(comparison.results[0]?.changes).toContainEqual(
      expect.objectContaining({ kind: "regression", code: "probe-completion-changed" }),
    );
    expect(comparison.results[1]).toMatchObject({ status: "added", key: "new" });
    expect(comparison.results[1]?.changes).toContainEqual(
      expect.objectContaining({ kind: "regression", code: "missing-title" }),
    );
    expect(comparison.summary).toMatchObject({ addedTargets: 1, regressions: 2 });
  });

  it("rejects ambiguous report identities and invalid timing thresholds", () => {
    const first = target("https://example.com/a", "duplicate");
    const second = target("https://example.com/b", "duplicate");
    const duplicated = audit([
      result(first, [probe(first.url)]),
      result(second, [probe(second.url)]),
    ]);

    expect(() => compareAudits(duplicated, audit([]))).toThrow(ComparisonError);
    expect(() => compareAudits(audit([]), audit([]), { timingRegressionMs: -1 })).toThrow(
      "timingRegressionMs must be a finite non-negative number",
    );
  });
});
