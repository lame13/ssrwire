import type {
  AuditSummary,
  AuditTarget,
  ElementSignal,
  Finding,
  ProbeResult,
  RobotsAudience,
  RobotsSignal,
  Severity,
  TargetAuditResult,
} from "./types.js";

type MetadataKind = "title" | "description" | "canonical" | "robots";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ROBOTS_OPPOSITES = [
  ["index", "noindex"],
  ["follow", "nofollow"],
  ["archive", "noarchive"],
  ["snippet", "nosnippet"],
  ["translate", "notranslate"],
  ["imageindex", "noimageindex"],
] as const;

interface FindingInput {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly agent?: string;
  readonly evidence?: Readonly<Record<string, string | number | boolean>>;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeCanonical(value: string, baseUrl: string): string {
  const trimmed = normalizeText(value);
  if (trimmed.length === 0) {
    return "";
  }

  try {
    const url = new URL(trimmed, baseUrl);
    url.hash = "";
    return url.href;
  } catch {
    return trimmed;
  }
}

function normalizeFinalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function normalizeRobots(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .split(/[;,]/)
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0)
    .sort()
    .join(",");
}

function normalizedValues(
  kind: MetadataKind,
  signals: readonly ElementSignal[],
  baseUrl: string,
): readonly string[] {
  return signals
    .map((signal) => {
      if (kind === "canonical") {
        return normalizeCanonical(signal.value, baseUrl);
      }
      if (kind === "robots") {
        return normalizeRobots(signal.value);
      }
      return normalizeText(signal.value);
    })
    .filter((value) => value.length > 0);
}

function robotsAudienceForAgent(probe: ProbeResult): RobotsAudience {
  const key = probe.agent.key.trim().toLowerCase();
  if (key === "googlebot" || key === "bingbot") return key;
  return "robots";
}

function effectiveRobotsSignals(probe: ProbeResult): readonly RobotsSignal[] {
  const audience = robotsAudienceForAgent(probe);
  const generic = probe.signals.robots.filter((signal) => signal.audience === "robots");
  if (audience === "robots") return generic;

  const specific = probe.signals.robots.filter(
    (signal) => signal.audience === audience && normalizeRobots(signal.value).length > 0,
  );
  return [...generic, ...specific];
}

