import { describe, expect, it } from "vitest";
import {
  AUDIT_SCHEMA_VERSION,
  AuditReportError,
  parseAuditReport,
  parseAuditReportText,
} from "../src/audit-report.js";
import type { AuditResult } from "../src/types.js";

const emptyAudit: AuditResult = {
  // Kept at version 1 on purpose: reports written by SSRWire 0.4.x and 0.5.0 must stay readable.
  schemaVersion: 1,
  version: "0.5.0",
  generatedAt: "2026-09-01T00:00:00.000Z",
  durationMs: 0,
  results: [],
  summary: { targets: 0, probes: 0, errors: 0, warnings: 0, info: 0, incomplete: 0 },
};

const currentAudit: AuditResult = {
  ...emptyAudit,
  schemaVersion: 2,
  version: "0.6.0",
  summary: { targets: 0, probes: 0, errors: 0, warnings: 0, info: 0, incomplete: 0, waived: 0 },
  waivers: [
    {
      code: "missing-description",
      target: "home",
      reason: "tracked in SEO-1487",
      until: "2026-12-31",
    },
  ],
};

describe("audit report parsing", () => {
  it("validates the complete persisted contract", () => {
    expect(AUDIT_SCHEMA_VERSION).toBe(2);
    expect(parseAuditReport(JSON.parse(JSON.stringify(emptyAudit)))).toEqual(emptyAudit);
    expect(parseAuditReportText(JSON.stringify(emptyAudit))).toEqual(emptyAudit);
  });

  it("round-trips the current contract including waivers", () => {
    expect(parseAuditReport(JSON.parse(JSON.stringify(currentAudit)))).toEqual(currentAudit);
    expect(parseAuditReportText(JSON.stringify(currentAudit))).toEqual(currentAudit);
  });

  it("refuses a report from a newer contract than this build understands", () => {
    expect(() => parseAuditReport({ ...emptyAudit, schemaVersion: 3 })).toThrow(
      /schemaVersion 3.*understands up to 2/u,
    );
  });

  it("rejects reports without the supported schema version", () => {
    const legacy = { ...emptyAudit, schemaVersion: undefined };
    expect(() => parseAuditReport(legacy, "baseline audit report")).toThrow(
      /Invalid baseline audit report.*schemaVersion/u,
    );
  });

  it("does not echo malformed JSON content", () => {
    const secret = "do-not-echo-this";
    try {
      parseAuditReportText(`{${secret}`, "candidate audit report");
      throw new Error("Expected parsing to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(AuditReportError);
      expect(String(error)).not.toContain(secret);
    }
  });
});
