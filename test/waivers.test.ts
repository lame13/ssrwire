import { describe, expect, it } from "vitest";
import type { AuditTarget, Finding, TargetAuditResult, WaiverRecord } from "../src/types.js";
import {
  applyWaivers,
  EXPIRED_WAIVER_CODE,
  isWaiverExpired,
  UNUSED_WAIVER_CODE,
} from "../src/waivers.js";

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

function finding(code: string, agent?: string): Finding {
  return {
    code,
    severity: "warning",
    message: `${code} happened`,
    url: target.url,
    ...(agent === undefined ? {} : { agent }),
  };
}

function result(findings: readonly Finding[]): TargetAuditResult {
  return { target, probes: [], findings };
}

const NOW = new Date("2026-10-06T00:00:00.000Z");

describe("isWaiverExpired", () => {
  it("keeps a waiver valid through the end of its until date", () => {
    expect(isWaiverExpired({ code: "x", reason: "r", until: "2026-10-06" }, NOW)).toBe(false);
    expect(isWaiverExpired({ code: "x", reason: "r", until: "2026-10-05" }, NOW)).toBe(true);
    expect(isWaiverExpired({ code: "x", reason: "r" }, NOW)).toBe(false);
  });
});

describe("applyWaivers", () => {
  it("removes a matching finding and reports the suppressed count", () => {
    const waivers: readonly WaiverRecord[] = [
      { code: "missing-description", target: "home", reason: "tracked in SEO-1487" },
    ];
    const outcome = applyWaivers(
      [result([finding("missing-description"), finding("missing-title")])],
      waivers,
      NOW,
    );

    expect(outcome.waived).toBe(1);
    expect(outcome.results[0]?.findings.map((item) => item.code)).toEqual(["missing-title"]);
    expect(outcome.applied).toEqual(waivers);
  });

  it("supports a wildcard code and agent scoping", () => {
    const outcome = applyWaivers(
      [
        result([
          finding("missing-description", "googlebot"),
          finding("missing-description", "browser"),
        ]),
      ],
      [{ code: "*", agent: "googlebot", reason: "Googlebot gets a slim head" }],
      NOW,
    );

    expect(outcome.waived).toBe(1);
    expect(outcome.results[0]?.findings.map((item) => item.agent)).toEqual(["browser"]);
  });

  it("scopes a waiver by exact URL as well as by id", () => {
    const outcome = applyWaivers(
      [result([finding("missing-description")])],
      [{ code: "missing-description", target: target.url, reason: "legacy page" }],
      NOW,
    );

    expect(outcome.waived).toBe(1);
  });

  it("stops suppressing once a waiver expires and says so", () => {
    const outcome = applyWaivers(
      [result([finding("missing-description")])],
      [
        {
          code: "missing-description",
          target: "home",
          reason: "tracked in SEO-1487",
          until: "2026-09-30",
        },
      ],
      NOW,
    );

    expect(outcome.waived).toBe(0);
    expect(outcome.results[0]?.findings.map((item) => item.code)).toEqual([
      "missing-description",
      EXPIRED_WAIVER_CODE,
    ]);
    expect(outcome.results[0]?.findings[1]?.severity).toBe("warning");
  });

  it("reports a waiver that matched nothing as unused", () => {
    const outcome = applyWaivers(
      [result([finding("missing-title")])],
      [{ code: "missing-description", reason: "tracked in SEO-1487" }],
      NOW,
    );

    expect(outcome.applied).toEqual([]);
    expect(outcome.results[0]?.findings.map((item) => item.code)).toEqual([
      "missing-title",
      UNUSED_WAIVER_CODE,
    ]);
    expect(outcome.results[0]?.findings[1]?.severity).toBe("info");
  });

  it("returns the input untouched when nothing is waived", () => {
    const input = [result([finding("missing-title")])];
    const outcome = applyWaivers(input, [], NOW);

    expect(outcome.results).toBe(input);
    expect(outcome.waived).toBe(0);
  });
});
