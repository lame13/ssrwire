import { targetVerdict } from "./explain.js";
import type { AuditComparison, AuditResult, Finding, ProbeResult, Severity } from "./types.js";

function markdownCell(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[\\`*_[\]{}()#!|]/gu, "\\$&")
    .replace(/\s+/gu, " ")
    .trim();
}

function xmlEscape(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        code >= 0x10000
      );
    })
    .join("")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

/** GitHub workflow-command escaping for the message body. */
function ghData(value: string): string {
  return value.replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
}

/** GitHub workflow-command escaping for property values, which also reserve ':' and ','. */
function ghProperty(value: string): string {
  return ghData(value).replace(/:/gu, "%3A").replace(/,/gu, "%2C");
}

function ms(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value)} ms`;
}

function agentLabel(probe: ProbeResult, showSample: boolean): string {
  return showSample ? `${probe.agent.label} #${probe.sample ?? 1}` : probe.agent.label;
}

function signalCell(
  signal: { readonly atMs: number; readonly location: string } | undefined,
): string {
  return signal === undefined ? "—" : `${Math.round(signal.atMs)} ms/${signal.location}`;
}

/**
 * A pull-request-ready digest. Findings are ordered by severity so the first lines of a collapsed
 * comment already say whether the run needs attention.
 */
export function renderMarkdown(audit: AuditResult): string {
  const { summary } = audit;
  const lines: string[] = [
    `## SSRWire ${audit.version} audit`,
    "",
    `${summary.targets} target(s) · ${summary.probes} probe(s) · ${summary.errors} error(s) · ` +
      `${summary.warnings} warning(s) · ${summary.info} info · ${summary.incomplete} incomplete` +
      (summary.waived === undefined || summary.waived === 0 ? "" : ` · ${summary.waived} waived`),
  ];

  const order: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

  for (const result of audit.results) {
    const verdict = targetVerdict(result);
    const showSample = (audit.repeat ?? 1) > 1;
    lines.push(
      "",
      `### ${markdownCell(result.target.url)}`,
      "",
      markdownCell(verdict.headline),
      "",
    );
    lines.push(
      [
        "| Agent | HTTP | Result | First byte | Complete | Title | Description | Canonical | Main |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...result.probes.map((probe) =>
          [
            agentLabel(probe, showSample),
            probe.status === undefined ? "—" : String(probe.status),
            probe.completion,
            ms(probe.timings.firstByteMs),
            ms(probe.timings.completeMs),
            signalCell(probe.signals.title),
            signalCell(probe.signals.descriptions[0]),
            signalCell(probe.signals.canonicals[0]),
            signalCell(probe.signals.firstMainText),
          ]
            .map((cell) => markdownCell(String(cell)))
            .join(" | "),
        ),
      ]
        .map((row) => (row.startsWith("|") ? row : `| ${row} |`))
        .join("\n"),
    );

    const findings = [...result.findings].sort(
      (left, right) => order[left.severity] - order[right.severity],
    );
    if (findings.length === 0) {
      lines.push("", "No findings.");
      continue;
    }
    lines.push("", `**Findings (${findings.length})**`, "");
    for (const finding of findings) {
      const agent = finding.agent === undefined ? "" : ` ${markdownCell(finding.agent)}`;
      const evidence =
        finding.evidence === undefined
          ? ""
          : ` — ${Object.entries(finding.evidence)
              .map(([key, value]) => markdownCell(`${key}=${String(value)}`))
              .join(", ")}`;
      lines.push(
        `- **${finding.severity.toUpperCase()}** ${markdownCell(finding.code)}${agent} ${markdownCell(
          finding.message,
        )}${evidence}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function seconds(value: number | undefined): string {
  return ((value ?? 0) / 1000).toFixed(3);
}

function appliesToSample(finding: Finding, probe: ProbeResult): boolean {
  const evidence: { readonly sampleNumbers?: string | number | boolean } = finding.evidence ?? {};
  return (
    probe.sample === undefined ||
    evidence.sampleNumbers === undefined ||
    String(evidence.sampleNumbers).split(",").map(Number).includes(probe.sample)
  );
}

function junitElements(findings: readonly Finding[]): string {
  const primary = findings.find((finding) => finding.severity === "error") ?? findings[0];
  if (primary === undefined) return "";
  const tag = primary.severity === "error" ? "error" : "failure";
  const body = findings
    .map((finding) =>
      [
        `${finding.code}: ${finding.message}`,
        finding.agent === undefined ? undefined : `agent: ${finding.agent}`,
        finding.evidence === undefined
          ? undefined
          : `evidence: ${JSON.stringify(finding.evidence)}`,
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
    )
    .join("\n\n");
  return `      <${tag} type="${xmlEscape(primary.code)}" message="${xmlEscape(primary.message)}">${xmlEscape(body)}</${tag}>`;
}

function probeCase(
  url: string,
  name: string,
  timeMs: number | undefined,
  findings: readonly Finding[],
): string {
  const attributes = `classname="${xmlEscape(url)}" name="${xmlEscape(name)}" time="${seconds(
    timeMs,
  )}"`;
  if (findings.length === 0) {
    return `    <testcase ${attributes}/>`;
  }
  return `    <testcase ${attributes}>\n${junitElements(findings)}\n    </testcase>`;
}

/**
 * JUnit XML so CI systems that only understand test reports still surface SSRWire findings.
 * Errors map to `<error>`, warnings to `<failure>`, and informational findings are reported in
 * the suite output rather than failing a build.
 */
export function renderJunit(audit: AuditResult): string {
  const suites: string[] = [];
  let totalTests = 0;
  let totalFailures = 0;
  let totalErrors = 0;

  for (const result of audit.results) {
    const cases = result.probes.map((probe) => {
      const findings = result.findings.filter(
        (finding) =>
          finding.agent === probe.agent.key &&
          appliesToSample(finding, probe) &&
          (finding.severity === "error" || finding.severity === "warning"),
      );
      return {
        name: probe.sample === undefined ? probe.agent.key : `${probe.agent.key}#${probe.sample}`,
        timeMs: probe.timings.completeMs ?? probe.timings.firstByteMs,
        findings,
      };
    });
    const targetFindings = result.findings.filter(
      (finding) => finding.agent === undefined && finding.severity !== "info",
    );
    if (targetFindings.length > 0)
      cases.push({ name: "target", timeMs: undefined, findings: targetFindings });

    const errors = cases.filter((item) => item.findings.some((f) => f.severity === "error")).length;
    const failures = cases.filter(
      (item) => item.findings.length > 0 && !item.findings.some((f) => f.severity === "error"),
    ).length;
    totalTests += cases.length;
    totalFailures += failures;
    totalErrors += errors;

    const info = result.findings.filter((finding) => finding.severity === "info");
    const body = [
      ...cases.map((item) => probeCase(result.target.url, item.name, item.timeMs, item.findings)),
      ...(info.length === 0
        ? []
        : [
            `    <system-out>${xmlEscape(
              info.map((finding) => `${finding.code}: ${finding.message}`).join("\n"),
            )}</system-out>`,
          ]),
    ].join("\n");

    const attributes =
      `name="${xmlEscape(result.target.url)}" tests="${cases.length}" ` +
      `failures="${failures}" errors="${errors}" skipped="0"`;
    suites.push(`  <testsuite ${attributes}>\n${body}\n  </testsuite>`);
  }

  const { summary } = audit;
  const properties = [
    ["ssrwire.version", audit.version],
    ["ssrwire.schemaVersion", String(audit.schemaVersion)],
    ["ssrwire.waived", String(summary.waived ?? 0)],
    ["ssrwire.incomplete", String(summary.incomplete)],
  ]
    .map(
      ([name, value]) =>
        `    <property name="${xmlEscape(name ?? "")}" value="${xmlEscape(value ?? "")}"/>`,
    )
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="SSRWire" tests="${totalTests}" failures="${totalFailures}" ` +
    `errors="${totalErrors}" skipped="0">\n` +
    `  <properties>\n${properties}\n  </properties>\n` +
    (suites.length === 0 ? "" : `${suites.join("\n")}\n`) +
    "</testsuites>\n"
  );
}

function annotation(finding: Finding): string {
  const command =
    finding.severity === "error" ? "error" : finding.severity === "warning" ? "warning" : "notice";
  const agent = finding.agent === undefined ? "" : ` (${finding.agent})`;
  const message = ghData(`${finding.url}${agent}: ${finding.message}`);
  return `::${command} title=${ghProperty(`SSRWire: ${finding.code}`)}::${message}`;
}

/**
 * GitHub Actions workflow commands for annotations in the workflow run.
 */
export function renderGithub(audit: AuditResult): string {
  const lines = audit.results
    .flatMap((result) => result.findings)
    .map((finding) => annotation(finding));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function renderComparisonMarkdown(comparison: AuditComparison): string {
  const { summary } = comparison;
  const lines: string[] = [
    `## SSRWire ${comparison.version} deployment comparison`,
    "",
    `**${summary.regressions} regression(s)**, ${summary.fixed} fixed, ${summary.changed} changed · ` +
      `${summary.matchedTargets} matched, ${summary.addedTargets} added, ` +
      `${summary.removedTargets} removed`,
    "",
    `Baseline ${markdownCell(comparison.baseline.label)} (${markdownCell(comparison.baseline.generatedAt)}) → ` +
      `candidate ${markdownCell(comparison.candidate.label)} (${markdownCell(comparison.candidate.generatedAt)})`,
  ];

  for (const result of comparison.results) {
    lines.push("", `### ${markdownCell(result.key)}`, "");
    if (result.changes.length === 0) {
      lines.push("No changes.");
      continue;
    }
    lines.push("| Kind | Scope | Code | Agent | Change |", "| --- | --- | --- | --- | --- |");
    for (const change of result.changes) {
      lines.push(
        `| ${change.kind} | ${change.scope} | ${markdownCell(change.code)} | ${markdownCell(change.agent ?? "—")} | ` +
          `${markdownCell(change.message)} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderComparisonGithub(comparison: AuditComparison): string {
  const lines: string[] = [];
  for (const result of comparison.results) {
    for (const change of result.changes) {
      if (change.kind !== "regression") {
        continue;
      }
      const agent = change.agent === undefined ? "" : ` (${change.agent})`;
      lines.push(
        `::error title=${ghProperty(`SSRWire: ${change.code}`)}::${ghData(
          `${result.key}${agent}: ${change.message}`,
        )}`,
      );
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
