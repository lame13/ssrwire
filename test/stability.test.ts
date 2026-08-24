import { describe, expect, it } from "vitest";
import {
  analyzeStability,
  calculateTimingStats,
  criticalSignalsArrivalMs,
} from "../src/stability.js";
import type { AuditTarget, ElementLocation, ProbeCompletion, ProbeResult } from "../src/types.js";

const target: AuditTarget = {
  url: "https://example.com/page",
  expectations: {
    statuses: [200],
    requireTitle: true,
    requireDescription: true,
    requireCanonical: true,
    requireH1: true,
    requireMainText: true,
  },
};

interface ProbeFixtureOptions {
  readonly sample: number;
  readonly title?: string;
  readonly titleLocation?: ElementLocation;
  readonly bodySha256?: string;
  readonly status?: number;
  readonly finalUrl?: string;
  readonly completion?: ProbeCompletion;
  readonly timingOffset?: number;
  readonly includeDescription?: boolean;
  readonly canonicalValue?: string | null;
  readonly canonicals?: readonly {
    readonly value: string;
    readonly location: ElementLocation;
  }[];
  readonly h1?: string;
  readonly mainText?: string;
}

function probe(options: ProbeFixtureOptions): ProbeResult {
  const offset = options.timingOffset ?? 0;
  const title = options.title ?? "Stable title";
  const finalUrl = options.finalUrl ?? target.url;
  const completion = options.completion ?? "complete";
  return {
    requestedUrl: target.url,
    finalUrl,
    agent: {
      key: "browser",
      label: "Browser",
      userAgent: "Browser UA",
      requiresHeadMetadata: false,
    },
    status: options.status ?? 200,
    redirects: [],
    headers: { values: { "content-type": "text/html" }, setCookiePresent: false },
    timings: {
      headersMs: 10 + offset,
      firstByteMs: 20 + offset,
      ...(completion === "complete" ? { completeMs: 80 + offset } : {}),
    },
    bytesRead: 900,
    bodySha256: options.bodySha256 ?? "body-a",
    signals:
      completion === "complete"
        ? {
            title: {
              value: title,
              location: options.titleLocation ?? "head",
              atMs: 25 + offset,
              observedByByte: 100,
            },
            descriptions:
              options.includeDescription === false
                ? []
                : [
                    {
                      value: "Description",
                      location: "head",
                      atMs: 30 + offset,
                      observedByByte: 150,
                    },
                  ],
            canonicals:
              options.canonicals?.map((canonical) => ({
                ...canonical,
                atMs: 35 + offset,
                observedByByte: 200,
              })) ??
              (options.canonicalValue === null
                ? []
                : [
                    {
                      value: options.canonicalValue ?? finalUrl,
                      location: "head",
                      atMs: 35 + offset,
                      observedByByte: 200,
                    },
                  ]),
            robots: [],
            h1s: [
              {
                value: options.h1 ?? "Heading",
                location: "body",
                atMs: 45 + offset,
                observedByByte: 400,
              },
            ],
            firstMainText: {
              value: options.mainText ?? "Main content",
              location: "body",
              atMs: 50 + offset,
              observedByByte: 500,
            },
            jsonLd: [],
          }
        : { descriptions: [], canonicals: [], robots: [], h1s: [], jsonLd: [] },
    completion,
    sample: options.sample,
  };
}

describe("calculateTimingStats", () => {
  it("uses a conventional median and nearest-rank p95", () => {
    expect(calculateTimingStats([30, 10, 20, 40])).toEqual({
      samples: 4,
      minMs: 10,
      medianMs: 25,
      p95Ms: 40,
      maxMs: 40,
      spreadMs: 30,
    });
    expect(calculateTimingStats([30, 10, 20])?.medianMs).toBe(20);
    expect(calculateTimingStats([])).toBeUndefined();
  });
});

