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
  version: "0.2.0",
  generatedAt: "2026-08-22T00:00:00.000Z",
  durationMs: 123,
  results: [targetResult],
  summary: { targets: 1, probes: 1, errors: 0, warnings: 1, info: 0, incomplete: 0 },
};

describe("renderTerminal", () => {
  it("renders a readable, colorless timing table and finding details", () => {
    const output = renderTerminal(audit, { color: false });

    expect(output).toContain("SSRWire 0.2.0");
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

  it("renders sample attribution and timing aggregates for repeated runs", () => {
    const repeated: AuditResult = {
      ...audit,
      repeat: 2,
      results: [
        {
          ...targetResult,
          probes: [
            { ...probe, sample: 1 },
            {
              ...probe,
              sample: 2,
              timings: { headersMs: 20, firstByteMs: 30, completeMs: 100 },
            },
          ],
          stability: [
            {
              agent: probe.agent,
              samples: 2,
              complete: 2,
              incomplete: 0,
              timings: {
                headers: {
                  samples: 2,
                  minMs: 10,
                  medianMs: 15,
                  p95Ms: 20,
                  maxMs: 20,
                  spreadMs: 10,
                },
              },
              variants: {
                completion: 1,
                status: 1,
                finalUrl: 1,
                redirectChain: 1,
                bodySha256: 1,
                metadataValues: 1,
                metadataLocations: 1,
              },
            },
          ],
        },
      ],
      summary: { ...audit.summary, probes: 2 },
    };

    const output = renderTerminal(repeated, { color: false });
    expect(output).toContain("2 sequential samples per URL and agent");
    expect(output).toContain("Sample");
    expect(output).toContain("Stability timings (nearest-rank p95)");
    expect(output).toContain("Median");
    expect(output).toContain("15 ms");
    expect(JSON.parse(renderJson(repeated)).results[0].stability).toHaveLength(1);
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

  it("maps stability information and warnings to SARIF notes and warnings with evidence", () => {
    const stabilityAudit: AuditResult = {
      ...audit,
      repeat: 2,
      results: [
        {
          ...targetResult,
          findings: [
            {
              code: "stream-instability",
              severity: "info",
              message: "Googlebot returned changing body fingerprints across samples.",
              url: targetResult.target.url,
              agent: "googlebot",
              evidence: {
                samples: 2,
                completeSamples: 2,
                fields: "bodySha256",
                variantCounts: "bodySha256=2",
              },
            },
            {
              code: "response-instability",
              severity: "warning",
              message: "Googlebot returned inconsistent HTTP response evidence across samples.",
              url: targetResult.target.url,
              agent: "googlebot",
              evidence: {
                samples: 2,
                completeSamples: 2,
                fields: "status",
                variantCounts: "status=2",
              },
            },
          ],
        },
      ],
      summary: { targets: 1, probes: 2, errors: 0, warnings: 1, info: 1, incomplete: 0 },
    };

    const sarif = JSON.parse(renderSarif(stabilityAudit)) as {
      runs: Array<{
        results: Array<{
          ruleId: string;
          level: string;
          properties?: Record<string, unknown>;
        }>;
      }>;
    };
    const results = sarif.runs[0]?.results ?? [];
    const stream = results.find((result) => result.ruleId === "stream-instability");
    const response = results.find((result) => result.ruleId === "response-instability");

    expect(stream).toMatchObject({
      level: "note",
      properties: { agent: "googlebot", samples: 2, fields: "bodySha256" },
    });
    expect(response).toMatchObject({
      level: "warning",
      properties: { agent: "googlebot", samples: 2, fields: "status" },
    });
  });
});
