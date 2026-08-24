import type {
  AgentStability,
  AuditResult,
  ElementSignal,
  Finding,
  ProbeResult,
  ReportFormat,
  Severity,
} from "./types.js";

export interface ReporterOptions {
  readonly color?: boolean;
}

const ANSI = {
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  blue: "\u001b[36m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  reset: "\u001b[0m",
} as const;

function paint(value: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${value}${ANSI.reset}` : value;
}

function severityColor(severity: Severity): string {
  if (severity === "error") {
    return ANSI.red;
  }
  if (severity === "warning") {
    return ANSI.yellow;
  }
  return ANSI.blue;
}

function terminalSafe(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    safe +=
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
        : character;
  }
  return safe;
}

function oneLine(value: string): string {
  return terminalSafe(value).replace(/\s+/g, " ").trim();
}

function truncate(value: string, length: number): string {
  const clean = oneLine(value);
  if (clean.length <= length) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, length - 1))}…`;
}

function formatMs(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value)} ms`;
}

function formatSignal(signal: ElementSignal | undefined): string {
  return signal === undefined ? "—" : `${Math.round(signal.atMs)} ms/${signal.location}`;
}

function firstSignal(signals: readonly ElementSignal[]): ElementSignal | undefined {
  return signals.find((signal) => signal.value.trim().length > 0) ?? signals[0];
}

function probeRow(probe: ProbeResult, showSample: boolean): readonly string[] {
  return [
    ...(showSample ? [String(probe.sample ?? "—")] : []),
    truncate(probe.agent.label, 24),
    probe.status === undefined ? "—" : String(probe.status),
    probe.completion,
    formatMs(probe.timings.firstByteMs),
    formatMs(probe.timings.completeMs),
    formatSignal(probe.signals.title),
    formatSignal(firstSignal(probe.signals.descriptions)),
    formatSignal(firstSignal(probe.signals.canonicals)),
    formatSignal(probe.signals.firstMainText),
  ];
}

function stabilityRows(stability: readonly AgentStability[]): readonly (readonly string[])[] {
  const labels: Readonly<Record<keyof AgentStability["timings"], string>> = {
    headers: "Headers",
    firstByte: "First byte",
    criticalSignals: "Critical signals",
    complete: "Complete",
  };
  const rows: string[][] = [];
  for (const summary of stability) {
    for (const key of ["headers", "firstByte", "criticalSignals", "complete"] as const) {
      const stats = summary.timings[key];
      if (stats === undefined) continue;
      rows.push([
        truncate(summary.agent.label, 24),
        `${summary.complete}/${summary.samples}`,
        labels[key],
        String(stats.samples),
        formatMs(stats.minMs),
        formatMs(stats.medianMs),
        formatMs(stats.p95Ms),
        formatMs(stats.maxMs),
        formatMs(stats.spreadMs),
      ]);
    }
  }
  return rows;
}

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join("  ")
      .trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [line(headers), separator, ...rows.map(line)].join("\n");
}

function formatFinding(finding: Finding, color: boolean): string {
  const severity = finding.severity.toUpperCase().padEnd(7);
  const prefix = paint(severity, severityColor(finding.severity), color);
  const agent = finding.agent === undefined ? "" : ` [${terminalSafe(finding.agent)}]`;
  const evidence =
    finding.evidence === undefined
      ? ""
      : ` (${Object.entries(finding.evidence)
          .map(([key, value]) => `${terminalSafe(key)}: ${terminalSafe(String(value))}`)
          .join(", ")})`;
  return `  ${prefix} ${terminalSafe(finding.code)}${agent}: ${terminalSafe(finding.message)}${evidence}`;
}

export function renderTerminal(audit: AuditResult, options: ReporterOptions = {}): string {
  const color = options.color ?? Boolean(process.stdout.isTTY);
  const lines: string[] = [
    paint(`SSRWire ${audit.version}`, ANSI.bold, color),
    paint(`Generated ${audit.generatedAt} in ${formatMs(audit.durationMs)}`, ANSI.dim, color),
  ];
  if ((audit.repeat ?? 1) > 1) {
    lines.push(paint(`${audit.repeat} sequential samples per URL and agent`, ANSI.dim, color));
  }

  for (const result of audit.results) {
    const showSample = (audit.repeat ?? 1) > 1;
    lines.push("", paint(terminalSafe(result.target.url), ANSI.bold, color));
    lines.push(
      renderTable(
        [
          ...(showSample ? ["Sample"] : []),
          "Agent",
          "HTTP",
          "Result",
          "First byte",
          "Complete",
          "Title",
          "Description",
          "Canonical",
          "Main",
        ],
        result.probes.map((probe) => probeRow(probe, showSample)),
      ),
    );

    if (result.stability !== undefined) {
      const rows = stabilityRows(result.stability);
      if (rows.length > 0) {
        lines.push(
          "",
          "Stability timings (nearest-rank p95)",
          renderTable(
            ["Agent", "Complete", "Metric", "N", "Min", "Median", "P95", "Max", "Spread"],
            rows,
          ),
        );
      }
    }

    if (result.findings.length === 0) {
      lines.push("Findings: none");
    } else {
      lines.push("Findings:", ...result.findings.map((finding) => formatFinding(finding, color)));
    }
  }

  const { summary } = audit;
  const summaryText =
    `Summary: ${summary.targets} target(s), ${summary.probes} probe(s), ` +
    `${summary.errors} error(s), ${summary.warnings} warning(s), ` +
    `${summary.info} info, ${summary.incomplete} incomplete`;
  const summaryColor =
    summary.errors > 0 ? ANSI.red : summary.warnings > 0 ? ANSI.yellow : ANSI.blue;
  lines.push("", paint(summaryText, summaryColor, color));

  return `${lines.join("\n")}\n`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function renderJson(audit: AuditResult): string {
  return stableJson(audit);
}

function sarifLevel(severity: Severity): "error" | "warning" | "note" {
  return severity === "info" ? "note" : severity;
}

function ruleDescription(code: string): string {
  const description = code.replaceAll("-", " ");
  return `${description.charAt(0).toUpperCase()}${description.slice(1)}`;
}

function artifactUri(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return encodeURI(url);
  }
}

export function renderSarif(audit: AuditResult): string {
  const findings = audit.results.flatMap((result) => result.findings);
  const codes = [...new Set(findings.map((finding) => finding.code))].sort();
  const rules = codes.map((code) => {
    const severities = findings
      .filter((finding) => finding.code === code)
      .map((finding) => finding.severity);
    const defaultSeverity: Severity = severities.includes("error")
      ? "error"
      : severities.includes("warning")
        ? "warning"
        : "info";
    return {
      id: code,
      name: code,
      shortDescription: { text: ruleDescription(code) },
      defaultConfiguration: { level: sarifLevel(defaultSeverity) },
    };
  });

  const results = findings.map((finding) => ({
    ruleId: finding.code,
    level: sarifLevel(finding.severity),
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: artifactUri(finding.url) },
        },
      },
    ],
    ...(finding.agent === undefined && finding.evidence === undefined
      ? {}
      : {
          properties: {
            ...(finding.agent === undefined ? {} : { agent: finding.agent }),
            ...(finding.evidence ?? {}),
          },
        }),
  }));

  return stableJson({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "SSRWire",
            version: audit.version,
            informationUri: "https://nikom.work",
            rules,
          },
        },
        results,
      },
    ],
  });
}

export function renderReport(
  audit: AuditResult,
  format: ReportFormat,
  options: ReporterOptions = {},
): string {
  if (format === "terminal") {
    return renderTerminal(audit, options);
  }
  if (format === "json") {
    return renderJson(audit);
  }
  if (format === "sarif") {
    return renderSarif(audit);
  }

  const exhaustive: never = format;
  return exhaustive;
}
