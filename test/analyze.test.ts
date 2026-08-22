import { describe, expect, it } from "vitest";
import { analyzeTarget, summarizeAudit } from "../src/analyze.js";
import type {
  AgentProfile,
  AuditTarget,
  DocumentSignals,
  ElementSignal,
  ProbeResult,
  RobotsAudience,
  RobotsSignal,
  TargetAuditResult,
} from "../src/types.js";

const browserAgent: AgentProfile = {
  key: "browser",
  label: "Browser",
  userAgent: "Browser UA",
  requiresHeadMetadata: false,
};

const headOnlyAgent: AgentProfile = {
  key: "socialbot",
  label: "Social bot",
  userAgent: "Social bot UA",
  requiresHeadMetadata: true,
};

const googlebotAgent: AgentProfile = {
  key: "googlebot",
  label: "Googlebot",
  userAgent: "Googlebot UA",
  requiresHeadMetadata: false,
};

function signal(
  value: string,
  atMs = 20,
  location: ElementSignal["location"] = "head",
): ElementSignal {
  return { value, atMs, observedByByte: 100, location };
}

function robotsSignal(
  value: string,
  audience: RobotsAudience = "robots",
  atMs = 20,
  location: RobotsSignal["location"] = "head",
): RobotsSignal {
  return { value, audience, atMs, observedByByte: 100, location };
}

function healthySignals(): DocumentSignals {
  return {
    title: signal("Example title"),
    descriptions: [signal("Example description", 25)],
    canonicals: [signal("https://example.com/page", 30)],
    robots: [robotsSignal("index, follow", "robots", 35)],
    h1s: [signal("Example heading", 40, "body")],
    firstMainText: signal("Useful main content", 45, "body"),
    jsonLd: [
      {
        valid: true,
        types: ["Article"],
        bytes: 120,
        atMs: 42,
        observedByByte: 600,
        location: "body",
      },
    ],
  };
}

function target(overrides: Partial<AuditTarget["expectations"]> = {}): AuditTarget {
  return {
    url: "https://example.com/page",
    expectations: {
      statuses: [200],
      requireTitle: true,
      requireDescription: true,
      requireCanonical: true,
      requireH1: true,
      requireMainText: true,
      ...overrides,
    },
  };
}

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    requestedUrl: "https://example.com/page",
    finalUrl: "https://example.com/page",
    agent: browserAgent,
    status: 200,
    redirects: [],
    headers: { values: { "content-type": "text/html" }, setCookiePresent: false },
    timings: { headersMs: 10, firstByteMs: 15, completeMs: 50 },
    bytesRead: 1_000,
    bodySha256: "abc",
    signals: healthySignals(),
    completion: "complete",
    ...overrides,
  };
}

