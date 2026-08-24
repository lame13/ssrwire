import type {
  AgentProfile,
  AgentStability,
  AuditTarget,
  ElementSignal,
  Finding,
  ProbeResult,
  RobotsAudience,
  RobotsSignal,
  TimingStats,
} from "./types.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ROBOTS_OPPOSITES = [
  ["index", "noindex"],
  ["follow", "nofollow"],
  ["archive", "noarchive"],
  ["snippet", "nosnippet"],
  ["translate", "notranslate"],
  ["imageindex", "noimageindex"],
] as const;

export interface StabilityAnalysis {
  readonly stability: readonly AgentStability[];
  readonly findings: readonly Finding[];
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeUrl(value: string, baseUrl?: string): string {
  try {
    const url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
    url.hash = "";
    return url.href;
  } catch {
    return normalizeText(value);
  }
}

function normalizeCanonical(value: string, baseUrl: string): string {
  const normalized = normalizeText(value);
  return normalized.length === 0 ? "" : normalizeUrl(normalized, baseUrl);
}

function normalizedSignalValues(
  signals: readonly ElementSignal[],
  normalize: (value: string) => string = normalizeText,
): readonly string[] {
  return [
    ...new Set(
      signals.map((signal) => normalize(signal.value)).filter((value) => value.length > 0),
    ),
  ].sort();
}

function robotsAudienceForAgent(agent: AgentProfile): RobotsAudience {
  const key = agent.key.trim().toLowerCase();
  if (key === "googlebot" || key === "bingbot") return key;
  return "robots";
}

function effectiveRobotsSignals(probe: ProbeResult): readonly RobotsSignal[] {
  const audience = robotsAudienceForAgent(probe.agent);
  const generic = probe.signals.robots.filter((signal) => signal.audience === "robots");
  if (audience === "robots") return generic;
  return [...generic, ...probe.signals.robots.filter((signal) => signal.audience === audience)];
}

function normalizedRobotsValue(signals: readonly RobotsSignal[]): string {
  const directives = new Set(
    signals
      .flatMap((signal) => normalizeText(signal.value).toLowerCase().split(/[;,]/))
      .map((directive) => directive.trim())
      .filter((directive) => directive.length > 0),
  );
  if (directives.delete("none")) {
    directives.add("noindex");
    directives.add("nofollow");
  }
  if (directives.delete("all")) {
    directives.add("index");
    directives.add("follow");
  }
  for (const [permissive, restrictive] of ROBOTS_OPPOSITES) {
    if (directives.has(restrictive)) directives.delete(permissive);
  }
  return [...directives].sort().join(",") || "<missing>";
}

function effectiveRobotsValue(probe: ProbeResult): string {
  return normalizedRobotsValue(effectiveRobotsSignals(probe));
}

function signalValueLocations(
  signals: readonly ElementSignal[],
  normalize: (value: string) => string = normalizeText,
): readonly (readonly [string, string])[] {
  const entries = signals
    .map((signal) => [normalize(signal.value), signal.location] as const)
    .filter(([value]) => value.length > 0);
  return [...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values()].sort(
    ([leftValue, leftLocation], [rightValue, rightLocation]) => {
      const valueOrder = leftValue.localeCompare(rightValue);
      return valueOrder === 0 ? leftLocation.localeCompare(rightLocation) : valueOrder;
    },
  );
}

function robotsValueLocations(probe: ProbeResult): readonly (readonly [string, string])[] {
  const entries = effectiveRobotsSignals(probe)
    .map((signal) => [normalizedRobotsValue([signal]), signal.location] as const)
    .filter(([value]) => value !== "<missing>");
  return [...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values()].sort(
    (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function metadataValueSignature(probe: ProbeResult): string {
  const titles = probe.signals.titles ?? (probe.signals.title ? [probe.signals.title] : []);
  return JSON.stringify({
    title: normalizedSignalValues(titles),
    description: normalizedSignalValues(probe.signals.descriptions),
    canonical: normalizedSignalValues(probe.signals.canonicals, (value) =>
      normalizeCanonical(value, probe.finalUrl),
    ),
    robots: effectiveRobotsValue(probe),
  });
}

function metadataLocationSignature(probe: ProbeResult): string {
  const titles = probe.signals.titles ?? (probe.signals.title ? [probe.signals.title] : []);
  return JSON.stringify({
    title: signalValueLocations(titles),
    description: signalValueLocations(probe.signals.descriptions),
    canonical: signalValueLocations(probe.signals.canonicals, (value) =>
      normalizeCanonical(value, probe.finalUrl),
    ),
    robots: robotsValueLocations(probe),
  });
}

function redirectChainSignature(probe: ProbeResult): string {
  return JSON.stringify(
    probe.redirects.map((redirect) => ({
      status: redirect.status,
      url: normalizeUrl(redirect.url),
      location: normalizeUrl(redirect.location, redirect.url),
    })),
  );
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values).size;
}

export function calculateTimingStats(values: readonly number[]): TimingStats | undefined {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;

  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  const medianMs =
    sorted.length % 2 === 0 && lower !== undefined && upper !== undefined
      ? (lower + upper) / 2
      : (upper ?? sorted[0] ?? 0);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted[sorted.length - 1] ?? minMs;

  return {
    samples: sorted.length,
    minMs,
    medianMs,
    p95Ms: sorted[p95Index] ?? maxMs,
    maxMs,
    spreadMs: maxMs - minMs,
  };
}

function firstNonEmpty(signals: readonly ElementSignal[]): ElementSignal | undefined {
  return signals.find((signal) => normalizeText(signal.value).length > 0);
}

export function criticalSignalsArrivalMs(
  target: AuditTarget,
  probe: ProbeResult,
): number | undefined {
  const marks: number[] = [];
  const { expectations } = target;
  let required = 0;

  const addRequired = (signal: ElementSignal | undefined): boolean => {
    required += 1;
    if (signal === undefined || normalizeText(signal.value).length === 0) return false;
    marks.push(signal.atMs);
    return true;
  };

  if (expectations.requireTitle && !addRequired(probe.signals.title)) return undefined;
  if (expectations.requireDescription && !addRequired(firstNonEmpty(probe.signals.descriptions))) {
    return undefined;
  }
  if (expectations.requireCanonical) {
    const canonical = probe.signals.canonicals.find(
      (signal) => normalizeCanonical(signal.value, probe.finalUrl).length > 0,
    );
    if (!addRequired(canonical)) return undefined;
  }
  if (expectations.requireH1 && !addRequired(firstNonEmpty(probe.signals.h1s))) return undefined;
  if (expectations.requireMainText && !addRequired(probe.signals.firstMainText)) return undefined;

  return required === 0 ? undefined : Math.max(...marks);
}

function addStats(
  values: readonly number[],
  key: "headers" | "firstByte" | "criticalSignals" | "complete",
  target: Record<string, TimingStats>,
): void {
  const stats = calculateTimingStats(values);
  if (stats !== undefined) target[key] = stats;
}

function summarizeAgent(target: AuditTarget, probes: readonly ProbeResult[]): AgentStability {
  const agent = probes[0]?.agent;
  if (agent === undefined) throw new Error("Cannot summarize an empty probe group.");
  const complete = probes.filter((probe) => probe.completion === "complete");
  const finalResponses = probes.filter(
    (probe) => probe.status !== undefined && !REDIRECT_STATUSES.has(probe.status),
  );
  const timings: Record<string, TimingStats> = {};

  addStats(
    finalResponses.map((probe) => probe.timings.headersMs),
    "headers",
    timings,
  );
  addStats(
    probes.flatMap((probe) =>
      probe.timings.firstByteMs === undefined ? [] : [probe.timings.firstByteMs],
    ),
    "firstByte",
    timings,
  );
  addStats(
    complete.flatMap((probe) => {
      const value = criticalSignalsArrivalMs(target, probe);
      return value === undefined ? [] : [value];
    }),
    "criticalSignals",
    timings,
  );
  addStats(
    complete.flatMap((probe) =>
      probe.timings.completeMs === undefined ? [] : [probe.timings.completeMs],
    ),
    "complete",
    timings,
  );

  return {
    agent,
    samples: probes.length,
    complete: complete.length,
    incomplete: probes.length - complete.length,
    timings,
    variants: {
      completion: uniqueCount(probes.map((probe) => probe.completion)),
      status: uniqueCount(finalResponses.map((probe) => String(probe.status))),
      finalUrl: uniqueCount(finalResponses.map((probe) => normalizeUrl(probe.finalUrl))),
      redirectChain: uniqueCount(probes.map(redirectChainSignature)),
      bodySha256: uniqueCount(complete.map((probe) => probe.bodySha256 ?? "<missing>")),
      metadataValues: uniqueCount(complete.map(metadataValueSignature)),
      metadataLocations: uniqueCount(complete.map(metadataLocationSignature)),
    },
  };
}

function finding(
  target: AuditTarget,
  summary: AgentStability,
  code: "response-instability" | "stream-instability",
  severity: "info" | "warning",
  fields: readonly string[],
): Finding {
  const variants = summary.variants;
  return {
    code,
    severity,
    message:
      code === "response-instability"
        ? `${summary.agent.label} returned inconsistent HTTP response evidence across samples.`
        : `${summary.agent.label} returned inconsistent streamed HTML evidence across samples.`,
    url: target.url,
    agent: summary.agent.key,
    evidence: {
      samples: summary.samples,
      completeSamples: summary.complete,
      fields: fields.join(", "),
      variantCounts: fields
        .map((field) => `${field}=${variants[field as keyof typeof variants]}`)
        .join("; "),
    },
  };
}

function findingsFor(target: AuditTarget, summary: AgentStability): readonly Finding[] {
  const findings: Finding[] = [];
  const responseFields = (["completion", "status", "finalUrl", "redirectChain"] as const).filter(
    (field) => summary.variants[field] > 1,
  );
  if (responseFields.length > 0) {
    findings.push(finding(target, summary, "response-instability", "warning", responseFields));
  }

  const streamFields = (["bodySha256", "metadataValues", "metadataLocations"] as const).filter(
    (field) => summary.variants[field] > 1,
  );
  if (streamFields.length > 0) {
    const metadataChanged = streamFields.some((field) => field !== "bodySha256");
    findings.push(
      finding(
        target,
        summary,
        "stream-instability",
        metadataChanged ? "warning" : "info",
        streamFields,
      ),
    );
  }

  return findings;
}

export function analyzeStability(
  target: AuditTarget,
  probes: readonly ProbeResult[],
): StabilityAnalysis {
  const groups = new Map<string, ProbeResult[]>();
  for (const probe of probes) {
    const group = groups.get(probe.agent.key) ?? [];
    group.push(probe);
    groups.set(probe.agent.key, group);
  }

  const stability = [...groups.values()].map((group) => summarizeAgent(target, group));
  return {
    stability,
    findings: stability.flatMap((summary) => findingsFor(target, summary)),
  };
}