describe("analyzeStability", () => {
  it("summarizes timing variation without turning jitter into a finding", () => {
    const analysis = analyzeStability(target, [
      probe({ sample: 1, timingOffset: 0 }),
      probe({ sample: 2, timingOffset: 10 }),
      probe({ sample: 3, timingOffset: 20 }),
    ]);

    expect(analysis.findings).toEqual([]);
    expect(analysis.stability[0]).toMatchObject({
      samples: 3,
      complete: 3,
      incomplete: 0,
      timings: {
        firstByte: { samples: 3, minMs: 20, medianMs: 30, p95Ms: 40, spreadMs: 20 },
        criticalSignals: { minMs: 50, medianMs: 60, p95Ms: 70 },
      },
    });
  });

  it("classifies body-fingerprint-only variation as information", () => {
    const analysis = analyzeStability(target, [
      probe({ sample: 1, bodySha256: "body-a" }),
      probe({ sample: 2, bodySha256: "body-b" }),
    ]);

    expect(analysis.findings).toContainEqual(
      expect.objectContaining({
        code: "stream-instability",
        severity: "info",
        evidence: expect.objectContaining({ fields: "bodySha256" }),
      }),
    );
  });

  it("warns when complete samples change metadata values or locations", () => {
    const analysis = analyzeStability(target, [
      probe({ sample: 1, title: "First title", titleLocation: "head" }),
      probe({ sample: 2, title: "Second title", titleLocation: "body" }),
    ]);

    expect(analysis.findings).toContainEqual(
      expect.objectContaining({
        code: "stream-instability",
        severity: "warning",
        evidence: expect.objectContaining({
          fields: "metadataValues, metadataLocations",
        }),
      }),
    );
  });

  it("warns when HTTP response evidence changes", () => {
    const analysis = analyzeStability(target, [
      probe({ sample: 1, status: 200 }),
      probe({ sample: 2, status: 503 }),
    ]);

    expect(analysis.findings).toContainEqual(
      expect.objectContaining({
        code: "response-instability",
        severity: "warning",
        evidence: expect.objectContaining({ fields: "status" }),
      }),
    );
  });

  it("compares final response evidence even when every sample is incomplete", () => {
    const analysis = analyzeStability(target, [
      probe({
        sample: 1,
        completion: "invalid-response",
        status: 200,
        finalUrl: "https://example.com/first",
      }),
      probe({
        sample: 2,
        completion: "invalid-response",
        status: 503,
        finalUrl: "https://example.com/second",
      }),
    ]);

    expect(analysis.stability[0]?.variants).toMatchObject({ status: 2, finalUrl: 2 });
    expect(analysis.findings).toContainEqual(
      expect.objectContaining({
        code: "response-instability",
        evidence: expect.objectContaining({ fields: "status, finalUrl" }),
      }),
    );
  });

  it("treats an empty canonical as missing instead of resolving it to the page URL", () => {
    const changed = analyzeStability(target, [
      probe({ sample: 1, canonicalValue: "" }),
      probe({ sample: 2, canonicalValue: target.url }),
    ]);
    expect(changed.stability[0]?.variants).toMatchObject({
      metadataValues: 2,
      metadataLocations: 2,
    });
    expect(changed.findings).toContainEqual(
      expect.objectContaining({ code: "stream-instability", severity: "warning" }),
    );

    const consistentlyMissing = analyzeStability(target, [
      probe({ sample: 1, canonicalValue: "" }),
      probe({ sample: 2, canonicalValue: null }),
    ]);
    expect(consistentlyMissing.stability[0]?.variants).toMatchObject({
      metadataValues: 1,
      metadataLocations: 1,
    });
    expect(consistentlyMissing.findings).toEqual([]);
  });

  it("detects when the same canonical values swap document locations", () => {
    const first = [
      { value: "https://example.com/a", location: "head" as const },
      { value: "https://example.com/b", location: "body" as const },
    ];
    const second = [
      { value: "https://example.com/a", location: "body" as const },
      { value: "https://example.com/b", location: "head" as const },
    ];
    const analysis = analyzeStability(target, [
      probe({ sample: 1, canonicals: first }),
      probe({ sample: 2, canonicals: second }),
    ]);

    expect(analysis.stability[0]?.variants).toMatchObject({
      metadataValues: 1,
      metadataLocations: 2,
    });
    expect(analysis.findings).toContainEqual(
      expect.objectContaining({ code: "stream-instability", severity: "warning" }),
    );
  });

  it("does not classify H1 or main-text changes as metadata instability", () => {
    const analysis = analyzeStability(target, [
      probe({ sample: 1, h1: "First heading", mainText: "First text" }),
      probe({ sample: 2, h1: "Second heading", mainText: "Second text" }),
    ]);

    expect(analysis.stability[0]?.variants).toMatchObject({
      metadataValues: 1,
      metadataLocations: 1,
    });
    expect(analysis.findings).toEqual([]);
  });

  it("does not compare metadata from incomplete samples", () => {
    const analysis = analyzeStability(target, [
      probe({ sample: 1 }),
      probe({ sample: 2, completion: "timeout" }),
    ]);

    expect(analysis.findings.map((finding) => finding.code)).toEqual(["response-instability"]);
    expect(analysis.stability[0]?.variants.metadataValues).toBe(1);
  });

  it("omits critical timing unless every required signal was observed", () => {
    expect(criticalSignalsArrivalMs(target, probe({ sample: 1 }))).toBe(50);
    expect(
      criticalSignalsArrivalMs(
        target,
        probe({
          sample: 1,
          canonicals: [
            { value: "", location: "head" },
            { value: target.url, location: "head" },
          ],
        }),
      ),
    ).toBe(50);
    expect(
      criticalSignalsArrivalMs(target, probe({ sample: 1, includeDescription: false })),
    ).toBeUndefined();
  });
});
