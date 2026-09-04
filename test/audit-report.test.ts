import { describe, expect, it } from "vitest";
import {
  AUDIT_SCHEMA_VERSION,
  AuditReportError,
  parseAuditReport,
  parseAuditReportText,
} from "../src/audit-report.js";
import type { AuditResult } from "../src/types.js";

const emptyAudit: AuditResult = {
  schemaVersion: 1,
  version: "0.4.1",
  generatedAt: "2026-09-01T00:00:00.000Z",
  durationMs: 0,
  results: [],
  summary: { targets: 0, probes: 0, errors: 0, warnings: 0, info: 0, incomplete: 0 },
};

describe("audit report parsing", () => {
  it("validates the complete persisted contract", () => {
    expect(AUDIT_SCHEMA_VERSION).toBe(1);
    expect(parseAuditReport(JSON.parse(JSON.stringify(emptyAudit)))).toEqual(emptyAudit);
    expect(parseAuditReportText(JSON.stringify(emptyAudit))).toEqual(emptyAudit);
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
