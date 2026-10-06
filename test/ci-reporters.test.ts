import { describe, expect, it } from "vitest";
import {
  renderComparisonGithub,
  renderComparisonMarkdown,
  renderGithub,
  renderJunit,
  renderMarkdown,
} from "../src/ci-reporters.js";
import type { AuditComparison, AuditResult, ProbeResult, TargetAuditResult } from "../src/types.js";

const agent = {
  key: "googlebot",
  label: "Googlebot",
  userAgent: "Googlebot UA",
  requiresHeadMetadata: false,
} as const;

function probe(url: string): ProbeResult {
  return {
    requestedUrl: url,
    finalUrl: url,
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
    stream: { chunks: 3, spannedMs: 60, maxGapMs: 30, idleMs: 40 },
  };
}

const url = "https://example.com/page|pipes";

const result: TargetAuditResult = {
  target: {
    url,
    expectations: {
      statuses: [200],
      requireTitle: true,
      requireDescription: true,
      requireCanonical: true,
      requireH1: true,
      requireMainText: true,
    },
  },
  probes: [probe(url)],
  findings: [
    {
      code: "missing-description",
      severity: "warning",
      message: "Googlebot received no meta description.",
      url,
      agent: "googlebot",
      evidence: { observed: false },
    },
    {
      code: "missing-title",
      severity: "error",
      message: "Googlebot received <no> title & nothing else",
      url,
      agent: "googlebot",
    },
  ],
};

const audit: AuditResult = {
  schemaVersion: 2,
  version: "0.6.0",
  generatedAt: "2026-10-06T00:00:00.000Z",
  durationMs: 123,
  results: [result],
  summary: { targets: 1, probes: 1, errors: 1, warnings: 1, info: 0, incomplete: 0, waived: 2 },
};

describe("renderMarkdown", () => {
  it("prints response text without allowing embedded Markdown or HTML", () => {
    const output = renderMarkdown({
      ...audit,
      results: [
        {
          ...result,
          findings: [
            {
              code: "test",
              severity: "warning",
              url,
              message: '<img src="https://other.test/pixel"> [click](https://other.test)',
              evidence: { title: "`\n## Injected heading" },
            },
          ],
        },
      ],
    });
    expect(output).toContain("&lt;img");
    expect(output).not.toContain("<img");
    expect(output).not.toContain("\n## Injected");
    expect(output).toContain("\\[click\\]");
  });
  it("summarizes the run, orders findings by severity, and escapes table pipes", () => {
    const output = renderMarkdown(audit);

    expect(output).toContain("## SSRWire 0.6.0 audit");
    expect(output).toContain("2 waived");
    expect(output.indexOf("missing-title")).toBeLessThan(output.indexOf("missing-description"));
    expect(output).toContain("| Agent | HTTP | Result |");
  });

  it("escapes pipes and newlines inside table cells", () => {
    const piped: AuditResult = {
      ...audit,
      results: [
        {
          ...result,
          probes: [{ ...probe(url), agent: { ...agent, label: "Google|bot\ncrawler" } }],
        },
      ],
    };

    const output = renderMarkdown(piped);

    expect(output).toContain("| Google\\|bot crawler |");
    expect(output).not.toContain("| Google|bot");
  });
});

