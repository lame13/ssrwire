import { describe, expect, it } from "vitest";
import { renderAuditHtml } from "../src/html-report.js";
import type {
  AuditResult,
  ElementSignal,
  ProbeResult,
  SocialMetadataProperty,
  SocialMetadataSignal,
  TargetAuditResult,
} from "../src/types.js";

const nextjs = {
  key: "nextjs" as const,
  label: "Next.js",
  evidence: "package.json depends on next",
};

function signal(
  value: string,
  atMs = 20,
  location: ElementSignal["location"] = "head",
): ElementSignal {
  return { value, atMs, observedByByte: 100, location };
}

function social(property: SocialMetadataProperty, value: string): SocialMetadataSignal {
  return { property, value, atMs: 30, observedByByte: 200, location: "head" };
}

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
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
    timings: { headersMs: 10, firstByteMs: 15, completeMs: 50 },
    bytesRead: 4_000,
    signals: {
      title: signal("Example title"),
      descriptions: [signal("Example description", 25)],
      canonicals: [signal("https://example.com/page", 30)],
      robots: [],
      socialMetadata: [
        social("og:title", "Example preview"),
        social("og:type", "website"),
        social("og:url", "https://example.com/page"),
        social("og:image", "https://example.com/card.jpg"),
        social("og:description", "Preview description"),
        social("twitter:card", "summary_large_image"),
        social("twitter:title", "Example preview"),
        social("twitter:description", "Preview description"),
        social("twitter:image", "https://example.com/card.jpg"),
      ],
      h1s: [signal("Example heading", 40, "body")],
      firstMainText: signal("Useful main content", 45, "body"),
      jsonLd: [],
    },
    completion: "complete",
    ...overrides,
  };
}

function targetResult(overrides: Partial<TargetAuditResult> = {}): TargetAuditResult {
  return {
    target: {
      id: "home",
      url: "https://example.com/page",
      expectations: {
        statuses: [200],
        requireTitle: true,
        requireDescription: true,
        requireCanonical: true,
        requireH1: true,
        requireMainText: true,
        requireOpenGraph: true,
        requireTwitterCard: true,
      },
    },
    probes: [probe()],
    findings: [],
    ...overrides,
  };
}

function audit(result: TargetAuditResult = targetResult()): AuditResult {
  const errors = result.findings.filter((finding) => finding.severity === "error").length;
  const warnings = result.findings.filter((finding) => finding.severity === "warning").length;
  const info = result.findings.filter((finding) => finding.severity === "info").length;
  return {
    schemaVersion: 1,
    version: "0.5.0",
    generatedAt: "2026-09-17T10:00:00.000Z",
    durationMs: 250,
    results: [result],
    summary: {
      targets: 1,
      probes: result.probes.length,
      errors,
      warnings,
      info,
      incomplete: result.probes.filter((entry) => entry.completion !== "complete").length,
    },
  };
}

