import type {
  AuditComparison,
  ComparisonChange,
  ComparisonKind,
  ComparisonReportFormat,
  ComparisonTimelineEvent,
  ComparisonTimelineSnapshot,
  TargetComparison,
} from "./types.js";

export interface ComparisonReporterOptions {
  readonly color?: boolean;
}

const ANSI = {
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[36m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  reset: "\u001b[0m",
} as const;

const EVENT_SHORT_LABELS: Readonly<Record<string, string>> = {
  headers: "H",
  "first-byte": "B",
  title: "T",
  description: "D",
  canonical: "C",
  "open-graph": "OG",
  "twitter-card": "X",
  required: "R",
  main: "M",
  complete: "✓",
};

function paint(value: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${value}${ANSI.reset}` : value;
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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
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

function kindLabel(kind: ComparisonKind): string {
  if (kind === "regression") return "REGRESS";
  if (kind === "fixed") return "FIXED";
  return "CHANGED";
}

function kindColor(kind: ComparisonKind): string {
  if (kind === "regression") return ANSI.red;
  if (kind === "fixed") return ANSI.green;
  return ANSI.blue;
}

function formatChange(change: ComparisonChange, color: boolean): string {
  const label = paint(kindLabel(change.kind).padEnd(7), kindColor(change.kind), color);
  const qualifiers = [change.agent, change.field].filter(
    (value): value is string => value !== undefined,
  );
  const context = qualifiers.length === 0 ? "" : ` [${qualifiers.map(terminalSafe).join("/")}]`;
  const values =
    change.baseline === undefined && change.candidate === undefined
      ? ""
      : ` (${terminalSafe(String(change.baseline ?? "—"))} → ${terminalSafe(String(change.candidate ?? "—"))})`;
  return `  ${label} ${terminalSafe(change.code)}${context}: ${terminalSafe(change.message)}${values}`;
}

export function renderComparisonTerminal(
  comparison: AuditComparison,
  options: ComparisonReporterOptions = {},
): string {
  const color = options.color ?? Boolean(process.stdout.isTTY);
  const lines = [
    paint(`SSRWire ${comparison.version} comparison`, ANSI.bold, color),
    `${paint("Baseline", ANSI.dim, color)}: ${terminalSafe(comparison.baseline.label)} · SSRWire ${terminalSafe(comparison.baseline.version)} · ${terminalSafe(comparison.baseline.generatedAt)}`,
    `${paint("Candidate", ANSI.dim, color)}: ${terminalSafe(comparison.candidate.label)} · SSRWire ${terminalSafe(comparison.candidate.version)} · ${terminalSafe(comparison.candidate.generatedAt)}`,
    paint(
      `Timing regression requires >${comparison.thresholds.timingRegressionMs} ms and >${comparison.thresholds.timingRegressionPercent}% median increase`,
      ANSI.dim,
      color,
    ),
  ];

  for (const result of comparison.results) {
    lines.push("", paint(terminalSafe(result.key), ANSI.bold, color));
    if (result.baselineUrl !== undefined) {
      lines.push(`  Baseline:  ${terminalSafe(result.baselineUrl)}`);
    }
    if (result.candidateUrl !== undefined) {
      lines.push(`  Candidate: ${terminalSafe(result.candidateUrl)}`);
    }
    if (result.changes.length === 0) {
      lines.push(paint("  No differences", ANSI.dim, color));
    } else {
      lines.push(...result.changes.map((change) => formatChange(change, color)));
    }
  }

  const { summary } = comparison;
  const summaryText =
    `Summary: ${summary.matchedTargets} matched, ${summary.addedTargets} added, ` +
    `${summary.removedTargets} removed, ${summary.unchangedTargets} unchanged; ` +
    `${summary.regressions} regression(s), ${summary.fixed} fixed, ${summary.changed} changed`;
  const summaryColor = summary.regressions > 0 ? ANSI.red : ANSI.green;
  lines.push("", paint(summaryText, summaryColor, color));
  return `${lines.join("\n")}\n`;
}

export function renderComparisonJson(comparison: AuditComparison): string {
  return stableJson(comparison);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMs(value: number): string {
  return `${Math.round(value)} ms`;
}

function maxTimelineMs(result: TargetComparison): number {
  return Math.max(
    1,
    ...result.timelines.flatMap((lane) => [
      ...(lane.baseline?.events.map((event) => event.medianMs) ?? []),
      ...(lane.candidate?.events.map((event) => event.medianMs) ?? []),
    ]),
  );
}

function eventTitle(event: ComparisonTimelineEvent): string {
  const details = [event.label, formatMs(event.medianMs)];
  if (event.location !== undefined) details.push(event.location);
  if (event.observedByByte !== undefined) {
    details.push(`by byte ${Math.round(event.observedByByte)}`);
  }
  return details.join(" · ");
}

function renderTimelineSnapshot(
  side: string,
  snapshot: ComparisonTimelineSnapshot | undefined,
  maxMs: number,
): string {
  if (snapshot === undefined) {
    return `<div class="timeline-row"><div class="side">${escapeHtml(side)}</div><div class="missing">not present</div></div>`;
  }
  const events = snapshot.events
    .map((event, index) => {
      const position = Math.max(0, Math.min(100, (event.medianMs / maxMs) * 100));
      const short = EVENT_SHORT_LABELS[event.key] ?? event.key.slice(0, 2).toUpperCase();
      const title = escapeHtml(eventTitle(event));
      return `<span class="event" style="--position:${position.toFixed(3)}%;--level:${index % 2}" title="${title}" aria-label="${title}" tabindex="0"><span>${escapeHtml(short)}</span></span>`;
    })
    .join("");
  return `<div class="timeline-row"><div class="side">${escapeHtml(side)} <small>n=${snapshot.samples}</small></div><div class="track">${events}</div></div>`;
}

function renderTimelines(result: TargetComparison): string {
  if (result.timelines.length === 0) return "";
  const maxMs = maxTimelineMs(result);
  const lanes = result.timelines
    .map(
      (lane) => `<section class="agent-lane">
        <h4>${escapeHtml(lane.label)} <code>${escapeHtml(lane.agent)}</code></h4>
        ${renderTimelineSnapshot("Baseline", lane.baseline, maxMs)}
        ${renderTimelineSnapshot("Candidate", lane.candidate, maxMs)}
      </section>`,
    )
    .join("");
  return `<details class="waterfall" open><summary>Wire waterfall <span>0–${escapeHtml(formatMs(maxMs))}</span></summary>${lanes}</details>`;
}

function renderChange(change: ComparisonChange): string {
  const context = [change.agent, change.field]
    .filter((value): value is string => value !== undefined)
    .map((value) => `<code>${escapeHtml(value)}</code>`)
    .join(" ");
  const values =
    change.baseline === undefined && change.candidate === undefined
      ? ""
      : `<dl><div><dt>Baseline</dt><dd>${escapeHtml(String(change.baseline ?? "—"))}</dd></div><div><dt>Candidate</dt><dd>${escapeHtml(String(change.candidate ?? "—"))}</dd></div></dl>`;
  return `<article class="change ${change.kind}">
    <div class="change-heading"><span>${escapeHtml(kindLabel(change.kind))}</span><strong>${escapeHtml(change.code)}</strong>${context}</div>
    <p>${escapeHtml(change.message)}</p>${values}
  </article>`;
}

function renderTarget(result: TargetComparison): string {
  const urls = [
    result.baselineUrl === undefined
      ? ""
      : `<div><span>Baseline</span>${escapeHtml(result.baselineUrl)}</div>`,
    result.candidateUrl === undefined
      ? ""
      : `<div><span>Candidate</span>${escapeHtml(result.candidateUrl)}</div>`,
  ].join("");
  const changes =
    result.changes.length === 0
      ? '<p class="clean">No differences detected.</p>'
      : `<div class="changes">${result.changes.map(renderChange).join("")}</div>`;
  return `<section class="target">
    <header><div><span class="target-status">${escapeHtml(result.status)}</span><h2>${escapeHtml(result.key)}</h2></div><div class="urls">${urls}</div></header>
    ${renderTimelines(result)}${changes}
  </section>`;
}

export function renderComparisonHtml(comparison: AuditComparison): string {
  const { summary } = comparison;
  const outcome = summary.regressions > 0 ? "Regressions detected" : "No regressions";
  const targets = comparison.results.map(renderTarget).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>SSRWire comparison · ${escapeHtml(outcome)}</title>
  <style>
    :root{color-scheme:light dark;--bg:#f5f2eb;--panel:#fffdf8;--ink:#191c1b;--muted:#656c68;--line:#d8d5cc;--red:#b42318;--red-bg:#fff0ed;--green:#18794e;--green-bg:#ebf8f1;--blue:#1769aa;--blue-bg:#edf6ff;--track:#e3e7e4}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:48px 0 80px}.hero{display:grid;grid-template-columns:1fr auto;gap:32px;align-items:end;margin-bottom:28px}.eyebrow,.target-status{color:var(--muted);font-size:12px;font-weight:750;letter-spacing:.1em;text-transform:uppercase}h1{font-size:clamp(34px,6vw,64px);line-height:1;margin:.18em 0}.hero p{color:var(--muted);margin:0}.outcome{border:1px solid var(--line);border-radius:18px;background:var(--panel);padding:18px 22px;min-width:260px}.outcome strong{display:block;font-size:22px}.outcome.bad strong{color:var(--red)}.counts{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}.counts div{border-radius:10px;padding:8px;background:var(--bg)}.counts b{display:block;font-size:20px}.counts span{color:var(--muted);font-size:12px}.sources{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:28px}.source,.target{background:var(--panel);border:1px solid var(--line);border-radius:18px}.source{padding:16px 18px}.source span,.urls span{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.source strong{display:block;font-size:17px}.source small{color:var(--muted)}.threshold{color:var(--muted);font-size:13px;margin:-14px 0 28px}.target{overflow:hidden;margin:18px 0}.target>header{display:grid;grid-template-columns:minmax(180px,.55fr) 1fr;gap:24px;padding:22px 24px;border-bottom:1px solid var(--line)}.target h2{font-size:23px;margin:3px 0 0;overflow-wrap:anywhere}.urls{display:grid;gap:8px;overflow-wrap:anywhere}.waterfall{padding:18px 24px;border-bottom:1px solid var(--line)}.waterfall summary{cursor:pointer;font-weight:700}.waterfall summary span{color:var(--muted);font-weight:400;margin-left:8px}.agent-lane{margin:18px 0}.agent-lane h4{margin:0 0 8px}.agent-lane code,.change-heading code{color:var(--muted);font-size:12px}.timeline-row{display:grid;grid-template-columns:126px 1fr;align-items:center;margin:5px 0}.side{color:var(--muted);font-size:13px}.side small{opacity:.75}.track{position:relative;height:48px;border-radius:8px;background:linear-gradient(90deg,var(--track),transparent 1px) 0 0/10% 100%,color-mix(in srgb,var(--track) 55%,transparent)}.event{position:absolute;left:var(--position);top:calc(5px + var(--level)*20px);transform:translateX(-50%);cursor:help}.event:focus-visible{outline:2px solid var(--blue);outline-offset:2px}.event:before{content:"";position:absolute;left:50%;top:-5px;height:42px;border-left:1px solid color-mix(in srgb,var(--ink) 22%,transparent);z-index:0}.event span{position:relative;display:block;min-width:20px;padding:1px 4px;border:1px solid var(--line);border-radius:5px;background:var(--panel);font-size:10px;font-weight:800;text-align:center;z-index:1}.missing{color:var(--muted);font-size:13px}.changes{display:grid;gap:10px;padding:18px 24px 24px}.change{border-left:4px solid var(--blue);border-radius:8px;background:var(--blue-bg);padding:12px 14px}.change.regression{border-color:var(--red);background:var(--red-bg)}.change.fixed{border-color:var(--green);background:var(--green-bg)}.change-heading{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.change-heading>span{font-size:11px;font-weight:850;letter-spacing:.08em}.change p{margin:5px 0 0}.change dl{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0 0}.change dl div{min-width:0;padding:7px 9px;border-radius:6px;background:color-mix(in srgb,var(--panel) 70%,transparent)}dt{color:var(--muted);font-size:11px;text-transform:uppercase}dd{margin:1px 0 0;overflow-wrap:anywhere}.clean{color:var(--green);font-weight:700;padding:18px 24px;margin:0}.legend{color:var(--muted);font-size:12px;margin-top:30px}.legend code{color:var(--ink)}@media(max-width:720px){main{width:min(100% - 20px,1180px);padding-top:24px}.hero,.sources,.target>header{grid-template-columns:1fr}.outcome{min-width:0}.timeline-row{grid-template-columns:1fr}.side{margin-bottom:3px}.change dl{grid-template-columns:1fr}}
    @media(prefers-color-scheme:dark){:root{--bg:#151817;--panel:#1d211f;--ink:#f0f3f1;--muted:#aab2ad;--line:#363d39;--red:#ff8a80;--red-bg:#321d1a;--green:#73d6a6;--green-bg:#173125;--blue:#75bfff;--blue-bg:#172a3a;--track:#323a36}}
  </style>
</head>
<body><main>
  <section class="hero"><div><div class="eyebrow">SSRWire ${escapeHtml(comparison.version)} · deployment diff</div><h1>${escapeHtml(outcome)}</h1><p>Generated ${escapeHtml(comparison.generatedAt)}</p></div><aside class="outcome ${summary.regressions > 0 ? "bad" : "good"}"><strong>${summary.regressions} regression${summary.regressions === 1 ? "" : "s"}</strong><div class="counts"><div><b>${summary.fixed}</b><span>fixed</span></div><div><b>${summary.changed}</b><span>changed</span></div><div><b>${summary.unchangedTargets}</b><span>unchanged</span></div></div></aside></section>
  <section class="sources"><div class="source"><span>Baseline</span><strong>${escapeHtml(comparison.baseline.label)}</strong><small>SSRWire ${escapeHtml(comparison.baseline.version)} · ${escapeHtml(comparison.baseline.generatedAt)} · repeat ${comparison.baseline.repeat}</small></div><div class="source"><span>Candidate</span><strong>${escapeHtml(comparison.candidate.label)}</strong><small>SSRWire ${escapeHtml(comparison.candidate.version)} · ${escapeHtml(comparison.candidate.generatedAt)} · repeat ${comparison.candidate.repeat}</small></div></section>
  <p class="threshold">Timing regressions require both &gt;${comparison.thresholds.timingRegressionMs} ms and &gt;${comparison.thresholds.timingRegressionPercent}% median increase.</p>
  ${targets || '<section class="target"><p class="clean">Both reports contain no targets.</p></section>'}
  <p class="legend"><code>H</code> headers · <code>B</code> first byte · <code>T</code> title · <code>D</code> description · <code>C</code> canonical · <code>OG</code> Open Graph ready · <code>X</code> Twitter Card ready · <code>R</code> required signals ready · <code>M</code> main text · <code>✓</code> complete. Hover markers for timing, location, and byte evidence.</p>
</main></body></html>\n`;
}

export function renderComparisonReport(
  comparison: AuditComparison,
  format: ComparisonReportFormat,
  options: ComparisonReporterOptions = {},
): string {
  if (format === "terminal") return renderComparisonTerminal(comparison, options);
  if (format === "json") return renderComparisonJson(comparison);
  if (format === "html") return renderComparisonHtml(comparison);

  const exhaustive: never = format;
  return exhaustive;
}
