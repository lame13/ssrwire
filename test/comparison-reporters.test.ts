import { describe, expect, it } from "vitest";
import {
  renderComparisonHtml,
  renderComparisonJson,
  renderComparisonReport,
  renderComparisonTerminal,
} from "../src/comparison-reporters.js";
import type { AuditComparison } from "../src/types.js";

const control = "\u001B]52;c;dG9rZW4=\u0007";
const comparison: AuditComparison = {
  schemaVersion: 1,
  kind: "comparison",
  version: "0.4.1",
  generatedAt: "2026-09-01T01:00:00.000Z",
  baseline: {
    label: "production.json",
    version: "0.4.1",
    schemaVersion: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    repeat: 3,
  },
  candidate: {
    label: "</title><script>alert(1)</script>",
    version: "0.4.1",
    schemaVersion: 1,
    generatedAt: "2026-09-01T00:30:00.000Z",
    repeat: 3,
  },
  thresholds: { timingRegressionMs: 250, timingRegressionPercent: 25 },
  results: [
    {
      key: "home",
      id: "home",
      status: "matched",
      baselineUrl: "https://www.example.com/",
      candidateUrl: "https://preview.example.com/",
      changes: [
        {
          kind: "regression",
          scope: "finding",
          code: "head-metadata-in-body",
          message: `Metadata moved into the body.${control}`,
          agent: "twitterbot",
          baseline: "head",
          candidate: "body",
        },
        {
          kind: "fixed",
          scope: "finding",
          code: "missing-description",
          message: "Description is present.",
        },
        {
          kind: "changed",
          scope: "metadata",
          code: "metadata-value-changed",
          message: "title value changed.",
          agent: "browser",
          field: "title",
          baseline: "Before",
          candidate: "After",
        },
      ],
      timelines: [
        {
          agent: "twitterbot",
          label: "Twitterbot",
          baseline: {
            samples: 3,
            events: [
              { key: "headers", label: "Headers", medianMs: 100 },
              {
                key: "title",
                label: "Title",
                medianMs: 180,
                location: "head",
                observedByByte: 200,
              },
              { key: "complete", label: "Complete", medianMs: 800 },
            ],
          },
          candidate: {
            samples: 3,
            events: [
              { key: "headers", label: "Headers", medianMs: 120 },
              {
                key: "title",
                label: "Title",
                medianMs: 700,
                location: "body",
                observedByByte: 5_000,
              },
              { key: "complete", label: "Complete", medianMs: 1_200 },
            ],
          },
        },
      ],
    },
  ],
  summary: {
    targets: 1,
    matchedTargets: 1,
    addedTargets: 0,
    removedTargets: 0,
    unchangedTargets: 0,
    regressions: 1,
    fixed: 1,
    changed: 1,
  },
};

describe("comparison reporters", () => {
  it("renders a colorless terminal diff and escapes control sequences", () => {
    const output = renderComparisonTerminal(comparison, { color: false });

    expect(output).toContain("SSRWire 0.4.1 comparison");
    expect(output).toContain("REGRESS head-metadata-in-body [twitterbot]");
    expect(output).toContain("FIXED   missing-description");
    expect(output).toContain("1 regression(s), 1 fixed, 1 changed");
    expect(output).not.toContain("\u001B");
    expect(output).not.toContain("\u0007");
    expect(output).toContain("\\u001B");
    expect(output).toContain("\\u0007");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("renders deterministic JSON", () => {
    const output = renderComparisonJson(comparison);
    expect(JSON.parse(output)).toEqual(comparison);
    expect(output.indexOf('"baseline"')).toBeLessThan(output.indexOf('"candidate"'));
    expect(renderComparisonReport(comparison, "json")).toBe(output);
  });

  it("renders a self-contained escaped HTML waterfall", () => {
    const output = renderComparisonHtml(comparison);

    expect(output).toContain("<!doctype html>");
    expect(output).toContain("Content-Security-Policy");
    expect(output).not.toContain("<script>alert(1)</script>");
    expect(output).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(output).toContain("Wire waterfall");
    expect(output).toContain("--position:15.000%");
    expect(output).toContain("Title · 700 ms · body · by byte 5000");
    expect(output).toContain("head-metadata-in-body");
    expect(output.endsWith("\n")).toBe(true);
  });
});
