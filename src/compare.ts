import { AUDIT_SCHEMA_VERSION } from "./audit-report.js";
import {
  effectiveTwitterCardSignal,
  firstSocialSignal,
  OPEN_GRAPH_REQUIRED_PROPERTIES,
  TWITTER_CARD_REQUIRED_FIELDS,
  type TwitterCardField,
} from "./social.js";
import { calculateTimingStats, criticalSignalsArrivalMs } from "./stability.js";
import type {
  AuditComparison,
  AuditResult,
  AuditTarget,
  CompareAuditOptions,
  ComparisonChange,
  ComparisonKind,
  ComparisonTimelineEvent,
  ComparisonTimelineLane,
  ComparisonTimelineSnapshot,
  ElementLocation,
  ElementSignal,
  Finding,
  ProbeResult,
  SocialMetadataProperty,
  TargetAuditResult,
  TargetComparison,
  TargetExpectations,
} from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_TIMING_REGRESSION_MS = 250;
const DEFAULT_TIMING_REGRESSION_PERCENT = 25;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SEVERITY_RANK = { info: 0, warning: 1, error: 2 } as const;

interface MetadataField {
  readonly key: string;
  readonly label: string;
  readonly signals: (probe: ProbeResult) => readonly ElementSignal[];
}

interface TimelineObservation {
  readonly atMs: number;
  readonly observedByByte?: number;
  readonly location?: ElementLocation | "mixed";
}

interface TimelineDefinition {
  readonly key: string;
  readonly label: string;
  readonly observe: (target: AuditTarget, probe: ProbeResult) => TimelineObservation | undefined;
}

const SOCIAL_PROPERTIES: readonly SocialMetadataProperty[] = [
  "og:title",
  "og:type",
  "og:url",
  "og:image",
  "og:description",
  "twitter:card",
  "twitter:title",
  "twitter:description",
  "twitter:image",
];

function socialSignals(
  probe: ProbeResult,
  property: SocialMetadataProperty,
): readonly ElementSignal[] {
  return (probe.signals.socialMetadata ?? []).filter((signal) => signal.property === property);
}

const METADATA_FIELDS: readonly MetadataField[] = [
  {
    key: "title",
    label: "title",
    signals: (probe) => probe.signals.titles ?? (probe.signals.title ? [probe.signals.title] : []),
  },
  { key: "description", label: "description", signals: (probe) => probe.signals.descriptions },
  { key: "canonical", label: "canonical", signals: (probe) => probe.signals.canonicals },
  { key: "robots", label: "robots", signals: (probe) => probe.signals.robots },
  { key: "h1", label: "H1", signals: (probe) => probe.signals.h1s },
  {
    key: "main-text",
    label: "main text",
    signals: (probe) =>
      probe.signals.firstMainText === undefined ? [] : [probe.signals.firstMainText],
  },
  ...SOCIAL_PROPERTIES.map(
    (property): MetadataField => ({
      key: property,
      label: property,
      signals: (probe) => socialSignals(probe, property),
    }),
  ),
];

export class ComparisonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ComparisonError";
  }
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: readonly number[]): number | undefined {
  return calculateTimingStats(values)?.medianMs;
}

function targetKey(target: AuditTarget): string {
  return target.id === undefined ? `url:${target.url}` : `id:${target.id}`;
}

function displayKey(target: AuditTarget): string {
  return target.id ?? target.url;
}

function targetMap(report: AuditResult, label: string): Map<string, TargetAuditResult> {
  const results = new Map<string, TargetAuditResult>();
  for (const result of report.results) {
    const key = targetKey(result.target);
    if (results.has(key)) {
      throw new ComparisonError(`${label} contains a duplicate target identity.`);
    }
    results.set(key, result);
  }
  return results;
}

function threshold(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new ComparisonError(`${label} must be a finite non-negative number.`);
  }
  return resolved;
}

function kindOrder(kind: ComparisonKind): number {
  if (kind === "regression") return 0;
  if (kind === "fixed") return 1;
  return 2;
}

function sortChanges(changes: readonly ComparisonChange[]): readonly ComparisonChange[] {
  return [...changes].sort(
    (left, right) =>
      kindOrder(left.kind) - kindOrder(right.kind) ||
      (left.agent ?? "").localeCompare(right.agent ?? "") ||
      (left.field ?? "").localeCompare(right.field ?? "") ||
      left.code.localeCompare(right.code),
  );
}

