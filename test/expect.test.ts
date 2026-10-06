import { describe, expect, it } from "vitest";
import { expectNoRegressions, RegressionError } from "../src/expect.js";
import type {
  AuditResult,
  AuditTarget,
  Finding,
  ProbeResult,
  TargetAuditResult,
} from "../src/types.js";

const agent = {
  key: "googlebot",
  label: "Googlebot",
  userAgent: "Googlebot UA",
  requiresHeadMetadata: false,
} as const;

const target: AuditTarget = {
  id: "home",
  url: "https://example.com/",
  expectations: {
    statuses: [200],
    requireTitle: true,
    requireDescription: true,
    requireCanonical: true,
    requireH1: true,
    requireMainText: true,
  },
};

function probe(): ProbeResult {
  return {
    requestedUrl: target.url,
    finalUrl: target.url,
    agent,
    status: 200,
    redirects: [],
    headers: { values: { "content-type": "text/html" }, setCookiePresent: false },
    timings: { headersMs: 10, firstByteMs: 20, completeMs: 80 },
    bytesRead: 900,
    signals: {
      title: { value: "Example", location: "head", atMs: 25, observedByByte: 100 },
      descriptions: [],
      canonicals: [],
      robots: [],
      h1s: [],
      jsonLd: [],
    },
    completion: "complete",
  };
}

function audit(findings: readonly Finding[]): AuditResult {
  const result: TargetAuditResult = { target, probes: [probe()], findings };
  return {
    schemaVersion: 2,
    version: "0.6.0",
    generatedAt: "2026-10-06T00:00:00.000Z",
    durationMs: 100,
    results: [result],
    summary: {
      targets: 1,
      probes: 1,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      info: 0,
      incomplete: 0,
      waived: 0,
    },
  };
}

const finding: Finding = {
  code: "missing-description",
  severity: "warning",
  message: "Googlebot received no meta description.",
  url: target.url,
  agent: "googlebot",
};

describe("expectNoRegressions", () => {
  it("returns the comparison when nothing regressed", () => {
    const comparison = expectNoRegressions(audit([finding]), audit([finding]));

    expect(comparison.summary.regressions).toBe(0);
  });

  it("throws a RegressionError that names the regressions", () => {
    try {
      expectNoRegressions(audit([]), audit([finding]));
      throw new Error("Expected expectNoRegressions to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(RegressionError);
      expect(String(error)).toContain("1 regression(s)");
      expect(String(error)).toContain("missing-description");
      expect((error as RegressionError).comparison.summary.regressions).toBe(1);
    }
  });
});