describe("renderJunit", () => {
  it("includes target-wide findings and counts failed cases once", () => {
    const output = renderJunit({
      ...audit,
      results: [
        {
          ...result,
          findings: [
            ...result.findings,
            { code: "waiver-expired", severity: "warning", message: "Expired", url },
            { code: "agent-title-drift", severity: "warning", message: "Drift", url },
          ],
        },
      ],
    });
    expect(output).toContain('tests="2" failures="1" errors="1"');
    expect(output).toContain('name="target"');
    expect(output).toContain("waiver-expired");
    expect(output).toContain("agent-title-drift");
  });

  it("attaches coalesced findings only to affected samples", () => {
    const output = renderJunit({
      ...audit,
      repeat: 2,
      results: [
        {
          ...result,
          probes: [
            { ...probe(url), sample: 1 },
            { ...probe(url), sample: 2 },
          ],
          findings: [
            {
              code: "missing-title",
              severity: "error",
              message: "Missing",
              url,
              agent: agent.key,
              evidence: { sampleNumbers: "2" },
            },
          ],
        },
      ],
    });
    expect(output).toContain('tests="2" failures="0" errors="1"');
    expect(output).toContain('name="googlebot#1" time="0.080"/>');
  });

  it("removes characters XML 1.0 cannot represent", () => {
    const output = renderJunit({
      ...audit,
      results: [
        {
          ...result,
          findings: [{ code: "note", severity: "info", message: "before\u0000\u001bafter", url }],
        },
      ],
    });
    expect(output).toContain("beforeafter");
    expect(output).not.toContain("\u0000");
  });
  it("maps findings onto testcases with errors and failures separated", () => {
    const output = renderJunit(audit);

    expect(output.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(output).toContain('<testsuites name="SSRWire" tests="1" failures="0" errors="1"');
    expect(output).toContain('<error type="missing-title"');
    expect(output).toContain("missing-description: Googlebot received no meta description.");
    expect(output).toContain('name="ssrwire.waived" value="2"');
  });

  it("escapes XML-significant characters instead of emitting broken markup", () => {
    const output = renderJunit(audit);

    expect(output).toContain("&lt;no&gt; title &amp; nothing else");
    expect(output).not.toContain("<no>");
    // The raw pipe in the URL is legal XML, and the whole document must stay well formed.
    expect(output).toContain("</testsuites>");
  });
});

describe("renderGithub", () => {
  it("emits workflow commands that map severity onto annotations", () => {
    const output = renderGithub(audit);
    const lines = output.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.startsWith("::error title=SSRWire%3A missing-title::"))).toBe(
      true,
    );
    expect(lines.some((line) => line.startsWith("::warning title="))).toBe(true);
  });

  it("escapes message newlines and returns nothing when there is nothing to report", () => {
    const multiline: AuditResult = {
      ...audit,
      results: [
        {
          ...result,
          findings: [{ code: "note", severity: "info", message: "one\ntwo", url }],
        },
      ],
    };

    expect(renderGithub(multiline)).toContain("one%0Atwo");
    expect(renderGithub({ ...audit, results: [] })).toBe("");
  });
});

const comparison: AuditComparison = {
  schemaVersion: 2,
  kind: "comparison",
  version: "0.6.0",
  generatedAt: "2026-10-06T00:00:00.000Z",
  baseline: {
    label: "production.json",
    version: "0.6.0",
    schemaVersion: 2,
    generatedAt: "2026-10-05T00:00:00.000Z",
    repeat: 1,
  },
  candidate: {
    label: "current run",
    version: "0.6.0",
    schemaVersion: 2,
    generatedAt: "2026-10-06T00:00:00.000Z",
    repeat: 1,
  },
  thresholds: { timingRegressionMs: 250, timingRegressionPercent: 25 },
  results: [
    {
      key: "home",
      id: "home",
      status: "matched",
      baselineUrl: "https://example.com/",
      candidateUrl: "https://example.com/",
      changes: [
        {
          kind: "regression",
          scope: "finding",
          code: "missing-title",
          message: "Title disappeared.",
          agent: "googlebot",
        },
        { kind: "fixed", scope: "finding", code: "missing-description", message: "Fixed." },
      ],
      timelines: [],
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
    changed: 0,
  },
};

describe("comparison markdown and annotations", () => {
  it("tables every change with its kind", () => {
    const output = renderComparisonMarkdown(comparison);

    expect(output).toContain("**1 regression(s)**, 1 fixed, 0 changed");
    expect(output).toContain("| regression | finding | missing-title | googlebot |");
  });

  it("annotates regressions only", () => {
    const output = renderComparisonGithub(comparison);

    expect(output.trim().split("\n")).toHaveLength(1);
    expect(output).toContain("::error title=");
    expect(output).not.toContain("missing-description");
  });
});
