import { analyzeTarget, summarizeAudit } from "./analyze.js";
import { probeUrl } from "./http-probe.js";
import { redactAudit } from "./redact.js";
import type { AuditResult, ProbeOptions, SsrWireConfig, TargetAuditResult } from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_CONCURRENCY = 4;

interface ProbeTask {
  readonly targetIndex: number;
  readonly agentIndex: number;
  readonly options: ProbeOptions;
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

export async function runAudit(config: SsrWireConfig): Promise<AuditResult> {
  const started = performance.now();
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
  const probes = await runPool(tasks, DEFAULT_CONCURRENCY, async (task) => {
    const probe = await probeUrl(task.options);
    return { task, probe };
  });

  const results: TargetAuditResult[] = config.targets.map((target, targetIndex) => {
    const targetProbes = probes
      .filter((item) => item.task.targetIndex === targetIndex)
      .sort((a, b) => a.task.agentIndex - b.task.agentIndex)
      .map((item) => item.probe);

    return {
      target,
      probes: targetProbes,
      findings: analyzeTarget(target, targetProbes),
    };
  });

  const audit: AuditResult = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    results,
    summary: summarizeAudit(results),
  };
  return redactAudit(audit, secrets);
}
