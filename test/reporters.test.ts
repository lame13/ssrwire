import { describe, expect, it } from "vitest";
import { renderJson, renderReport, renderSarif, renderTerminal } from "../src/reporters.js";
import type { AuditResult, ProbeResult, TargetAuditResult } from "../src/types.js";

const probe: ProbeResult = {
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
  headers: { values: { "content-type": "text/html" }, setCookiePresent: false },
  timings: { headersMs: 10, firstByteMs: 20, completeMs: 80 },
  bytesRead: 900,
  signals: {
    title: { value: "Example", location: "head", atMs: 25, observedByByte: 100 },
    descriptions: [{ value: "Description", location: "head", atMs: 30, observedByByte: 150 }],
    canonicals: [
      {
        value: "https://example.com/page",
        location: "head",
        atMs: 35,
        observedByByte: 200,
      },
    ],
    robots: [],
    h1s: [{ value: "Heading", location: "body", atMs: 45, observedByByte: 400 }],
    firstMainText: { value: "Main", location: "body", atMs: 50, observedByByte: 500 },
    jsonLd: [],
  },
  completion: "complete",
};

const targetResult: TargetAuditResult = {
  target: {
    url: "https://example.com/page",
    expectations: {
      statuses: [200],
      requireTitle: true,
      requireDescription: true,
      requireCanonical: true,
      requireH1: false,
      requireMainText: false,
    },
  },
  probes: [probe],
  findings: [
    {
      code: "missing-description",
      severity: "warning",
      message: "Googlebot received no non-empty meta description.",
      url: "https://example.com/page",
      agent: "googlebot",
      evidence: { observed: false },
    },
  ],
};

const audit: AuditResult = {
  version: "0.1.0",
  generatedAt: "2026-08-22T00:00:00.000Z",
  durationMs: 123,
  results: [targetResult],
  summary: { targets: 1, probes: 1, errors: 0, warnings: 1, info: 0, incomplete: 0 },
};

describe("renderTerminal", () => {
  it("renders a readable, colorless timing table and finding details", () => {
    const output = renderTerminal(audit, { color: false });

    expect(output).toContain("SSRWire 0.1.0");
    expect(output).toContain("Agent");
    expect(output).toContain("First byte");
    expect(output).toContain("25 ms/head");
    expect(output).toContain("WARNING missing-description [googlebot]");
    expect(output).toContain("Summary: 1 target(s), 1 probe(s)");
    expect(output).not.toContain("\u001b[");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("escapes terminal control sequences from untrusted values", () => {
    const ansiEscape = "\u001B";
    const malicious = `${ansiEscape}]52;c;dG9rZW4=\u0007`;
    const finding = targetResult.findings[0];
    if (!finding) throw new Error("Fixture finding is missing.");
    const maliciousAudit: AuditResult = {
      ...audit,
      results: [
        {
          ...targetResult,
          target: { ...targetResult.target, url: `https://example.com/${malicious}` },
          findings: [{ ...finding, message: malicious }],
        },
      ],
    };

    const rendered = renderTerminal(maliciousAudit, { color: false });
    expect(rendered).not.toContain(ansiEscape);
    expect(rendered).not.toContain("\u0007");
    expect(rendered).toContain("\\u001B");
    expect(rendered).toContain("\\u0007");
  });

  it("adds ANSI styling only when requested", () => {
    expect(renderTerminal(audit, { color: true })).toContain("\u001b[");
  });
});

describe("structured reporters", () => {
  it("renders deterministic JSON with a trailing newline", () => {
    const output = renderJson(audit);

    expect(JSON.parse(output)).toEqual(audit);
    expect(output.indexOf('"durationMs"')).toBeLessThan(output.indexOf('"generatedAt"'));
    expect(output.endsWith("\n")).toBe(true);
    expect(renderReport(audit, "json")).toBe(output);
  });

  it("renders SARIF 2.1.0 with a rule, level, and URL location", () => {
    const output = renderSarif(audit);
    const sarif = JSON.parse(output) as {
      version: string;
      runs: Array<{
        tool: { driver: { informationUri: string; rules: Array<{ id: string }> } };
        results: Array<{
          ruleId: string;
          level: string;
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
        }>;
      }>;
    };

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.tool.driver.informationUri).toBe("https://nikom.work");
    expect(sarif.runs[0]?.tool.driver.rules).toContainEqual(
      expect.objectContaining({ id: "missing-description" }),
    );
    expect(sarif.runs[0]?.results[0]).toEqual(
      expect.objectContaining({ ruleId: "missing-description", level: "warning" }),
    );
    expect(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
      "https://example.com/page",
    );
    expect(output.endsWith("\n")).toBe(true);
  });
});