describe("analyzeTarget", () => {
  it("returns no findings for a healthy completed probe", () => {
    const findings = analyzeTarget(target(), [probe()]);
    expect(findings).toEqual([]);
  });

  it("reports an incomplete probe without claiming unseen elements are missing", () => {
    const findings = analyzeTarget(target(), [
      probe({
        completion: "timeout",
        error: "request timed out",
        signals: {
          descriptions: [],
          canonicals: [],
          robots: [],
          h1s: [],
          jsonLd: [
            {
              valid: false,
              types: [],
              bytes: 8,
              atMs: 10,
              observedByByte: 50,
              location: "head",
              error: "truncated input",
            },
          ],
        },
      }),
    ]);

    expect(findings.map((finding) => finding.code)).toEqual(["incomplete-probe"]);
    expect(findings[0]?.severity).toBe("error");
  });

  it("does not treat the last redirect as a final response after a failed fetch", () => {
    const findings = analyzeTarget(target({ finalUrl: "https://example.com/intended" }), [
      probe({
        status: 302,
        finalUrl: "https://example.com/redirect-target",
        completion: "network-error",
        redirects: [
          {
            url: "https://example.com/page",
            status: 302,
            location: "https://example.com/redirect-target",
            durationMs: 10,
          },
        ],
        signals: {
          descriptions: [],
          canonicals: [],
          robots: [],
          h1s: [],
          jsonLd: [],
        },
      }),
    ]);

    expect(findings.map((finding) => finding.code)).toEqual(["incomplete-probe"]);
  });

  it("reports expectation mismatches and required missing signals", () => {
    const result = analyzeTarget(target({ finalUrl: "https://example.com/intended" }), [
      probe({
        finalUrl: "https://example.com/wrong",
        status: 503,
        signals: {
          descriptions: [],
          canonicals: [],
          robots: [],
          h1s: [],
          jsonLd: [],
        },
      }),
    ]);
    const findings = new Map(result.map((finding) => [finding.code, finding]));

    expect([...findings.keys()]).toEqual(
      expect.arrayContaining([
        "status-mismatch",
        "final-url-mismatch",
        "missing-title",
        "missing-description",
        "missing-canonical",
        "missing-h1",
        "missing-main-text",
      ]),
    );
    expect(findings.get("missing-title")?.severity).toBe("error");
    expect(findings.get("missing-canonical")?.severity).toBe("warning");
  });

  it("detects repeated metadata, invalid JSON-LD, and head-only agent violations", () => {
    const findings = analyzeTarget(target(), [
      probe({
        agent: headOnlyAgent,
        signals: {
          ...healthySignals(),
          title: signal("Example title", 20, "body"),
          descriptions: [
            signal("Same description", 25, "body"),
            signal(" Same   description ", 26, "body"),
          ],
          canonicals: [
            signal("/page", 30, "body"),
            signal("https://example.com/other", 31, "body"),
          ],
          robots: [
            robotsSignal("index, follow", "robots", 35, "body"),
            robotsSignal("noindex", "robots", 36, "body"),
          ],
          jsonLd: [
            {
              valid: false,
              types: [],
              bytes: 12,
              atMs: 40,
              observedByByte: 500,
              location: "body",
              error: "Unexpected token",
            },
          ],
        },
      }),
    ]);
    const codes = findings.map((finding) => finding.code);

    expect(codes).toContain("duplicate-description");
    expect(codes).toContain("conflicting-canonical");
    expect(codes).toContain("conflicting-robots");
    expect(codes).toContain("invalid-json-ld");
    expect(codes).toContain("head-metadata-in-body");
    expect(findings.find((finding) => finding.code === "head-metadata-in-body")?.severity).toBe(
      "error",
    );
  });

  it("does not treat body metadata as an error for a JS-capable profile", () => {
    const bodySignals = healthySignals();
    const findings = analyzeTarget(target(), [
      probe({
        signals: {
          ...bodySignals,
          title: signal("Streamed title", 50, "body"),
          descriptions: [signal("Streamed description", 55, "body")],
          canonicals: [signal("/page", 60, "body")],
          robots: [robotsSignal("index, follow", "robots", 65, "body")],
        },
      }),
    ]);

    expect(findings.some((finding) => finding.code === "head-metadata-in-body")).toBe(false);
  });

  it("reports crawler drift and configured timing thresholds", () => {
    const slowBrowser = probe({
      timings: { headersMs: 20, firstByteMs: 150, completeMs: 300 },
      signals: {
        ...healthySignals(),
        title: signal("Browser title", 180),
        firstMainText: signal("Main", 220, "body"),
      },
    });
    const bot = probe({
      agent: headOnlyAgent,
      status: 203,
      finalUrl: "https://example.com/alternate",
      signals: {
        ...healthySignals(),
        title: signal("Bot title"),
        canonicals: [signal("https://example.com/alternate")],
        robots: [robotsSignal("noindex")],
      },
    });

    const findings = analyzeTarget(
      target({ statuses: [200, 203], maxFirstByteMs: 100, maxCriticalMs: 200 }),
      [slowBrowser, bot],
    );
    const codes = findings.map((finding) => finding.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "slow-first-byte",
        "slow-critical-signals",
        "agent-status-drift",
        "agent-final-url-drift",
        "agent-title-drift",
        "agent-canonical-drift",
        "agent-robots-drift",
      ]),
    );
  });

  it("combines crawler-specific robots directives with generic directives", () => {
    const sharedRobots = [
      robotsSignal("index, follow", "robots", 30),
      robotsSignal("noindex, nofollow", "googlebot", 31),
    ];
    const findings = analyzeTarget(target(), [
      probe({ signals: { ...healthySignals(), robots: sharedRobots } }),
      probe({ agent: googlebotAgent, signals: { ...healthySignals(), robots: sharedRobots } }),
    ]);
    const codes = findings.map((finding) => finding.code);

    expect(codes).toContain("agent-robots-drift");
    expect(codes).not.toContain("conflicting-robots");
    expect(codes).not.toContain("duplicate-robots");
  });

  it("does not call complementary crawler-specific robots directives conflicting", () => {
    const findings = analyzeTarget(target(), [
      probe({
        agent: googlebotAgent,
        signals: {
          ...healthySignals(),
          robots: [
            robotsSignal("index, follow", "robots", 30),
            robotsSignal("noindex", "googlebot", 31),
            robotsSignal("nofollow", "googlebot", 32),
            robotsSignal("none", "bingbot", 33),
          ],
        },
      }),
    ]);
    const robotsFinding = findings.find((finding) => finding.code === "multiple-robots");

    expect(robotsFinding?.evidence).toMatchObject({
      audience: "googlebot",
      count: 2,
      distinctValues: 2,
    });
    expect(findings.some((finding) => finding.code === "conflicting-robots")).toBe(false);
    expect(findings.some((finding) => finding.code === "duplicate-robots")).toBe(false);
  });

  it("flags direct contradictions within one robots audience", () => {
    const findings = analyzeTarget(target(), [
      probe({
        agent: googlebotAgent,
        signals: {
          ...healthySignals(),
          robots: [
            robotsSignal("index, follow", "googlebot", 31),
            robotsSignal("noindex", "googlebot", 32),
          ],
        },
      }),
    ]);

    expect(
      findings.find((finding) => finding.code === "conflicting-robots")?.evidence,
    ).toMatchObject({ audience: "googlebot", count: 2 });
  });

  it("flags contradictions across generic and crawler-specific robots directives", () => {
    const findings = analyzeTarget(target(), [
      probe({
        agent: googlebotAgent,
        signals: {
          ...healthySignals(),
          robots: [
            robotsSignal("noindex, follow", "robots", 30),
            robotsSignal("index", "googlebot", 31),
          ],
        },
      }),
    ]);

    expect(
      findings.find((finding) => finding.code === "conflicting-robots")?.evidence,
    ).toMatchObject({ audience: "effective", count: 2 });
  });

  it("flags conflicting streamed titles", () => {
    const first = signal("Loading", 20, "head");
    const second = signal("Final product", 80, "body");
    const findings = analyzeTarget(target(), [
      probe({
        signals: {
          ...healthySignals(),
          title: first,
          titles: [first, second],
        },
      }),
    ]);

    expect(
      findings.find((finding) => finding.code === "conflicting-title")?.evidence,
    ).toMatchObject({ count: 2, distinctValues: 2 });
  });

  it("reports bounded JSON-LD analysis separately from invalid JSON", () => {
    const findings = analyzeTarget(target(), [
      probe({
        signals: {
          ...healthySignals(),
          jsonLd: [
            {
              location: "body",
              types: [],
              bytes: 2_000_000,
              analysisLimit: "JSON-LD block exceeded the analysis limit.",
              atMs: 50,
              observedByByte: 2_000_000,
            },
          ],
        },
      }),
    ]);

    expect(findings.some((finding) => finding.code === "json-ld-analysis-limit")).toBe(true);
    expect(findings.some((finding) => finding.code === "invalid-json-ld")).toBe(false);
  });
});

describe("summarizeAudit", () => {
  it("counts probes, severities, and incomplete runs", () => {
    const probes = [probe(), probe({ completion: "network-error" })];
    const analyzed = analyzeTarget(target(), probes);
    const withInfo: TargetAuditResult = {
      target: target(),
      probes,
      findings: [
        ...analyzed,
        { code: "note", severity: "info", message: "A note", url: target().url },
      ],
    };

    expect(summarizeAudit([withInfo])).toEqual({
      targets: 1,
      probes: 2,
      errors: 1,
      warnings: 0,
      info: 1,
      incomplete: 1,
    });
  });
});
