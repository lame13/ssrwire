import { describe, expect, it } from "vitest";
import { redactAudit, redactProbe } from "../src/redact.js";
import type { AuditResult, ProbeResult } from "../src/types.js";

function fixture(): ProbeResult {
  return {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/done?token=very-secret-token",
    agent: {
      key: "browser",
      label: "Browser",
      userAgent: "Browser/1.0",
      requiresHeadMetadata: false,
    },
    status: 200,
    redirects: [
      {
        url: "https://example.com/",
        status: 302,
        location: "https://example.com/done?token=very-secret-token",
        durationMs: 10,
      },
    ],
    headers: { values: {}, setCookiePresent: false },
    timings: { headersMs: 10, firstByteMs: 12, completeMs: 20 },
    bytesRead: 100,
    bodySha256: "abc",
    signals: {
      title: {
        value: "Token very-secret-token / very-secret-token%2Fencoded",
        location: "head",
        atMs: 12,
        observedByByte: 40,
      },
      descriptions: [],
      canonicals: [],
      robots: [],
      socialMetadata: [
        {
          property: "og:title",
          value: "Preview very-secret-token",
          location: "head",
          atMs: 13,
          observedByByte: 50,
        },
      ],
      h1s: [],
      jsonLd: [],
    },
    completion: "complete",
  };
}

describe("redactProbe", () => {
  it("removes configured values and encoded forms from every captured field", () => {
    const redacted = redactProbe(fixture(), ["Bearer very-secret-token"]);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("very-secret-token");
    expect(serialized).toContain("[REDACTED]");
  });

  it("returns the original object when there are no secrets", () => {
    const probe = fixture();
    expect(redactProbe(probe, [])).toBe(probe);
  });

  it("redacts decoded Basic credentials", () => {
    const probe = fixture();
    const title = probe.signals.title;
    if (!title) throw new Error("Fixture title is missing.");
    const credentials = "alice:correct-horse";
    const withCredentials: ProbeResult = {
      ...probe,
      signals: {
        ...probe.signals,
        title: { ...title, value: `Welcome ${credentials}` },
      },
    };
    const authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;

    expect(JSON.stringify(redactProbe(withCredentials, [authorization]))).not.toContain(
      credentials,
    );
  });

  it("redacts targets and findings from the complete audit result", () => {
    const secret = "preview-token-987";
    const probe = fixture();
    const audit: AuditResult = {
      schemaVersion: 1,
      version: "0.4.0",
      generatedAt: "2026-08-22T00:00:00.000Z",
      durationMs: 1,
      results: [
        {
          target: {
            id: secret,
            url: `https://example.com/?token=${secret}`,
            expectations: {
              statuses: [200],
              requireTitle: true,
              requireDescription: true,
              requireCanonical: true,
              requireH1: true,
              requireMainText: true,
            },
          },
          probes: [probe],
          stability: [
            {
              agent: probe.agent,
              samples: 2,
              complete: 2,
              incomplete: 0,
              timings: {},
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
          findings: [
            {
              code: "reflected-value",
              severity: "warning",
              message: `Reflected ${secret}`,
              url: `https://example.com/?token=${secret}`,
            },
          ],
        },
      ],
      summary: { targets: 1, probes: 1, errors: 0, warnings: 1, info: 0, incomplete: 0 },
    };

    const serialized = JSON.stringify(redactAudit(audit, [secret]));
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("preserves typed control fields when a header value matches an enum", () => {
    const probe = fixture();
    const audit: AuditResult = {
      schemaVersion: 1,
      version: "0.4.0",
      generatedAt: "2026-08-22T00:00:00.000Z",
      durationMs: 1,
      results: [
        {
          target: {
            url: "https://example.com/",
            expectations: {
              statuses: [200],
              requireTitle: true,
              requireDescription: true,
              requireCanonical: true,
              requireH1: true,
              requireMainText: true,
            },
          },
          probes: [probe],
          stability: [
            {
              agent: probe.agent,
              samples: 2,
              complete: 2,
              incomplete: 0,
              timings: {},
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
          findings: [
            {
              code: "sample-error",
              severity: "error",
              message: "A completed probe produced an error.",
              url: "https://example.com/",
              agent: "browser",
            },
          ],
        },
      ],
      summary: { targets: 1, probes: 1, errors: 1, warnings: 0, info: 0, incomplete: 0 },
    };

    const redacted = redactAudit(audit, ["complete", "error", "browser"]);
    expect(redacted.results[0]?.probes[0]?.completion).toBe("complete");
    expect(redacted.results[0]?.probes[0]?.agent.key).toBe("browser");
    expect(redacted.results[0]?.stability?.[0]?.agent.key).toBe("browser");
    expect(redacted.results[0]?.findings[0]?.severity).toBe("error");
    expect(redacted.results[0]?.findings[0]?.code).toBe("sample-error");
    expect(redacted.summary.errors).toBe(1);
  });
});
