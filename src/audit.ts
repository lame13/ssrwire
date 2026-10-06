import { analyzeTarget, summarizeAudit } from "./analyze.js";
import { AUDIT_SCHEMA_VERSION } from "./audit-report.js";
import { probeUrl } from "./http-probe.js";
import { redactAudit } from "./redact.js";
import { collectRobotsTxt, robotsEvidenceFor } from "./robots-txt.js";
import { analyzeStability } from "./stability.js";
import type {
  AuditResult,
  AuditTarget,
  Finding,
  ProbeOptions,
  ProbeResult,
  SsrWireConfig,
  TargetAuditResult,
} from "./types.js";
import { VERSION } from "./version.js";
import { applyWaivers } from "./waivers.js";

export const DEFAULT_CONCURRENCY = 4;

interface ProbeTask {
  readonly targetIndex: number;
  readonly agentIndex: number;
  readonly options: ProbeOptions;
}

interface ProbeLane {
  readonly task: ProbeTask;
  readonly probes: readonly ProbeResult[];
}

interface SampleFinding {
  readonly sample: number;
  readonly finding: Finding;
}

async function runPool<T, R>(
  inputs: readonly T[],
  limit: number,
  worker: (input: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(inputs.length);
  let cursor = 0;

  async function consume(): Promise<void> {
    while (cursor < inputs.length) {
      const index = cursor;
      cursor += 1;
      const input = inputs[index];
      if (input === undefined) {
        continue;
      }
      results[index] = await worker(input);
    }
  }

  const workers = Array.from({ length: Math.min(limit, inputs.length) }, () => consume());
  await Promise.all(workers);
  return results;
}

function repeatCount(value: number | undefined): number {
  const repeat = value ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
    throw new RangeError("repeat must be an integer between 1 and 10.");
  }
  return repeat;
}

function concurrencyCount(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new RangeError("concurrency must be an integer between 1 and 16.");
  }
  return concurrency;
}

function mergeEvidence(
  sampled: readonly SampleFinding[],
  repeat: number,
): Readonly<Record<string, string | number | boolean>> {
  const merged: Record<string, string | number | boolean> & {
    occurrences?: number;
    sampleNumbers?: string;
    totalSamples?: number;
  } = {};
  const keys = [
    ...new Set(sampled.flatMap(({ finding }) => Object.keys(finding.evidence ?? {}))),
  ].sort();

  for (const key of keys) {
    const values = sampled.flatMap(({ finding }) => {
      const value = finding.evidence?.[key];
      return value === undefined ? [] : [value];
    });
    const unique = [
      ...new Map(values.map((value) => [`${typeof value}:${String(value)}`, value])).values(),
    ];
    const first = unique[0];
    if (first !== undefined) {
      merged[key] = unique.length === 1 ? first : unique.map(String).join(" | ");
    }
  }

  merged.sampleNumbers = [...new Set(sampled.map((item) => item.sample))]
    .sort((a, b) => a - b)
    .join(", ");
  merged.occurrences = sampled.length;
  merged.totalSamples = repeat;
  return merged;
}

function coalesceFindings(sampled: readonly SampleFinding[], repeat: number): readonly Finding[] {
  const groups = new Map<string, SampleFinding[]>();
  for (const item of sampled) {
    const { finding } = item;
    const key = JSON.stringify([
      finding.code,
      finding.severity,
      finding.message,
      finding.url,
      finding.agent ?? "",
    ]);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const first = group[0]?.finding;
    if (first === undefined) throw new Error("Cannot coalesce an empty finding group.");
    return { ...first, evidence: mergeEvidence(group, repeat) };
  });
}

export async function runAudit(config: SsrWireConfig): Promise<AuditResult> {
  const started = performance.now();
  const repeat = repeatCount(config.repeat);
  const concurrency = concurrencyCount(config.concurrency);
  const tasks: ProbeTask[] = [];

  for (const [targetIndex, target] of config.targets.entries()) {
    for (const [agentIndex, agent] of config.agents.entries()) {
      tasks.push({
        targetIndex,
        agentIndex,
        options: {
          url: target.url,
          agent,
          headers: config.headers,
          timeoutMs: config.timeoutMs,
          maxBytes: config.maxBytes,
          maxRedirects: config.maxRedirects,
          redactHeaderValues: false,
        },
      });
    }
  }

  const secrets = Object.values(config.headers);

  // robots.txt is fetched once per origin with SSRWire's own identity; per-agent verdicts are
  // matched locally against the parsed rules using each profile's user agent string.
  const robots = await collectRobotsTxt(
    config.targets.map((target) => new URL(target.url).origin),
    { timeoutMs: Math.min(config.timeoutMs, 10_000), maxBytes: Math.min(config.maxBytes, 524_288) },
    concurrency,
  );
  const withRobots = (probe: ProbeResult, target: AuditTarget): ProbeResult => {
    const evidence = robotsEvidenceFor(
      robots.get(new URL(target.url).origin),
      probe.agent.userAgent,
      target.url,
    );
    return evidence === undefined ? probe : { ...probe, robotsTxt: evidence };
  };

  const lanes = await runPool<ProbeTask, ProbeLane>(tasks, concurrency, async (task) => {
    const probes: ProbeResult[] = [];
    for (let sample = 1; sample <= repeat; sample += 1) {
      const probe = await probeUrl(task.options);
      probes.push(repeat === 1 ? probe : { ...probe, sample });
    }
    return { task, probes };
  });

  const results: TargetAuditResult[] = config.targets.map((target, targetIndex) => {
    const targetProbes = lanes
      .filter((lane) => lane.task.targetIndex === targetIndex)
      .sort((a, b) => a.task.agentIndex - b.task.agentIndex)
      .flatMap((lane) => lane.probes)
      .map((probe) => withRobots(probe, target));

    if (repeat === 1) {
      return {
        target,
        probes: targetProbes,
        findings: analyzeTarget(target, targetProbes),
      };
    }

    const sampledFindings: SampleFinding[] = [];
    for (let sample = 1; sample <= repeat; sample += 1) {
      const sampleProbes = targetProbes.filter((probe) => probe.sample === sample);
      sampledFindings.push(
        ...analyzeTarget(target, sampleProbes).map((finding) => ({ sample, finding })),
      );
    }
    const stability = analyzeStability(target, targetProbes);

    return {
      target,
      probes: targetProbes,
      findings: [...coalesceFindings(sampledFindings, repeat), ...stability.findings],
      stability: stability.stability,
    };
  });

  const waivers = config.waivers ?? [];
  const waived = applyWaivers(results, waivers);
  const audit: AuditResult = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    version: VERSION,
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    ...(repeat === 1 ? {} : { repeat }),
    results: waived.results,
    summary: summarizeAudit(waived.results, waived.waived),
    ...(waivers.length === 0 ? {} : { waivers }),
  };
  return redactAudit(audit, secrets);
}