describe("renderAuditHtml", () => {
  it("produces one self-contained, script-free document", () => {
    const html = renderAuditHtml(audit(), { framework: nextjs });

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('lang="en"');
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("http://"); // no remote assets, only the report's own URLs
    expect(html).toContain("SSRWire 0.5.0");
    expect(html).toContain("<table>");
    expect(html.endsWith("</html>\n")).toBe(true);
  });

  it("leads with a verdict and the plain-language fixes", () => {
    const html = renderAuditHtml(
      audit(
        targetResult({
          findings: [
            {
              code: "missing-title",
              severity: "error",
              message: "Bingbot received no non-empty title.",
              url: "https://example.com/page",
              agent: "bingbot",
              evidence: { audience: "robots" },
            },
          ],
        }),
      ),
      { framework: nextjs },
    );

    expect(html).toContain("1 page needs attention before release");
    expect(html).toContain("No title in the HTML");
    expect(html).toContain("Blocked");
    expect(html).toContain("What to do first");
    expect(html).toContain("Next.js example");
    expect(html).toContain("app/product/page.tsx");
    expect(html).toContain("Bingbot received no non-empty title.");
  });

  it("escapes untrusted values from the target response", () => {
    const hostile = '<script>alert("x")</script>';
    const html = renderAuditHtml(
      audit(
        targetResult({
          target: {
            url: `https://example.com/${hostile}`,
            expectations: targetResult().target.expectations,
          },
          probes: [
            probe({
              finalUrl: `https://example.com/${hostile}`,
              signals: {
                title: signal(hostile),
                descriptions: [signal(hostile)],
                canonicals: [signal(hostile)],
                robots: [],
                h1s: [],
                jsonLd: [],
              },
            }),
          ],
        }),
      ),
    );

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("renders the social preview card without fetching the image", () => {
    const html = renderAuditHtml(audit(), { framework: nextjs });

    expect(html).toContain("How a shared link would be described");
    expect(html).toContain("https://example.com/card.jpg");
    expect(html).toContain("does not fetch or render the image");
    expect(html).toContain("Social preview readiness");
    expect(html).toContain(">complete<");
  });

  it("records the policy outcome and a reproducible command", () => {
    const html = renderAuditHtml(audit(), {
      policy: { failOn: "error", exitCode: 0 },
    });

    expect(html).toContain("fail-on error · exit code 0");
    expect(html).toContain("Reproduce this report");
    expect(html).toContain("npx ssrwire check");
    expect(html).toContain("--format html --output ssrwire.html");
  });

  it("states a clean result plainly and explains an unidentified stack", () => {
    const html = renderAuditHtml(audit());

    expect(html).toContain("Every checked crawler received the expected HTML");
    expect(html).toContain("No findings.");
    expect(html).toContain("could not identify the stack");
  });

  it("gives every target a unique labelled section anchor", () => {
    const first = targetResult();
    const second = targetResult({
      target: { url: "https://example.com/other", expectations: first.target.expectations },
      probes: [probe({ requestedUrl: "https://example.com/other" })],
    });
    const base = audit(first);
    const html = renderAuditHtml({
      ...base,
      results: [first, second],
      summary: { ...base.summary, targets: 2 },
    });

    expect(html).toContain('id="target-1"');
    expect(html).toContain('id="target-2"');
    expect(html).toContain('aria-labelledby="target-2"');
    expect(html).toContain('id="preview-target-1"');
    expect(html).toContain('aria-labelledby="preview-target-2"');
  });

  it("renders streaming arrival evidence and repeated-sample stability", () => {
    const first = probe();
    const second = probe({ sample: 2 });
    const repeated = targetResult({
      probes: [first, second],
      stability: [
        {
          agent: first.agent,
          samples: 2,
          complete: 2,
          incomplete: 0,
          timings: {
            firstByte: {
              samples: 2,
              minMs: 15,
              medianMs: 16,
              p95Ms: 17,
              maxMs: 17,
              spreadMs: 2,
            },
          },
          variants: {
            completion: 1,
            status: 1,
            finalUrl: 1,
            redirectChain: 1,
            bodySha256: 2,
            metadataValues: 1,
            metadataLocations: 1,
          },
        },
      ],
    });
    const base = audit(repeated);
    const html = renderAuditHtml({
      ...base,
      repeat: 2,
      summary: { ...base.summary, probes: 2 },
    });

    expect(html).toContain("Streaming arrival order");
    expect(html).toContain("byte 100");
    expect(html).toContain("Timing stability");
    expect(html).toContain("17 ms");
  });

  it("explains a truncated probe instead of claiming missing metadata", () => {
    const html = renderAuditHtml(
      audit(
        targetResult({
          probes: [probe({ completion: "timeout", error: "request timed out" })],
          findings: [
            {
              code: "incomplete-probe",
              severity: "error",
              message: "Googlebot probe did not complete (timeout).",
              url: "https://example.com/page",
              agent: "googlebot",
            },
          ],
        }),
      ),
    );

    expect(html).toContain("The check did not finish");
    expect(html).toContain("Incomplete");
    expect(html).toContain("incomplete");
  });
});
