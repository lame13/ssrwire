import { describe, expect, it } from "vitest";
import {
  auditVerdict,
  detectedFrameworkLabel,
  explainFinding,
  nextSteps,
  targetVerdict,
} from "../src/explain.js";
import type { Finding, TargetAuditResult } from "../src/types.js";

function finding(code: string, overrides: Partial<Finding> = {}): Finding {
  return {
    code,
    severity: "warning",
    message: `${code} message`,
    url: "https://example.com/page",
    ...overrides,
  };
}

function result(overrides: Partial<TargetAuditResult> = {}): TargetAuditResult {
  return {
    target: {
      url: "https://example.com/page",
      expectations: {
        statuses: [200],
        requireTitle: true,
        requireDescription: true,
        requireCanonical: true,
        requireH1: true,
        requireMainText: true,
      },
    },
    probes: [
      {
        requestedUrl: "https://example.com/page",
        finalUrl: "https://example.com/page",
        agent: {
          key: "googlebot",
          label: "Googlebot",
          userAgent: "Googlebot UA",
          requiresHeadMetadata: false,
        },
        status: 200,
        redirects: [],
        headers: { values: {}, setCookiePresent: false },
        timings: { headersMs: 10, firstByteMs: 15, completeMs: 50 },
        bytesRead: 1_000,
        signals: { descriptions: [], canonicals: [], robots: [], h1s: [], jsonLd: [] },
        completion: "complete",
      },
    ],
    findings: [],
    ...overrides,
  };
}

describe("explainFinding", () => {
  it("explains a known finding in plain language", () => {
    const explanation = explainFinding(finding("missing-title", { severity: "error" }));
    expect(explanation).toMatchObject({
      code: "missing-title",
      title: "No title in the HTML",
    });
    expect(explanation.means.length).toBeGreaterThan(20);
    expect(explanation.impact).toContain("Search results");
    expect(explanation.fix.length).toBeGreaterThan(20);
    expect(explanation.generic).toBeUndefined();
  });

  it("explains repeated, conflicting, and drifting findings", () => {
    expect(explainFinding(finding("duplicate-canonical")).title).toContain("canonical link");
    expect(explainFinding(finding("conflicting-robots")).title).toContain("conflicting");
    expect(explainFinding(finding("agent-title-drift")).title).toContain("title");
    expect(explainFinding(finding("agent-open-graph-drift")).title).toContain("Open Graph");
  });

  it("falls back to the recorded message for an unrecognized code", () => {
    const explanation = explainFinding(finding("brand-new-check"));
    expect(explanation.generic).toBe(true);
    expect(explanation.title).toBe("Brand new check");
    expect(explanation.means).toBe("brand-new-check message");
  });

  it("adds a framework fix recipe only when one exists", () => {
    const nextjs = { key: "nextjs" as const, label: "Next.js", evidence: "fixture" };
    expect(explainFinding(finding("missing-title"), { framework: nextjs }).snippet).toMatchObject({
      label: "Next.js example",
    });
    expect(
      explainFinding(finding("status-mismatch"), { framework: nextjs }).snippet,
    ).toBeUndefined();
    expect(
      explainFinding(finding("missing-title"), {
        framework: { key: "unknown", label: "an unidentified stack", evidence: "fixture" },
      }).snippet,
    ).toBeUndefined();
  });
});

describe("detectedFrameworkLabel", () => {
  it("names a detection, and stays human when there is nothing to name", () => {
    const nextjs = { key: "nextjs" as const, label: "Next.js", evidence: "fixture" };
    const unknown = {
      key: "unknown" as const,
      label: "an unidentified stack",
      evidence: "fixture",
    };

    expect(detectedFrameworkLabel(nextjs)).toBe("Next.js");
    expect(detectedFrameworkLabel(unknown)).toBe("an unidentified stack");
    expect(detectedFrameworkLabel(undefined)).toBe("an unidentified stack");
  });
});

describe("targetVerdict", () => {
  it("reports a clean target as passed", () => {
    expect(targetVerdict(result())).toMatchObject({ kind: "pass" });
  });

  it("prioritizes incomplete probes over findings", () => {
    const incomplete = result({ findings: [finding("missing-title", { severity: "error" })] });
    const probe = incomplete.probes[0];
    if (!probe) throw new Error("Fixture probe is missing.");
    expect(
      targetVerdict({
        ...incomplete,
        probes: [{ ...probe, completion: "timeout" }],
      }),
    ).toMatchObject({ kind: "incomplete" });
  });

  it("separates blocking errors from warnings", () => {
    expect(
      targetVerdict(result({ findings: [finding("missing-title", { severity: "error" })] })).kind,
    ).toBe("blocked");
    expect(targetVerdict(result({ findings: [finding("missing-description")] })).kind).toBe(
      "attention",
    );
  });
});

describe("auditVerdict", () => {
  it("counts affected pages instead of raw findings", () => {
    const audit = {
      schemaVersion: 1 as const,
      version: "0.5.0",
      generatedAt: "2026-09-17T00:00:00.000Z",
      durationMs: 10,
      results: [
        result({ findings: [finding("missing-title", { severity: "error" })] }),
        result({
          target: { url: "https://example.com/other", expectations: result().target.expectations },
          findings: [finding("missing-h1", { severity: "error" })],
        }),
      ],
      summary: { targets: 2, probes: 2, errors: 2, warnings: 0, info: 0, incomplete: 0 },
    };
    expect(auditVerdict(audit)).toMatchObject({
      kind: "blocked",
      headline: "2 pages need attention before release",
    });
  });
});

describe("nextSteps", () => {
  it("deduplicates by explanation, keeps the highest severity, and sorts errors first", () => {
    const steps = nextSteps([
      finding("missing-description", { agent: "browser" }),
      finding("missing-description", { agent: "googlebot" }),
      finding("missing-title", { severity: "error", agent: "bingbot" }),
    ]);

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      severity: "error",
      title: "No title in the HTML",
      occurrences: 1,
    });
    expect(steps[1]).toMatchObject({ occurrences: 2, title: "No meta description" });
  });
});
