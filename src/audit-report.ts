import { z } from "zod";
import type { AuditResult } from "./types.js";

export const AUDIT_SCHEMA_VERSION = 1 as const;

const nonNegativeNumber = z.number().finite().nonnegative();
const nonNegativeInteger = z.number().int().nonnegative();
const elementLocation = z.enum(["head", "body", "document"]);
const severity = z.enum(["info", "warning", "error"]);

const timingMark = z
  .object({
    atMs: nonNegativeNumber,
    observedByByte: nonNegativeInteger,
  })
  .strict();

const elementSignal = timingMark
  .extend({
    value: z.string(),
    location: elementLocation,
  })
  .strict();

const robotsSignal = elementSignal
  .extend({ audience: z.enum(["robots", "googlebot", "bingbot"]) })
  .strict();

const socialMetadataSignal = elementSignal
  .extend({
    property: z.enum([
      "og:title",
      "og:type",
      "og:url",
      "og:image",
      "og:description",
      "twitter:card",
      "twitter:title",
      "twitter:description",
      "twitter:image",
    ]),
  })
  .strict();

const jsonLdSignal = timingMark
  .extend({
    location: elementLocation,
    valid: z.boolean().optional(),
    types: z.array(z.string()),
    bytes: nonNegativeInteger,
    analysisLimit: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

const documentSignals = z
  .object({
    title: elementSignal.optional(),
    titles: z.array(elementSignal).optional(),
    descriptions: z.array(elementSignal),
    canonicals: z.array(elementSignal),
    robots: z.array(robotsSignal),
    socialMetadata: z.array(socialMetadataSignal).optional(),
    h1s: z.array(elementSignal),
    firstMainText: elementSignal.optional(),
    jsonLd: z.array(jsonLdSignal),
    headClosed: timingMark.optional(),
    bodyStarted: timingMark.optional(),
    documentClosed: timingMark.optional(),
  })
  .strict();

const agentProfile = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    userAgent: z.string(),
    requiresHeadMetadata: z.boolean(),
  })
  .strict();

const redirectHop = z
  .object({
    url: z.string(),
    status: z.number().int().min(100).max(599),
    location: z.string(),
    durationMs: nonNegativeNumber,
  })
  .strict();

const headerSnapshot = z
  .object({
    values: z.record(z.string(), z.string()),
    setCookiePresent: z.boolean(),
  })
  .strict();

const probeTimings = z
  .object({
    headersMs: nonNegativeNumber,
    firstByteMs: nonNegativeNumber.optional(),
    completeMs: nonNegativeNumber.optional(),
  })
  .strict();

const probeResult = z
  .object({
    requestedUrl: z.string(),
    finalUrl: z.string(),
    agent: agentProfile,
    status: z.number().int().min(100).max(599).optional(),
    redirects: z.array(redirectHop),
    headers: headerSnapshot,
    timings: probeTimings,
    bytesRead: nonNegativeInteger,
    bodySha256: z.string().optional(),
    signals: documentSignals,
    completion: z.enum([
      "complete",
      "max-bytes-exceeded",
      "timeout",
      "network-error",
      "invalid-response",
    ]),
    error: z.string().optional(),
    sample: z.number().int().positive().optional(),
  })
  .strict();

const targetExpectations = z
  .object({
    statuses: z.array(z.number().int().min(100).max(599)).min(1),
    finalUrl: z.string().optional(),
    requireTitle: z.boolean(),
    requireDescription: z.boolean(),
    requireCanonical: z.boolean(),
    requireH1: z.boolean(),
    requireMainText: z.boolean(),
    requireOpenGraph: z.boolean().optional(),
    requireTwitterCard: z.boolean().optional(),
    maxFirstByteMs: z.number().positive().finite().optional(),
    maxCriticalMs: z.number().positive().finite().optional(),
  })
  .strict();

const auditTarget = z
  .object({
    id: z.string().min(1).optional(),
    url: z.string(),
    expectations: targetExpectations,
  })
  .strict();

const timingStats = z
  .object({
    samples: nonNegativeInteger,
    minMs: nonNegativeNumber,
    medianMs: nonNegativeNumber,
    p95Ms: nonNegativeNumber,
    maxMs: nonNegativeNumber,
    spreadMs: nonNegativeNumber,
  })
  .strict();

const stabilityTimings = z
  .object({
    headers: timingStats.optional(),
    firstByte: timingStats.optional(),
    criticalSignals: timingStats.optional(),
    complete: timingStats.optional(),
  })
  .strict();

const stabilityVariants = z
  .object({
    completion: nonNegativeInteger,
    status: nonNegativeInteger,
    finalUrl: nonNegativeInteger,
    redirectChain: nonNegativeInteger,
    bodySha256: nonNegativeInteger,
    metadataValues: nonNegativeInteger,
    metadataLocations: nonNegativeInteger,
  })
  .strict();

const agentStability = z
  .object({
    agent: agentProfile,
    samples: nonNegativeInteger,
    complete: nonNegativeInteger,
    incomplete: nonNegativeInteger,
    timings: stabilityTimings,
    variants: stabilityVariants,
  })
  .strict();

const finding = z
  .object({
    code: z.string().min(1),
    severity,
    message: z.string(),
    url: z.string(),
    agent: z.string().optional(),
    evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

const targetAuditResult = z
  .object({
    target: auditTarget,
    probes: z.array(probeResult),
    findings: z.array(finding),
    stability: z.array(agentStability).optional(),
  })
  .strict();

const auditSummary = z
  .object({
    targets: nonNegativeInteger,
    probes: nonNegativeInteger,
    errors: nonNegativeInteger,
    warnings: nonNegativeInteger,
    info: nonNegativeInteger,
    incomplete: nonNegativeInteger,
  })
  .strict();

const auditReportSchema = z
  .object({
    schemaVersion: z.literal(AUDIT_SCHEMA_VERSION),
    version: z.string().min(1),
    generatedAt: z.string().min(1),
    durationMs: nonNegativeNumber,
    repeat: z.number().int().min(1).max(10).optional(),
    results: z.array(targetAuditResult),
    summary: auditSummary,
  })
  .strict();

export class AuditReportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuditReportError";
  }
}

export function parseAuditReport(value: unknown, source = "audit report"): AuditResult {
  const parsed = auditReportSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`)
      .join("; ");
    throw new AuditReportError(`Invalid ${source}: ${detail}`);
  }

  // The complete runtime schema above is the persisted counterpart of AuditResult.
  return parsed.data as AuditResult;
}

export function parseAuditReportText(text: string, source = "audit report"): AuditResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new AuditReportError(`Could not parse ${source} as JSON.`);
  }
  return parseAuditReport(value, source);
}