function findingKey(finding: Finding): string {
  return `${finding.code}\u0000${finding.agent ?? ""}`;
}

function findingMap(findings: readonly Finding[]): Map<string, Finding> {
  const mapped = new Map<string, Finding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = mapped.get(key);
    if (
      existing === undefined ||
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]
    ) {
      mapped.set(key, finding);
    }
  }
  return mapped;
}

function stableEvidence(finding: Finding): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(finding.evidence ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function compareFindings(
  baseline: readonly Finding[],
  candidate: readonly Finding[],
  ignoredCodes: ReadonlySet<string> = new Set(),
): readonly ComparisonChange[] {
  const baselineMap = findingMap(baseline.filter((finding) => !ignoredCodes.has(finding.code)));
  const candidateMap = findingMap(candidate.filter((finding) => !ignoredCodes.has(finding.code)));
  const keys = new Set([...baselineMap.keys(), ...candidateMap.keys()]);
  const changes: ComparisonChange[] = [];

  for (const key of keys) {
    const before = baselineMap.get(key);
    const after = candidateMap.get(key);
    if (before === undefined && after !== undefined) {
      changes.push({
        kind: after.severity === "info" ? "changed" : "regression",
        scope: "finding",
        code: after.code,
        message: `New ${after.severity} finding: ${after.message}`,
        ...(after.agent === undefined ? {} : { agent: after.agent }),
        candidate: after.severity,
      });
      continue;
    }
    if (before !== undefined && after === undefined) {
      changes.push({
        kind: "fixed",
        scope: "finding",
        code: before.code,
        message: `Resolved ${before.severity} finding: ${before.message}`,
        ...(before.agent === undefined ? {} : { agent: before.agent }),
        baseline: before.severity,
      });
      continue;
    }
    if (before === undefined || after === undefined) {
      continue;
    }

    if (before.severity === after.severity) {
      if (stableEvidence(before) !== stableEvidence(after)) {
        changes.push({
          kind: "changed",
          scope: "finding",
          code: "finding-evidence-changed",
          message: `${after.code} evidence changed while severity remained ${after.severity}.`,
          ...(after.agent === undefined ? {} : { agent: after.agent }),
          field: after.code,
          baseline: stableEvidence(before),
          candidate: stableEvidence(after),
        });
      }
      continue;
    }

    const worsened = SEVERITY_RANK[after.severity] > SEVERITY_RANK[before.severity];
    changes.push({
      kind: worsened ? "regression" : "fixed",
      scope: "finding",
      code: after.code,
      message: `${after.code} severity ${worsened ? "increased" : "decreased"} from ${before.severity} to ${after.severity}.`,
      ...(after.agent === undefined ? {} : { agent: after.agent }),
      baseline: before.severity,
      candidate: after.severity,
    });
  }

  return changes;
}

function agentGroups(result: TargetAuditResult): Map<string, readonly ProbeResult[]> {
  const groups = new Map<string, ProbeResult[]>();
  for (const probe of result.probes) {
    const probes = groups.get(probe.agent.key) ?? [];
    probes.push(probe);
    groups.set(probe.agent.key, probes);
  }
  return groups;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function valuesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function displayValues(values: readonly string[]): string {
  if (values.length === 0) return "<missing>";
  const visible = values
    .slice(0, 3)
    .map((value) => (value.length <= 160 ? value : `${value.slice(0, 159)}…`));
  return `${visible.join(" | ")}${values.length > visible.length ? ` | +${values.length - visible.length} more` : ""}`;
}

function normalizeUrlForOrigin(value: string, originUrl: string): string {
  try {
    const url = new URL(value, originUrl);
    const origin = new URL(originUrl).origin;
    return url.origin === origin ? `${url.pathname}${url.search}` : url.href;
  } catch {
    return normalizeText(value);
  }
}

function compareResponses(
  baselineTarget: AuditTarget,
  candidateTarget: AuditTarget,
  agent: string,
  baseline: readonly ProbeResult[],
  candidate: readonly ProbeResult[],
): readonly ComparisonChange[] {
  const changes: ComparisonChange[] = [];
  const beforeCompletions = uniqueStrings(baseline.map((probe) => probe.completion));
  const afterCompletions = uniqueStrings(candidate.map((probe) => probe.completion));
  if (!valuesEqual(beforeCompletions, afterCompletions)) {
    const beforeComplete = beforeCompletions.length === 1 && beforeCompletions[0] === "complete";
    const afterComplete = afterCompletions.length === 1 && afterCompletions[0] === "complete";
    const kind: ComparisonKind = beforeComplete
      ? "regression"
      : afterComplete
        ? "fixed"
        : "changed";
    changes.push({
      kind,
      scope: "response",
      code: "probe-completion-changed",
      message: `Probe completion changed from ${beforeCompletions.join(", ")} to ${afterCompletions.join(", ")}.`,
      agent,
      field: "completion",
      baseline: beforeCompletions.join(", "),
      candidate: afterCompletions.join(", "),
    });
  }

  const statuses = (probes: readonly ProbeResult[]): readonly string[] =>
    uniqueStrings(probes.map((probe) => String(probe.status ?? "missing")));
  const beforeStatuses = statuses(baseline);
  const afterStatuses = statuses(candidate);
  if (!valuesEqual(beforeStatuses, afterStatuses)) {
    changes.push({
      kind: "changed",
      scope: "response",
      code: "http-status-changed",
      message: `HTTP status changed from ${beforeStatuses.join(", ")} to ${afterStatuses.join(", ")}.`,
      agent,
      field: "status",
      baseline: beforeStatuses.join(", "),
      candidate: afterStatuses.join(", "),
    });
  }

  const finalUrls = (probes: readonly ProbeResult[], target: AuditTarget): readonly string[] =>
    uniqueStrings(probes.map((probe) => normalizeUrlForOrigin(probe.finalUrl, target.url)));
  const beforeFinalUrls = finalUrls(baseline, baselineTarget);
  const afterFinalUrls = finalUrls(candidate, candidateTarget);
  if (!valuesEqual(beforeFinalUrls, afterFinalUrls)) {
    changes.push({
      kind: "changed",
      scope: "response",
      code: "final-url-changed",
      message: "Final response route changed.",
      agent,
      field: "final-url",
      baseline: displayValues(beforeFinalUrls),
      candidate: displayValues(afterFinalUrls),
    });
  }

  const redirectChains = (probes: readonly ProbeResult[], target: AuditTarget): readonly string[] =>
    uniqueStrings(
      probes.map((probe) =>
        probe.redirects.length === 0
          ? "<none>"
          : probe.redirects
              .map(
                (redirect) =>
                  `${redirect.status} ${normalizeUrlForOrigin(redirect.location, target.url)}`,
              )
              .join(" → "),
      ),
    );
  const beforeRedirects = redirectChains(baseline, baselineTarget);
  const afterRedirects = redirectChains(candidate, candidateTarget);
  if (!valuesEqual(beforeRedirects, afterRedirects)) {
    changes.push({
      kind: "changed",
      scope: "response",
      code: "redirect-chain-changed",
      message: "Redirect chain changed.",
      agent,
      field: "redirects",
      baseline: displayValues(beforeRedirects),
      candidate: displayValues(afterRedirects),
    });
  }

  return changes;
}

function metadataValues(field: MetadataField, probes: readonly ProbeResult[]): readonly string[] {
  return uniqueStrings(
    probes
      .filter((probe) => probe.completion === "complete")
      .flatMap((probe) => field.signals(probe))
      .map((signal) => normalizeText(signal.value))
      .filter((value) => value.length > 0),
  );
}

function metadataLocations(
  field: MetadataField,
  probes: readonly ProbeResult[],
): readonly string[] {
  return uniqueStrings(
    probes
      .filter((probe) => probe.completion === "complete")
      .flatMap((probe) => field.signals(probe))
      .filter((signal) => normalizeText(signal.value).length > 0)
      .map((signal) => signal.location),
  );
}

function compareMetadata(
  agent: string,
  baseline: readonly ProbeResult[],
  candidate: readonly ProbeResult[],
): readonly ComparisonChange[] {
  if (
    !baseline.some((probe) => probe.completion === "complete") ||
    !candidate.some((probe) => probe.completion === "complete")
  ) {
    return [];
  }

  const changes: ComparisonChange[] = [];
  for (const field of METADATA_FIELDS) {
    const beforeValues = metadataValues(field, baseline);
    const afterValues = metadataValues(field, candidate);
    if (!valuesEqual(beforeValues, afterValues)) {
      changes.push({
        kind: "changed",
        scope: "metadata",
        code: "metadata-value-changed",
        message: `${field.label} value changed.`,
        agent,
        field: field.key,
        baseline: displayValues(beforeValues),
        candidate: displayValues(afterValues),
      });
    }

    const beforeLocations = metadataLocations(field, baseline);
    const afterLocations = metadataLocations(field, candidate);
    if (!valuesEqual(beforeLocations, afterLocations)) {
      changes.push({
        kind: "changed",
        scope: "metadata",
        code: "metadata-location-changed",
        message: `${field.label} document location changed.`,
        agent,
        field: field.key,
        baseline: displayValues(beforeLocations),
        candidate: displayValues(afterLocations),
      });
    }
  }
  return changes;
}

function timingValues(
  metric: "headers" | "first-byte" | "critical-signals" | "complete",
  target: AuditTarget,
  probes: readonly ProbeResult[],
): readonly number[] {
  if (metric === "headers") {
    return probes.flatMap((probe) =>
      probe.status !== undefined && !REDIRECT_STATUSES.has(probe.status)
        ? [probe.timings.headersMs]
        : [],
    );
  }
  if (metric === "first-byte") {
    return probes.flatMap((probe) =>
      probe.timings.firstByteMs === undefined ? [] : [probe.timings.firstByteMs],
    );
  }
  if (metric === "complete") {
    return probes.flatMap((probe) =>
      probe.completion === "complete" && probe.timings.completeMs !== undefined
        ? [probe.timings.completeMs]
        : [],
    );
  }
  return probes.flatMap((probe) => {
    if (probe.completion !== "complete") return [];
    const value = criticalSignalsArrivalMs(target, probe);
    return value === undefined ? [] : [value];
  });
}

function crossesTimingThreshold(
  improvementMs: number,
  referenceMs: number,
  minimumMs: number,
  minimumPercent: number,
): boolean {
  const percent =
    referenceMs === 0
      ? improvementMs > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : (improvementMs / referenceMs) * 100;
  return improvementMs > minimumMs && percent > minimumPercent;
}

function compareTimings(
  baselineTarget: AuditTarget,
  candidateTarget: AuditTarget,
  agent: string,
  baseline: readonly ProbeResult[],
  candidate: readonly ProbeResult[],
  minimumMs: number,
  minimumPercent: number,
): readonly ComparisonChange[] {
  const changes: ComparisonChange[] = [];
  const labels = {
    headers: "response headers",
    "first-byte": "first byte",
    "critical-signals": "required signals",
    complete: "completion",
  } as const;

  const sameCriticalPolicy =
    baselineTarget.expectations.requireTitle === candidateTarget.expectations.requireTitle &&
    baselineTarget.expectations.requireDescription ===
      candidateTarget.expectations.requireDescription &&
    baselineTarget.expectations.requireCanonical ===
      candidateTarget.expectations.requireCanonical &&
    baselineTarget.expectations.requireH1 === candidateTarget.expectations.requireH1 &&
    baselineTarget.expectations.requireMainText === candidateTarget.expectations.requireMainText &&
    (baselineTarget.expectations.requireOpenGraph ?? false) ===
      (candidateTarget.expectations.requireOpenGraph ?? false) &&
    (baselineTarget.expectations.requireTwitterCard ?? false) ===
      (candidateTarget.expectations.requireTwitterCard ?? false);

  for (const metric of ["headers", "first-byte", "critical-signals", "complete"] as const) {
    if (metric === "critical-signals" && !sameCriticalPolicy) continue;
    const before = median(timingValues(metric, baselineTarget, baseline));
    const after = median(timingValues(metric, candidateTarget, candidate));
    if (before === undefined || after === undefined || before === after) continue;

    const delta = after - before;
    const slower = delta > 0;
    if (!crossesTimingThreshold(Math.abs(delta), before, minimumMs, minimumPercent)) continue;

    const percent = before === 0 ? Number.POSITIVE_INFINITY : (Math.abs(delta) / before) * 100;
    changes.push({
      kind: slower ? "regression" : "fixed",
      scope: "timing",
      code: slower ? "timing-regression" : "timing-improvement",
      message: `${labels[metric]} median became ${rounded(Math.abs(delta))} ms (${Number.isFinite(percent) ? `${rounded(percent)}%` : "∞"}) ${slower ? "slower" : "faster"}.`,
      agent,
      field: metric,
      baseline: rounded(before),
      candidate: rounded(after),
    });
  }
  return changes;
}

function changedExpectationFields(
  baseline: TargetExpectations,
  candidate: TargetExpectations,
): readonly string[] {
  const fields: readonly (keyof TargetExpectations)[] = [
    "statuses",
    "finalUrl",
    "requireTitle",
    "requireDescription",
    "requireCanonical",
    "requireH1",
    "requireMainText",
    "requireOpenGraph",
    "requireTwitterCard",
    "maxFirstByteMs",
    "maxCriticalMs",
  ];
  return fields.filter(
    (field) => JSON.stringify(baseline[field] ?? null) !== JSON.stringify(candidate[field] ?? null),
  );
}

function combinedLocation(
  signals: readonly ElementSignal[],
): ElementLocation | "mixed" | undefined {
  const locations = uniqueStrings(signals.map((signal) => signal.location));
  if (locations.length === 0) return undefined;
  if (locations.length > 1) return "mixed";
  const location = locations[0];
  return location === "head" || location === "body" || location === "document"
    ? location
    : undefined;
}

function signalObservation(signals: readonly ElementSignal[]): TimelineObservation | undefined {
  const usable = signals.filter((signal) => normalizeText(signal.value).length > 0);
  const arrival =
    usable.length === 0 ? undefined : Math.max(...usable.map((signal) => signal.atMs));
  if (arrival === undefined) return undefined;
  const location = combinedLocation(usable);
  return {
    atMs: arrival,
    observedByByte: Math.max(...usable.map((signal) => signal.observedByByte)),
    ...(location === undefined ? {} : { location }),
  };
}

function firstNonEmptySignal(signals: readonly ElementSignal[]): readonly ElementSignal[] {
  const signal = signals.find((item) => normalizeText(item.value).length > 0);
  return signal === undefined ? [] : [signal];
}

function twitterReadySignals(probe: ProbeResult): readonly ElementSignal[] {
  return TWITTER_CARD_REQUIRED_FIELDS.flatMap((field: TwitterCardField) => {
    const signal = effectiveTwitterCardSignal(probe.signals, field);
    return signal === undefined ? [] : [signal];
  });
}

const TIMELINE_DEFINITIONS: readonly TimelineDefinition[] = [
  {
    key: "headers",
    label: "Headers",
    observe: (_target, probe) => ({ atMs: probe.timings.headersMs }),
  },
  {
    key: "first-byte",
    label: "First byte",
    observe: (_target, probe) =>
      probe.timings.firstByteMs === undefined ? undefined : { atMs: probe.timings.firstByteMs },
  },
  {
    key: "title",
    label: "Title",
    observe: (_target, probe) =>
      signalObservation(probe.signals.title === undefined ? [] : [probe.signals.title]),
  },
  {
    key: "description",
    label: "Description",
    observe: (_target, probe) => signalObservation(firstNonEmptySignal(probe.signals.descriptions)),
  },
  {
    key: "canonical",
    label: "Canonical",
    observe: (_target, probe) => signalObservation(firstNonEmptySignal(probe.signals.canonicals)),
  },
  {
    key: "open-graph",
    label: "Open Graph ready",
    observe: (_target, probe) => {
      const signals = OPEN_GRAPH_REQUIRED_PROPERTIES.flatMap((property) => {
        const signal = firstSocialSignal(probe.signals, property);
        return signal === undefined ? [] : [signal];
      });
      return signals.length === OPEN_GRAPH_REQUIRED_PROPERTIES.length
        ? signalObservation(signals)
        : undefined;
    },
  },
  {
    key: "twitter-card",
    label: "Twitter Card ready",
    observe: (_target, probe) => {
      const signals = twitterReadySignals(probe);
      return signals.length === TWITTER_CARD_REQUIRED_FIELDS.length
        ? signalObservation(signals)
        : undefined;
    },
  },
  {
    key: "required",
    label: "Required ready",
    observe: (target, probe) => {
      const atMs = criticalSignalsArrivalMs(target, probe);
      return atMs === undefined ? undefined : { atMs };
    },
  },
  {
    key: "main",
    label: "Main text",
    observe: (_target, probe) =>
      signalObservation(
        probe.signals.firstMainText === undefined ? [] : [probe.signals.firstMainText],
      ),
  },
  {
    key: "complete",
    label: "Complete",
    observe: (_target, probe) =>
      probe.completion !== "complete" || probe.timings.completeMs === undefined
        ? undefined
        : { atMs: probe.timings.completeMs },
  },
];

function timelineSnapshot(
  target: AuditTarget,
  probes: readonly ProbeResult[],
): ComparisonTimelineSnapshot | undefined {
  if (probes.length === 0) return undefined;
  const events: ComparisonTimelineEvent[] = [];
  for (const definition of TIMELINE_DEFINITIONS) {
    const observations = probes.flatMap((probe) => {
      const observation = definition.observe(target, probe);
      return observation === undefined ? [] : [observation];
    });
    const medianMs = median(observations.map((observation) => observation.atMs));
    if (medianMs === undefined) continue;
    const bytes = median(
      observations.flatMap((observation) =>
        observation.observedByByte === undefined ? [] : [observation.observedByByte],
      ),
    );
    const locations = uniqueStrings(
      observations.flatMap((observation) =>
        observation.location === undefined ? [] : [observation.location],
      ),
    );
    const location =
      locations.length === 1 ? locations[0] : locations.length > 1 ? "mixed" : undefined;
    events.push({
      key: definition.key,
      label: definition.label,
      medianMs: rounded(medianMs),
      ...(location === "head" ||
      location === "body" ||
      location === "document" ||
      location === "mixed"
        ? { location }
        : {}),
      ...(bytes === undefined ? {} : { observedByByte: rounded(bytes) }),
    });
  }
  return { samples: probes.length, events };
}

function comparisonTimelines(
  baseline: TargetAuditResult | undefined,
  candidate: TargetAuditResult | undefined,
): readonly ComparisonTimelineLane[] {
  const before: Map<string, readonly ProbeResult[]> =
    baseline === undefined ? new Map() : agentGroups(baseline);
  const after: Map<string, readonly ProbeResult[]> =
    candidate === undefined ? new Map() : agentGroups(candidate);
  const agentKeys = [...new Set([...before.keys(), ...after.keys()])];
  return agentKeys.map((agent) => {
    const baselineProbes = before.get(agent) ?? [];
    const candidateProbes = after.get(agent) ?? [];
    const profile = candidateProbes[0]?.agent ?? baselineProbes[0]?.agent;
    const baselineSnapshot =
      baseline === undefined ? undefined : timelineSnapshot(baseline.target, baselineProbes);
    const candidateSnapshot =
      candidate === undefined ? undefined : timelineSnapshot(candidate.target, candidateProbes);
    return {
      agent,
      label: profile?.label ?? agent,
      ...(baselineSnapshot === undefined ? {} : { baseline: baselineSnapshot }),
      ...(candidateSnapshot === undefined ? {} : { candidate: candidateSnapshot }),
    };
  });
}

function compareMatchedTarget(
  baseline: TargetAuditResult,
  candidate: TargetAuditResult,
  timingRegressionMs: number,
  timingRegressionPercent: number,
): readonly ComparisonChange[] {
  const changes: ComparisonChange[] = [
    ...compareFindings(baseline.findings, candidate.findings, new Set(["incomplete-probe"])),
  ];
  const policyFields = changedExpectationFields(
    baseline.target.expectations,
    candidate.target.expectations,
  );
  if (policyFields.length > 0) {
    changes.push({
      kind: "changed",
      scope: "target",
      code: "target-policy-changed",
      message: `Target policy changed: ${policyFields.join(", ")}.`,
      field: "expectations",
    });
  }

  const beforeAgents = agentGroups(baseline);
  const afterAgents = agentGroups(candidate);
  const agents = new Set([...beforeAgents.keys(), ...afterAgents.keys()]);
  for (const agent of agents) {
    const before = beforeAgents.get(agent);
    const after = afterAgents.get(agent);
    if (before === undefined && after !== undefined) {
      changes.push({
        kind: "changed",
        scope: "agent",
        code: "agent-added",
        message: `Agent ${agent} was added to the candidate report.`,
        agent,
      });
      continue;
    }
    if (before !== undefined && after === undefined) {
      changes.push({
        kind: "changed",
        scope: "agent",
        code: "agent-removed",
        message: `Agent ${agent} is absent from the candidate report.`,
        agent,
      });
      continue;
    }
    if (before === undefined || after === undefined) continue;

    changes.push(
      ...compareResponses(baseline.target, candidate.target, agent, before, after),
      ...compareMetadata(agent, before, after),
      ...compareTimings(
        baseline.target,
        candidate.target,
        agent,
        before,
        after,
        timingRegressionMs,
        timingRegressionPercent,
      ),
    );
  }
  return sortChanges(changes);
}

export function compareAudits(
  baseline: AuditResult,
  candidate: AuditResult,
  options: CompareAuditOptions = {},
): AuditComparison {
  if (
    baseline.schemaVersion !== AUDIT_SCHEMA_VERSION ||
    candidate.schemaVersion !== AUDIT_SCHEMA_VERSION
  ) {
    throw new ComparisonError(`Both audit reports must use schemaVersion ${AUDIT_SCHEMA_VERSION}.`);
  }
  const timingRegressionMs = threshold(
    options.timingRegressionMs,
    DEFAULT_TIMING_REGRESSION_MS,
    "timingRegressionMs",
  );
  const timingRegressionPercent = threshold(
    options.timingRegressionPercent,
    DEFAULT_TIMING_REGRESSION_PERCENT,
    "timingRegressionPercent",
  );
  const baselineMap = targetMap(baseline, "Baseline report");
  const candidateMap = targetMap(candidate, "Candidate report");
  const keys = [...baselineMap.keys(), ...candidateMap.keys()].filter(
    (key, index, all) => all.indexOf(key) === index,
  );
  const results: TargetComparison[] = [];

  for (const key of keys) {
    const before = baselineMap.get(key);
    const after = candidateMap.get(key);
    const target = after?.target ?? before?.target;
    if (target === undefined) continue;
    if (before === undefined && after !== undefined) {
      results.push({
        key: displayKey(target),
        ...(target.id === undefined ? {} : { id: target.id }),
        status: "added",
        candidateUrl: target.url,
        changes: sortChanges([
          {
            kind: "changed",
            scope: "target",
            code: "target-added",
            message: "Target exists only in the candidate report.",
          },
          ...compareFindings([], after.findings),
        ]),
        timelines: comparisonTimelines(undefined, after),
      });
      continue;
    }
    if (before !== undefined && after === undefined) {
      results.push({
        key: displayKey(target),
        ...(target.id === undefined ? {} : { id: target.id }),
        status: "removed",
        baselineUrl: target.url,
        changes: [
          {
            kind: "changed",
            scope: "target",
            code: "target-removed",
            message: "Target exists only in the baseline report.",
          },
        ],
        timelines: comparisonTimelines(before, undefined),
      });
      continue;
    }
    if (before === undefined || after === undefined) continue;

    results.push({
      key: displayKey(after.target),
      ...(after.target.id === undefined ? {} : { id: after.target.id }),
      status: "matched",
      baselineUrl: before.target.url,
      candidateUrl: after.target.url,
      changes: compareMatchedTarget(before, after, timingRegressionMs, timingRegressionPercent),
      timelines: comparisonTimelines(before, after),
    });
  }

  const allChanges = results.flatMap((result) => result.changes);
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    kind: "comparison",
    version: VERSION,
    generatedAt: new Date().toISOString(),
    baseline: {
      label: options.baselineLabel ?? "Baseline",
      version: baseline.version,
      schemaVersion: baseline.schemaVersion,
      generatedAt: baseline.generatedAt,
      repeat: baseline.repeat ?? 1,
    },
    candidate: {
      label: options.candidateLabel ?? "Candidate",
      version: candidate.version,
      schemaVersion: candidate.schemaVersion,
      generatedAt: candidate.generatedAt,
      repeat: candidate.repeat ?? 1,
    },
    thresholds: { timingRegressionMs, timingRegressionPercent },
    results,
    summary: {
      targets: results.length,
      matchedTargets: results.filter((result) => result.status === "matched").length,
      addedTargets: results.filter((result) => result.status === "added").length,
      removedTargets: results.filter((result) => result.status === "removed").length,
      unchangedTargets: results.filter(
        (result) => result.status === "matched" && result.changes.length === 0,
      ).length,
      regressions: allChanges.filter((change) => change.kind === "regression").length,
      fixed: allChanges.filter((change) => change.kind === "fixed").length,
      changed: allChanges.filter((change) => change.kind === "changed").length,
    },
  };
}