function normalizedRobotsDirectives(signals: readonly RobotsSignal[]): Set<string> {
  const directives = new Set(
    signals
      .flatMap((signal) => normalizeRobots(signal.value).split(","))
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
  return directives;
}

function effectiveRobotsValue(probe: ProbeResult): string {
  return (
    [...normalizedRobotsDirectives(effectiveRobotsSignals(probe))].sort().join(",") || "<missing>"
  );
}

function addFinding(findings: Finding[], url: string, input: FindingInput): void {
  findings.push({
    code: input.code,
    severity: input.severity,
    message: input.message,
    url,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });
}

function checkRepeatedMetadata(
  findings: Finding[],
  targetUrl: string,
  probe: ProbeResult,
  kind: MetadataKind,
  signals: readonly ElementSignal[],
): void {
  const values = normalizedValues(kind, signals, probe.finalUrl);
  if (values.length < 2) {
    return;
  }

  const distinct = new Set(values);
  const conflicting = distinct.size > 1;
  const label = kind === "robots" ? "meta robots directives" : `${kind} elements`;
  addFinding(findings, targetUrl, {
    code: conflicting ? `conflicting-${kind}` : `duplicate-${kind}`,
    severity: "warning",
    message: conflicting
      ? `${probe.agent.label} received conflicting ${label}.`
      : `${probe.agent.label} received duplicate ${label}.`,
    agent: probe.agent.key,
    evidence: {
      count: values.length,
      distinctValues: distinct.size,
      values: [...distinct].join(" | "),
    },
  });
}

function checkRepeatedRobots(findings: Finding[], targetUrl: string, probe: ProbeResult): void {
  const audience = robotsAudienceForAgent(probe);
  const relevantAudiences: readonly RobotsAudience[] =
    audience === "robots" ? ["robots"] : ["robots", audience];
  let conflictReported = false;

  for (const currentAudience of relevantAudiences) {
    const signals = probe.signals.robots.filter(
      (signal) => signal.audience === currentAudience && normalizeRobots(signal.value).length > 0,
    );
    if (signals.length < 2) continue;

    const values = signals.map((signal) => normalizeRobots(signal.value));
    const distinct = new Set(values);
    const rawDirectives = new Set(values.flatMap((value) => value.split(",")));
    if (rawDirectives.has("none")) {
      rawDirectives.add("noindex");
      rawDirectives.add("nofollow");
    }
    if (rawDirectives.has("all")) {
      rawDirectives.add("index");
      rawDirectives.add("follow");
    }
    const conflicting = ROBOTS_OPPOSITES.some(
      ([left, right]) => rawDirectives.has(left) && rawDirectives.has(right),
    );
    if (conflicting) conflictReported = true;
    const code = conflicting
      ? "conflicting-robots"
      : distinct.size === 1
        ? "duplicate-robots"
        : "multiple-robots";
    addFinding(findings, targetUrl, {
      code,
      severity: "warning",
      message: conflicting
        ? `${probe.agent.label} received contradictory ${currentAudience} directives.`
        : `${probe.agent.label} received multiple ${currentAudience} meta directives.`,
      agent: probe.agent.key,
      evidence: {
        audience: currentAudience,
        count: values.length,
        distinctValues: distinct.size,
        values: [...distinct].join(" | "),
      },
    });
  }

  const effectiveSignals = effectiveRobotsSignals(probe);
  const genericDirectives = new Set(
    probe.signals.robots
      .filter((signal) => signal.audience === "robots")
      .flatMap((signal) => normalizeRobots(signal.value).split(",")),
  );
  const specificAudience = robotsAudienceForAgent(probe);
  const specificDirectives = new Set(
    specificAudience === "robots"
      ? []
      : probe.signals.robots
          .filter((signal) => signal.audience === specificAudience)
          .flatMap((signal) => normalizeRobots(signal.value).split(",")),
  );
  if (genericDirectives.has("none")) {
    genericDirectives.add("noindex");
    genericDirectives.add("nofollow");
  }
  if (specificDirectives.has("all")) {
    specificDirectives.add("index");
    specificDirectives.add("follow");
  }
  // A crawler-specific restriction can intentionally tighten a generic rule. The inverse cannot
  // relax an already-applicable generic restriction and is therefore worth flagging.
  const effectiveConflict = ROBOTS_OPPOSITES.some(
    ([permissive, restrictive]) =>
      genericDirectives.has(restrictive) && specificDirectives.has(permissive),
  );
  if (effectiveConflict && !conflictReported) {
    addFinding(findings, targetUrl, {
      code: "conflicting-robots",
      severity: "warning",
      message: `${probe.agent.label} received contradictory effective robots directives.`,
      agent: probe.agent.key,
      evidence: {
        audience: "effective",
        count: effectiveSignals.length,
        distinctValues: new Set([...genericDirectives, ...specificDirectives]).size,
        values: [...new Set([...genericDirectives, ...specificDirectives])].sort().join(","),
      },
    });
  }
}

function criticalArrivalMs(target: AuditTarget, probe: ProbeResult): number | undefined {
  const marks: number[] = [];
  const { expectations } = target;

  if (expectations.requireTitle && normalizeText(probe.signals.title?.value ?? "").length > 0) {
    marks.push(probe.signals.title?.atMs ?? 0);
  }
  if (expectations.requireDescription) {
    const description = probe.signals.descriptions.find(
      (signal) => normalizeText(signal.value).length > 0,
    );
    if (description !== undefined) {
      marks.push(description.atMs);
    }
  }
  if (expectations.requireCanonical) {
    const canonical = probe.signals.canonicals.find(
      (signal) => normalizeCanonical(signal.value, probe.finalUrl).length > 0,
    );
    if (canonical !== undefined) {
      marks.push(canonical.atMs);
    }
  }
  if (expectations.requireH1) {
    const h1 = probe.signals.h1s.find((signal) => normalizeText(signal.value).length > 0);
    if (h1 !== undefined) {
      marks.push(h1.atMs);
    }
  }
  if (
    expectations.requireMainText &&
    normalizeText(probe.signals.firstMainText?.value ?? "").length > 0
  ) {
    marks.push(probe.signals.firstMainText?.atMs ?? 0);
  }

  return marks.length === 0 ? undefined : Math.max(...marks);
}

function checkRequiredSignals(findings: Finding[], target: AuditTarget, probe: ProbeResult): void {
  // An interrupted or deliberately truncated stream cannot prove that an element is absent.
  if (probe.completion !== "complete") {
    return;
  }

  const { expectations } = target;
  const agent = probe.agent.key;
  if (expectations.requireTitle && normalizeText(probe.signals.title?.value ?? "").length === 0) {
    addFinding(findings, target.url, {
      code: "missing-title",
      severity: "error",
      message: `${probe.agent.label} received no non-empty title.`,
      agent,
    });
  }
  if (
    expectations.requireDescription &&
    normalizedValues("description", probe.signals.descriptions, probe.finalUrl).length === 0
  ) {
    addFinding(findings, target.url, {
      code: "missing-description",
      severity: "warning",
      message: `${probe.agent.label} received no non-empty meta description.`,
      agent,
    });
  }
  if (
    expectations.requireCanonical &&
    normalizedValues("canonical", probe.signals.canonicals, probe.finalUrl).length === 0
  ) {
    addFinding(findings, target.url, {
      code: "missing-canonical",
      severity: "warning",
      message: `${probe.agent.label} received no non-empty canonical link.`,
      agent,
    });
  }
  if (
    expectations.requireH1 &&
    !probe.signals.h1s.some((signal) => normalizeText(signal.value).length > 0)
  ) {
    addFinding(findings, target.url, {
      code: "missing-h1",
      severity: "warning",
      message: `${probe.agent.label} received no non-empty H1.`,
      agent,
    });
  }
  if (
    expectations.requireMainText &&
    normalizeText(probe.signals.firstMainText?.value ?? "").length === 0
  ) {
    addFinding(findings, target.url, {
      code: "missing-main-text",
      severity: "warning",
      message: `${probe.agent.label} received no main-content text.`,
      agent,
    });
  }
}

function checkHeadRequirements(findings: Finding[], targetUrl: string, probe: ProbeResult): void {
  if (!probe.agent.requiresHeadMetadata) {
    return;
  }

  const bodyFields = new Set<string>();
  const titles = probe.signals.titles ?? (probe.signals.title ? [probe.signals.title] : []);
  if (titles.some((signal) => signal.location === "body")) {
    bodyFields.add("title");
  }
  if (probe.signals.descriptions.some((signal) => signal.location === "body")) {
    bodyFields.add("description");
  }
  if (probe.signals.canonicals.some((signal) => signal.location === "body")) {
    bodyFields.add("canonical");
  }
  if (effectiveRobotsSignals(probe).some((signal) => signal.location === "body")) {
    bodyFields.add("robots");
  }

  if (bodyFields.size === 0) {
    return;
  }

  addFinding(findings, targetUrl, {
    code: "head-metadata-in-body",
    severity: "error",
    message: `${probe.agent.label} requires head metadata but received ${[...bodyFields].join(
      ", ",
    )} in the body.`,
    agent: probe.agent.key,
    evidence: { fields: [...bodyFields].join(", ") },
  });
}

function checkTimings(findings: Finding[], target: AuditTarget, probe: ProbeResult): void {
  const { expectations } = target;
  const firstByteMs = probe.timings.firstByteMs;
  if (
    expectations.maxFirstByteMs !== undefined &&
    firstByteMs !== undefined &&
    firstByteMs > expectations.maxFirstByteMs
  ) {
    addFinding(findings, target.url, {
      code: "slow-first-byte",
      severity: "warning",
      message: `${probe.agent.label} first byte arrived after the configured limit.`,
      agent: probe.agent.key,
      evidence: { observedMs: firstByteMs, limitMs: expectations.maxFirstByteMs },
    });
  }

  const arrivalMs = criticalArrivalMs(target, probe);
  if (
    expectations.maxCriticalMs !== undefined &&
    arrivalMs !== undefined &&
    arrivalMs > expectations.maxCriticalMs
  ) {
    addFinding(findings, target.url, {
      code: "slow-critical-signals",
      severity: "warning",
      message: `${probe.agent.label} required signals arrived after the configured limit.`,
      agent: probe.agent.key,
      evidence: { observedMs: arrivalMs, limitMs: expectations.maxCriticalMs },
    });
  }
}

function agentValueSummary(
  probes: readonly ProbeResult[],
  valueFor: (probe: ProbeResult) => string,
): string {
  return probes.map((probe) => `${probe.agent.key}=${valueFor(probe)}`).join("; ");
}

function checkAgentDrift(
  findings: Finding[],
  targetUrl: string,
  probes: readonly ProbeResult[],
): void {
  const complete = probes.filter((probe) => probe.completion === "complete");
  if (complete.length < 2) {
    return;
  }

  const comparisons: readonly {
    readonly field: string;
    readonly valueFor: (probe: ProbeResult) => string;
  }[] = [
    { field: "status", valueFor: (probe) => String(probe.status ?? "missing") },
    { field: "final-url", valueFor: (probe) => normalizeFinalUrl(probe.finalUrl) },
    {
      field: "title",
      valueFor: (probe) => normalizeText(probe.signals.title?.value ?? "<missing>"),
    },
    {
      field: "canonical",
      valueFor: (probe) =>
        [...new Set(normalizedValues("canonical", probe.signals.canonicals, probe.finalUrl))]
          .sort()
          .join(" | ") || "<missing>",
    },
    {
      field: "robots",
      valueFor: effectiveRobotsValue,
    },
  ];

  for (const comparison of comparisons) {
    const values = complete.map(comparison.valueFor);
    if (new Set(values).size < 2) {
      continue;
    }

    addFinding(findings, targetUrl, {
      code: `agent-${comparison.field}-drift`,
      severity: "warning",
      message: `Crawler profiles received different ${comparison.field.replace("-", " ")} values.`,
      evidence: { values: agentValueSummary(complete, comparison.valueFor) },
    });
  }
}

export function analyzeTarget(
  target: AuditTarget,
  probes: readonly ProbeResult[],
): readonly Finding[] {
  const findings: Finding[] = [];

  for (const probe of probes) {
    // A status retained from the previous redirect is not evidence that a final response arrived.
    const hasFinalResponse = probe.status !== undefined && !REDIRECT_STATUSES.has(probe.status);
    if (probe.completion !== "complete") {
      addFinding(findings, target.url, {
        code: "incomplete-probe",
        severity: "error",
        message: `${probe.agent.label} probe did not complete (${probe.completion}).`,
        agent: probe.agent.key,
        evidence: {
          completion: probe.completion,
          bytesRead: probe.bytesRead,
          ...(probe.error === undefined ? {} : { error: probe.error }),
        },
      });
    }

    if (
      probe.status !== undefined &&
      !REDIRECT_STATUSES.has(probe.status) &&
      !target.expectations.statuses.includes(probe.status)
    ) {
      addFinding(findings, target.url, {
        code: "status-mismatch",
        severity: "error",
        message: `${probe.agent.label} returned unexpected HTTP status ${probe.status}.`,
        agent: probe.agent.key,
        evidence: {
          actual: probe.status,
          expected: target.expectations.statuses.join(", "),
        },
      });
    }

    if (
      hasFinalResponse &&
      target.expectations.finalUrl !== undefined &&
      normalizeFinalUrl(probe.finalUrl) !== normalizeFinalUrl(target.expectations.finalUrl)
    ) {
      addFinding(findings, target.url, {
        code: "final-url-mismatch",
        severity: "error",
        message: `${probe.agent.label} finished at an unexpected URL.`,
        agent: probe.agent.key,
        evidence: {
          actual: probe.finalUrl,
          expected: target.expectations.finalUrl,
        },
      });
    }

    checkRequiredSignals(findings, target, probe);
    checkRepeatedMetadata(
      findings,
      target.url,
      probe,
      "title",
      probe.signals.titles ?? (probe.signals.title ? [probe.signals.title] : []),
    );
    checkRepeatedMetadata(findings, target.url, probe, "description", probe.signals.descriptions);
    checkRepeatedMetadata(findings, target.url, probe, "canonical", probe.signals.canonicals);
    checkRepeatedRobots(findings, target.url, probe);

    const invalidJsonLd = probe.signals.jsonLd.filter((signal) => signal.valid === false);
    if (probe.completion === "complete" && invalidJsonLd.length > 0) {
      addFinding(findings, target.url, {
        code: "invalid-json-ld",
        severity: "warning",
        message: `${probe.agent.label} received invalid JSON-LD.`,
        agent: probe.agent.key,
        evidence: {
          invalidBlocks: invalidJsonLd.length,
          errors: invalidJsonLd.map((signal) => signal.error ?? "invalid JSON").join(" | "),
        },
      });
    }

    const limitedJsonLd = probe.signals.jsonLd.filter(
      (signal) => signal.valid === undefined && signal.analysisLimit !== undefined,
    );
    if (limitedJsonLd.length > 0) {
      addFinding(findings, target.url, {
        code: "json-ld-analysis-limit",
        severity: "warning",
        message: `${probe.agent.label} exceeded an SSRWire JSON-LD analysis limit.`,
        agent: probe.agent.key,
        evidence: {
          blocks: limitedJsonLd.length,
          reasons: limitedJsonLd.map((signal) => signal.analysisLimit).join(" | "),
        },
      });
    }

    checkHeadRequirements(findings, target.url, probe);
    checkTimings(findings, target, probe);
  }

  checkAgentDrift(findings, target.url, probes);

  return findings;
}

export function summarizeAudit(results: readonly TargetAuditResult[]): AuditSummary {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  let probes = 0;
  let incomplete = 0;

  for (const result of results) {
    probes += result.probes.length;
    incomplete += result.probes.filter((probe) => probe.completion !== "complete").length;
    for (const finding of result.findings) {
      if (finding.severity === "error") {
        errors += 1;
      } else if (finding.severity === "warning") {
        warnings += 1;
      } else {
        info += 1;
      }
    }
  }

  return {
    targets: results.length,
    probes,
    errors,
    warnings,
    info,
    incomplete,
  };
}
