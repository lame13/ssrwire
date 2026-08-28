import type { AuditResult, DocumentSignals, ElementSignal, ProbeResult } from "./types.js";

const REDACTED = "[REDACTED]";

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function addForms(candidates: Set<string>, value: string): void {
  if (!value) return;
  candidates.add(value);
  candidates.add(encodeURIComponent(value));
  candidates.add(new URLSearchParams({ value }).toString().slice("value=".length));
  candidates.add(Buffer.from(value).toString("base64"));
  candidates.add(base64Url(value));
}

function decodedBasicCredential(value: string): string | undefined {
  const encoded = value.match(/^basic\s+([a-z0-9+/]+={0,2})$/i)?.[1];
  if (!encoded || encoded.length % 4 === 1) return undefined;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  return decoded.includes("\uFFFD") || decoded.length === 0 ? undefined : decoded;
}

function variants(value: string): readonly string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  const candidates = new Set<string>();
  addForms(candidates, trimmed);
  const scheme = trimmed.match(/^(?:basic|bearer)\s+(.+)$/i)?.[1];
  if (scheme) addForms(candidates, scheme);
  const decodedBasic = decodedBasicCredential(trimmed);
  if (decodedBasic) addForms(candidates, decodedBasic);

  return [...candidates];
}

export interface RedactionPlan {
  readonly exact: ReadonlySet<string>;
  readonly substrings: readonly string[];
}

export function createRedactionPlan(secrets: readonly string[]): RedactionPlan {
  const exact = new Set(secrets.flatMap(variants));
  return {
    exact,
    substrings: [...exact]
      .filter((candidate) => candidate.length >= 3)
      .sort((a, b) => b.length - a.length),
  };
}

export function redactText(value: string, plan: RedactionPlan): string {
  if (plan.exact.has(value)) return REDACTED;
  let redacted = value;
  for (const pattern of plan.substrings) {
    redacted = redacted.split(pattern).join(REDACTED);
  }
  return redacted;
}

function redactUnknown(value: unknown, plan: RedactionPlan): unknown {
  if (typeof value === "string") {
    return redactText(value, plan);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, plan));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactUnknown(item, plan)]),
    );
  }
  return value;
}

function redactElement<Signal extends ElementSignal>(signal: Signal, plan: RedactionPlan): Signal {
  return { ...signal, value: redactText(signal.value, plan) };
}

function redactSignals(signals: DocumentSignals, plan: RedactionPlan): DocumentSignals {
  return {
    ...(signals.title === undefined ? {} : { title: redactElement(signals.title, plan) }),
    ...(signals.titles === undefined
      ? {}
      : { titles: signals.titles.map((signal) => redactElement(signal, plan)) }),
    descriptions: signals.descriptions.map((signal) => redactElement(signal, plan)),
    canonicals: signals.canonicals.map((signal) => redactElement(signal, plan)),
    robots: signals.robots.map((signal) => redactElement(signal, plan)),
    ...(signals.socialMetadata === undefined
      ? {}
      : {
          socialMetadata: signals.socialMetadata.map((signal) => redactElement(signal, plan)),
        }),
    h1s: signals.h1s.map((signal) => redactElement(signal, plan)),
    ...(signals.firstMainText === undefined
      ? {}
      : { firstMainText: redactElement(signals.firstMainText, plan) }),
    jsonLd: signals.jsonLd.map((signal) => ({
      ...signal,
      types: signal.types.map((type) => redactText(type, plan)),
      ...(signal.error === undefined ? {} : { error: redactText(signal.error, plan) }),
    })),
    ...(signals.headClosed === undefined ? {} : { headClosed: signals.headClosed }),
    ...(signals.bodyStarted === undefined ? {} : { bodyStarted: signals.bodyStarted }),
    ...(signals.documentClosed === undefined ? {} : { documentClosed: signals.documentClosed }),
  };
}

function redactProbeWithPlan(probe: ProbeResult, plan: RedactionPlan): ProbeResult {
  return {
    ...probe,
    requestedUrl: redactText(probe.requestedUrl, plan),
    finalUrl: redactText(probe.finalUrl, plan),
    agent: {
      ...probe.agent,
      label: redactText(probe.agent.label, plan),
      userAgent: redactText(probe.agent.userAgent, plan),
    },
    redirects: probe.redirects.map((redirect) => ({
      ...redirect,
      url: redactText(redirect.url, plan),
      location: redactText(redirect.location, plan),
    })),
    headers: {
      ...probe.headers,
      values: Object.fromEntries(
        Object.entries(probe.headers.values).map(([name, value]) => [
          name,
          redactText(value, plan),
        ]),
      ),
    },
    signals: redactSignals(probe.signals, plan),
    ...(probe.error === undefined ? {} : { error: redactText(probe.error, plan) }),
  };
}

export function redactProbe(probe: ProbeResult, secrets: readonly string[]): ProbeResult {
  const plan = createRedactionPlan(secrets);
  if (plan.exact.size === 0) {
    return probe;
  }

  return redactProbeWithPlan(probe, plan);
}

export function redactAudit(audit: AuditResult, secrets: readonly string[]): AuditResult {
  const plan = createRedactionPlan(secrets);
  if (plan.exact.size === 0) return audit;
  return {
    ...audit,
    results: audit.results.map((result) => ({
      target: {
        ...result.target,
        url: redactText(result.target.url, plan),
        expectations: {
          ...result.target.expectations,
          ...(result.target.expectations.finalUrl === undefined
            ? {}
            : { finalUrl: redactText(result.target.expectations.finalUrl, plan) }),
        },
      },
      probes: result.probes.map((probe) => redactProbeWithPlan(probe, plan)),
      ...(result.stability === undefined
        ? {}
        : {
            stability: result.stability.map((summary) => ({
              ...summary,
              agent: {
                ...summary.agent,
                label: redactText(summary.agent.label, plan),
                userAgent: redactText(summary.agent.userAgent, plan),
              },
            })),
          }),
      findings: result.findings.map((finding) => ({
        ...finding,
        message: redactText(finding.message, plan),
        url: redactText(finding.url, plan),
        ...(finding.evidence === undefined
          ? {}
          : { evidence: redactUnknown(finding.evidence, plan) as typeof finding.evidence }),
      })),
    })),
  };
}
