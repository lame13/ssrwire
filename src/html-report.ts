import {
  type AuditVerdict,
  auditVerdict,
  explainFinding,
  nextSteps,
  targetVerdict,
  type VerdictKind,
} from "./explain.js";
import type { FrameworkDetection } from "./framework.js";
import {
  effectiveTwitterCardSignal,
  firstSocialSignal,
  OPEN_GRAPH_REQUIRED_PROPERTIES,
  TWITTER_CARD_REQUIRED_FIELDS,
} from "./social.js";
import type {
  AgentStability,
  AuditResult,
  ElementSignal,
  Finding,
  ProbeResult,
  Severity,
  TargetAuditResult,
} from "./types.js";

export interface AuditReportOptions {
  /** Stack used to pick framework-specific fix recipes. Omitted when detection failed. */
  readonly framework?: FrameworkDetection;
  /** Policy outcome for the run that produced this report, shown in the footer. */
  readonly policy?: AuditPolicyOutcome;
}

export interface AuditPolicyOutcome {
  readonly failOn: string;
  readonly exitCode: number;
}

const SIGNAL_ARRIVAL_LIMIT = 60;

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = Object.freeze({
  error: "Error",
  warning: "Warning",
  info: "Note",
});

const VERDICT_LABEL: Readonly<Record<VerdictKind, string>> = Object.freeze({
  pass: "Passed",
  attention: "Review",
  blocked: "Blocked",
  incomplete: "Incomplete",
});

const VERDICT_MARK: Readonly<Record<VerdictKind, string>> = Object.freeze({
  pass: "✓",
  attention: "!",
  blocked: "✕",
  incomplete: "…",
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, length: number): string {
  const clean = oneLine(value);
  if (clean.length <= length) return clean;
  return `${clean.slice(0, Math.max(0, length - 1))}…`;
}

function formatMs(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value)} ms`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function signalCell(signal: ElementSignal | undefined): string {
  if (signal === undefined) return '<span class="absent">not delivered</span>';
  return `${escapeHtml(formatMs(signal.atMs))}<small>${escapeHtml(signal.location)} · byte ${signal.observedByByte}</small>`;
}

function firstSignal(signals: readonly ElementSignal[]): ElementSignal | undefined {
  return signals.find((signal) => signal.value.trim().length > 0) ?? signals[0];
}

function verdictBadge(verdict: AuditVerdict): string {
  return `<p class="badge ${verdict.kind}"><span aria-hidden="true">${VERDICT_MARK[verdict.kind]}</span> ${escapeHtml(VERDICT_LABEL[verdict.kind])}</p>`;
}

function renderFinding(finding: Finding, framework: FrameworkDetection | undefined): string {
  const explanation = explainFinding(finding, framework === undefined ? {} : { framework });
  const agent =
    finding.agent === undefined ? "" : `<span class="chip">${escapeHtml(finding.agent)}</span>`;
  const evidence =
    finding.evidence === undefined
      ? ""
      : `<p class="raw"><span>Recorded evidence</span> ${escapeHtml(
          Object.entries(finding.evidence)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(" · "),
        )}</p>`;
  const snippet =
    explanation.snippet === undefined
      ? ""
      : `<div class="snippet"><p class="snippet-label">${escapeHtml(explanation.snippet.label)}</p><pre><code>${escapeHtml(explanation.snippet.text)}</code></pre></div>`;

  return `<article class="finding ${finding.severity}">
    <h4><span class="severity ${finding.severity}">${SEVERITY_LABEL[finding.severity]}</span> ${escapeHtml(explanation.title)}${agent}</h4>
    <p class="muted"><strong class="label">What SSRWire saw:</strong> ${escapeHtml(explanation.means)}</p>
    <p><strong class="label">Why it matters:</strong> ${escapeHtml(explanation.impact)}</p>
    <p><strong class="label">What to do:</strong> ${escapeHtml(explanation.fix)}</p>
    ${snippet}
    <p class="technical">${escapeHtml(finding.code)} · ${escapeHtml(truncate(finding.message, 400))}</p>
    ${evidence}
  </article>`;
}

function renderFindings(
  result: TargetAuditResult,
  framework: FrameworkDetection | undefined,
): string {
  if (result.findings.length === 0) {
    return '<p class="clean">No findings. Every checked contract passed for this target.</p>';
  }

  const order: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };
  const sorted = [...result.findings].sort((left, right) => {
    const bySeverity = order[left.severity] - order[right.severity];
    return bySeverity !== 0 ? bySeverity : left.code.localeCompare(right.code);
  });

  return `<div class="findings">${sorted.map((finding) => renderFinding(finding, framework)).join("\n")}</div>`;
}

function renderProbeRows(result: TargetAuditResult, showSample: boolean): string {
  return result.probes
    .map((probe) => {
      const cells = [
        ...(showSample ? [`<td>${probe.sample ?? "—"}</td>`] : []),
        `<th scope="row">${escapeHtml(probe.agent.label)}</th>`,
        `<td>${probe.status === undefined ? "—" : probe.status}</td>`,
        `<td>${escapeHtml(probe.completion)}</td>`,
        `<td>${escapeHtml(formatMs(probe.timings.headersMs))}</td>`,
        `<td>${escapeHtml(formatMs(probe.timings.firstByteMs))}</td>`,
        `<td>${escapeHtml(formatMs(probe.timings.completeMs))}</td>`,
        `<td>${escapeHtml(formatBytes(probe.bytesRead))}</td>`,
        `<td>${signalCell(probe.signals.title)}</td>`,
        `<td>${signalCell(firstSignal(probe.signals.descriptions))}</td>`,
        `<td>${signalCell(firstSignal(probe.signals.canonicals))}</td>`,
        `<td>${signalCell(probe.signals.firstMainText)}</td>`,
      ];
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("\n");
}

function renderProbeTable(result: TargetAuditResult, showSample: boolean): string {
  const head = [
    ...(showSample ? ['<th scope="col">Sample</th>'] : []),
    '<th scope="col">Crawler</th>',
    '<th scope="col">HTTP</th>',
    '<th scope="col">Result</th>',
    '<th scope="col">Headers</th>',
    '<th scope="col">First byte</th>',
    '<th scope="col">Complete</th>',
    '<th scope="col">Bytes</th>',
    '<th scope="col">Title</th>',
    '<th scope="col">Description</th>',
    '<th scope="col">Canonical</th>',
    '<th scope="col">Main text</th>',
  ].join("");

  return `<div class="scroll"><table>
    <caption class="vh">Response and metadata timing per crawler for ${escapeHtml(result.target.url)}</caption>
    <thead><tr>${head}</tr></thead>
    <tbody>${renderProbeRows(result, showSample)}</tbody>
  </table></div>`;
}

interface ArrivalRow {
  readonly agent: string;
  readonly signal: string;
  readonly mark: { readonly atMs: number; readonly observedByByte: number };
  readonly location: string;
  readonly value: string;
}

function arrivalRows(result: TargetAuditResult): readonly ArrivalRow[] {
  const rows: ArrivalRow[] = [];
  for (const probe of result.probes) {
    const agent = probe.agent.label;
    const signals: readonly (readonly [string, ElementSignal | undefined])[] = [
      ["Title", probe.signals.title],
      ["Description", firstSignal(probe.signals.descriptions)],
      ["Canonical", firstSignal(probe.signals.canonicals)],
      ["H1", firstSignal(probe.signals.h1s)],
      ["Main text", probe.signals.firstMainText],
    ];
    for (const [label, signal] of signals) {
      if (signal === undefined) continue;
      rows.push({
        agent,
        signal: label,
        mark: signal,
        location: signal.location,
        value: truncate(signal.value, 120),
      });
    }
  }
  return rows;
}

function renderArrivals(result: TargetAuditResult): string {
  const rows = arrivalRows(result);
  if (rows.length === 0) {
    return '<p class="clean">No metadata signals arrived in the captured responses.</p>';
  }

  const shown = rows.slice(0, SIGNAL_ARRIVAL_LIMIT);
  const truncated =
    rows.length > shown.length
      ? `<p class="muted">Showing ${shown.length} of ${rows.length} signal arrivals.</p>`
      : "";
  const body = shown
    .map(
      (row) => `<tr>
      <td>${escapeHtml(row.agent)}</td>
      <td>${escapeHtml(row.signal)}</td>
      <td>${escapeHtml(formatMs(row.mark.atMs))}</td>
      <td>${escapeHtml(row.location)}</td>
      <td>${row.mark.observedByByte}</td>
      <td class="value">${escapeHtml(row.value)}</td>
    </tr>`,
    )
    .join("\n");

  return `${truncated}<div class="scroll"><table>
    <caption class="vh">Streaming arrival order and document position for every captured signal</caption>
    <thead><tr>
      <th scope="col">Crawler</th>
      <th scope="col">Signal</th>
      <th scope="col">Arrived</th>
      <th scope="col">Location</th>
      <th scope="col">Observed by byte</th>
      <th scope="col">Value</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function renderSocialReadiness(result: TargetAuditResult): string {
  const rows = result.probes
    .map((probe) => {
      const openGraph = OPEN_GRAPH_REQUIRED_PROPERTIES.map((property) =>
        firstSocialSignal(probe.signals, property),
      );
      const twitter = TWITTER_CARD_REQUIRED_FIELDS.map((field) =>
        effectiveTwitterCardSignal(probe.signals, field),
      );
      const readiness = (signals: readonly (ElementSignal | undefined)[]): string => {
        const present = signals.filter((signal): signal is ElementSignal => signal !== undefined);
        if (present.length === signals.length) return '<span class="ok">complete</span>';
        return `<span class="absent">${present.length} of ${signals.length}</span>`;
      };
      return `<tr>
        <th scope="row">${escapeHtml(probe.agent.label)}</th>
        <td>${readiness(openGraph)}</td>
        <td>${readiness(twitter)}</td>
      </tr>`;
    })
    .join("\n");

  return `<div class="scroll"><table>
    <caption class="vh">Social preview readiness per crawler</caption>
    <thead><tr>
      <th scope="col">Crawler</th>
      <th scope="col">Open Graph required fields</th>
      <th scope="col">Twitter Card fields</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function previewProbe(result: TargetAuditResult): ProbeResult | undefined {
  return result.probes.find((probe) => probe.agent.key === "browser") ?? result.probes[0];
}

function renderSocialCard(result: TargetAuditResult, anchor: string): string {
  const probe = previewProbe(result);
  if (probe === undefined) return "";
  const title =
    firstSocialSignal(probe.signals, "og:title") ??
    firstSocialSignal(probe.signals, "twitter:title") ??
    probe.signals.title;
  const description =
    firstSocialSignal(probe.signals, "og:description") ??
    firstSocialSignal(probe.signals, "twitter:description") ??
    firstSignals(probe.signals.descriptions);
  const image =
    firstSocialSignal(probe.signals, "og:image") ??
    firstSocialSignal(probe.signals, "twitter:image");
  if (title === undefined && description === undefined && image === undefined) return "";

  const site = safeHost(probe.finalUrl);
  return `<section class="card-preview" aria-labelledby="preview-${anchor}">
    <h3 id="preview-${anchor}">How a shared link would be described</h3>
    <div class="card">
      <div class="thumb">${image === undefined ? '<span class="absent">no og:image or twitter:image</span>' : `<span class="thumb-url">${escapeHtml(truncate(image.value, 120))}</span>`}</div>
      <div class="card-body">
        <p class="site">${escapeHtml(site)}</p>
        <p class="card-title">${escapeHtml(truncate(title?.value ?? "No title available", 90))}</p>
        <p class="card-description">${escapeHtml(truncate(description?.value ?? "No description available", 160))}</p>
      </div>
    </div>
    <p class="muted">Values taken from the server response for ${escapeHtml(probe.agent.label)}. SSRWire does not fetch or render the image, so the thumbnail box shows the URL instead of the picture.</p>
  </section>`;
}

function firstSignals(signals: readonly ElementSignal[]): ElementSignal | undefined {
  return signals.find((signal) => signal.value.trim().length > 0);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function stabilityRows(stability: readonly AgentStability[]): string {
  const labels: Readonly<Record<keyof AgentStability["timings"], string>> = {
    headers: "Headers",
    firstByte: "First byte",
    criticalSignals: "Required signals",
    complete: "Complete body",
  };
  const rows: string[] = [];
  for (const summary of stability) {
    for (const key of ["headers", "firstByte", "criticalSignals", "complete"] as const) {
      const stats = summary.timings[key];
      if (stats === undefined) continue;
      rows.push(`<tr>
        <th scope="row">${escapeHtml(summary.agent.label)}</th>
        <td>${escapeHtml(labels[key])}</td>
        <td>${summary.complete}/${summary.samples}</td>
        <td>${escapeHtml(formatMs(stats.minMs))}</td>
        <td>${escapeHtml(formatMs(stats.medianMs))}</td>
        <td>${escapeHtml(formatMs(stats.p95Ms))}</td>
        <td>${escapeHtml(formatMs(stats.maxMs))}</td>
        <td>${escapeHtml(formatMs(stats.spreadMs))}</td>
      </tr>`);
    }
  }

  if (rows.length === 0) return "";
  return `<div class="scroll"><table>
    <caption class="vh">Timing stability across repeated samples</caption>
    <thead><tr>
      <th scope="col">Crawler</th>
      <th scope="col">Metric</th>
      <th scope="col">Complete</th>
      <th scope="col">Min</th>
      <th scope="col">Median</th>
      <th scope="col">P95</th>
      <th scope="col">Max</th>
      <th scope="col">Spread</th>
    </tr></thead>
    <tbody>${rows.join("\n")}</tbody>
  </table></div>`;
}

function renderTarget(
  result: TargetAuditResult,
  index: number,
  audit: AuditResult,
  framework: FrameworkDetection | undefined,
): string {
  const anchor = `target-${index + 1}`;
  const verdict = targetVerdict(result);
  const steps = nextSteps(result.findings, framework === undefined ? {} : { framework });
  const hasSocial =
    result.target.expectations.requireOpenGraph === true ||
    result.target.expectations.requireTwitterCard === true ||
    result.probes.some((probe) => (probe.signals.socialMetadata?.length ?? 0) > 0);

  const stepList =
    steps.length === 0
      ? ""
      : `<section class="panel">
          <h3>What to do first</h3>
          <ol class="steps">${steps
            .slice(0, 6)
            .map(
              (step) =>
                `<li class="${step.severity}"><strong>${escapeHtml(step.title)}</strong>${step.occurrences > 1 ? ` <span class="chip">${step.occurrences} findings</span>` : ""}<span>${escapeHtml(step.fix)}</span></li>`,
            )
            .join("")}</ol>
          ${steps.length > 6 ? `<p class="muted">${steps.length - 6} further distinct fix(es) appear in the findings below.</p>` : ""}
        </section>`;

  const stability =
    result.stability === undefined
      ? ""
      : `<section class="panel"><h3>Timing stability</h3>${stabilityRows(result.stability)}</section>`;

  return `<section class="target" aria-labelledby="${anchor}">
    <header>
      <div>
        <p class="eyebrow">${escapeHtml(result.target.id ?? "target")}</p>
        <h2 id="${anchor}">${escapeHtml(result.target.id ?? result.target.url)}</h2>
        <p class="url">${escapeHtml(result.target.url)}</p>
      </div>
      <div class="verdict ${verdict.kind}">
        ${verdictBadge(verdict)}
        <p class="headline">${escapeHtml(verdict.headline)}</p>
        <p class="muted">${escapeHtml(verdict.detail)}</p>
      </div>
    </header>
    ${stepList}
    <section class="panel"><h3>Findings</h3>${renderFindings(result, framework)}</section>
    ${hasSocial ? `<section class="panel"><h3>Social preview readiness</h3>${renderSocialReadiness(result)}</section>` : ""}
    ${renderSocialCard(result, anchor)}
    <section class="panel"><h3>Response and metadata timing</h3>${renderProbeTable(result, (audit.repeat ?? 1) > 1)}</section>
    <section class="panel"><h3>Streaming arrival order</h3>${renderArrivals(result)}</section>
    ${stability}
  </section>`;
}

function renderFrameworkNote(framework: FrameworkDetection | undefined): string {
  if (framework === undefined) {
    return `<p class="muted">SSRWire could not identify the stack behind these responses, so fix recipes stay stack-neutral. Run the report from the project directory or pass <code>--framework</code> to add examples for a specific framework.</p>`;
  }
  return `<p class="muted">Fix recipes below target <strong>${escapeHtml(framework.label)}</strong> (${escapeHtml(framework.evidence)}).</p>`;
}

function renderRunNote(audit: AuditResult, policy: AuditPolicyOutcome | undefined): string {
  const lines = [
    `<span>Software</span> SSRWire ${escapeHtml(audit.version)}`,
    `<span>Generated</span> ${escapeHtml(audit.generatedAt)} in ${escapeHtml(formatMs(audit.durationMs))}`,
    `<span>Targets</span> ${audit.summary.targets}`,
    `<span>Probes</span> ${audit.summary.probes}`,
    `<span>Samples per URL and crawler</span> ${audit.repeat ?? 1}`,
  ];
  if (policy !== undefined) {
    lines.push(
      `<span>Policy</span> fail-on ${escapeHtml(policy.failOn)} · exit code ${policy.exitCode}`,
    );
  }
  return `<ul class="run">${lines.map((line) => `<li>${line}</li>`).join("")}</ul>`;
}

function renderReproduce(audit: AuditResult): string {
  const urls = audit.results.map((result) => result.target.url);
  const shown = urls.slice(0, 5);
  const command = `npx ssrwire check${shown.length < urls.length ? " <url>..." : ""}${
    shown.length === 0 ? "" : ` \\\n  ${shown.map((url) => `'${url}'`).join(" \\\n  ")}`
  } \\\n  --format html --output ssrwire.html`;
  return `<section class="panel"><h3>Reproduce this report</h3><pre class="command"><code>${escapeHtml(command)}</code></pre>
  <p class="muted">SSRWire makes one HTTP request per crawler profile per sample. Timings are what this machine observed on this network, so compare runs from a stable location.</p></section>`;
}

export function renderAuditHtml(audit: AuditResult, options: AuditReportOptions = {}): string {
  const { framework, policy } = options;
  const verdict = auditVerdict(audit);
  const { summary } = audit;
  const targets = audit.results
    .map((result, index) => renderTarget(result, index, audit, framework))
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>SSRWire report · ${escapeHtml(verdict.headline)}</title>
  <style>
    :root{color-scheme:light dark;--bg:#f5f2eb;--panel:#fffdf8;--ink:#191c1b;--muted:#5c635f;--line:#d8d5cc;--red:#a4231a;--red-bg:#fff0ed;--amber:#8a5200;--amber-bg:#fff6e5;--green:#146b46;--green-bg:#ebf8f1;--blue:#175f9c;--blue-bg:#edf6ff;--chip:#ece9e1}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(1080px,calc(100% - 32px));margin:0 auto;padding:48px 0 80px}
    h1{font-size:clamp(30px,5vw,50px);line-height:1.05;margin:.2em 0}
    h2{font-size:26px;margin:.1em 0}
    h3{font-size:18px;margin:0 0 12px}
    h4{font-size:17px;margin:0 0 8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    p{margin:0 0 10px}
    a{color:var(--blue)}
    a:focus-visible,summary:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
    .skip{position:absolute;left:-9999px}
    .skip:focus{left:8px;top:8px;z-index:2;padding:8px 12px;border-radius:8px;background:var(--panel);border:1px solid var(--line)}
    .vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
    .eyebrow{color:var(--muted);font-size:12px;font-weight:750;letter-spacing:.1em;text-transform:uppercase;margin:0}
    .hero{display:grid;grid-template-columns:1.4fr 1fr;gap:28px;align-items:start;margin-bottom:26px}
    .hero .lede{color:var(--muted);font-size:17px}
    .outcome{border:1px solid var(--line);border-radius:16px;background:var(--panel);padding:16px 18px}
    .counts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}
    .counts div{border-radius:10px;padding:8px;background:var(--bg)}
    .counts b{display:block;font-size:20px}
    .counts span{color:var(--muted);font-size:12px}
    .target{background:var(--panel);border:1px solid var(--line);border-radius:16px;margin:18px 0;overflow:hidden}
    .target>header{display:grid;grid-template-columns:1.2fr 1fr;gap:24px;padding:22px 24px;border-bottom:1px solid var(--line)}
    .url{color:var(--muted);overflow-wrap:anywhere;margin:6px 0 0}
    .panel{padding:18px 24px;border-bottom:1px solid var(--line)}
    .panel:last-child{border-bottom:0}
    .verdict .badge{display:inline-flex;align-items:center;gap:8px;margin:0 0 8px;padding:3px 12px;border-radius:999px;font-weight:750;font-size:13px;text-transform:uppercase;letter-spacing:.06em}
    .badge.pass{background:var(--green-bg);color:var(--green)}
    .badge.attention{background:var(--amber-bg);color:var(--amber)}
    .badge.blocked{background:var(--red-bg);color:var(--red)}
    .badge.incomplete{background:var(--chip);color:var(--ink)}
    .verdict .headline{font-weight:650;margin:0 0 4px}
    .findings{display:grid;gap:12px}
    .finding{border-left:4px solid var(--blue);border-radius:10px;background:var(--blue-bg);padding:14px 16px}
    .finding.error{border-color:var(--red);background:var(--red-bg)}
    .finding.warning{border-color:var(--amber);background:var(--amber-bg)}
    .finding.info{border-color:var(--blue);background:var(--blue-bg)}
    .severity{font-size:11px;font-weight:850;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px;border-radius:999px;background:var(--panel)}
    .severity.error{color:var(--red)}
    .severity.warning{color:var(--amber)}
    .severity.info{color:var(--blue)}
    .chip{background:var(--chip);color:var(--ink);border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600}
    .label{font-weight:700}
    .muted{color:var(--muted)}
    .clean{color:var(--green);font-weight:650}
    .absent{color:var(--muted)}
    .ok{color:var(--green);font-weight:650}
    .technical,.raw{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--muted);margin:10px 0 0;overflow-wrap:anywhere}
    .raw span{font-weight:700}
    pre{margin:0;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg);overflow:auto}
    code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
    .snippet{margin:10px 0 0}
    .snippet-label{font-size:12px;font-weight:700;color:var(--muted);margin:0 0 5px;text-transform:uppercase;letter-spacing:.06em}
    .steps{margin:0;padding-left:22px;display:grid;gap:9px}
    .steps li.error::marker{color:var(--red)}
    .steps li.warning::marker{color:var(--amber)}
    .steps li span{display:block;color:var(--muted)}
    .scroll{overflow-x:auto}
    table{border-collapse:collapse;width:100%;font-size:14px}
    th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
    thead th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
    tbody th{font-weight:650}
    td small{display:block;color:var(--muted);font-size:12px}
    td.value{max-width:340px;overflow-wrap:anywhere}
    .card-preview{padding:18px 24px;border-bottom:1px solid var(--line)}
    .card{display:grid;grid-template-columns:260px 1fr;gap:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel);max-width:620px}
    .thumb{display:flex;align-items:center;justify-content:center;min-height:150px;padding:12px;background:var(--bg);border-right:1px solid var(--line);text-align:center}
    .thumb-url{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
    .card-body{padding:14px 16px}
    .site{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0}
    .card-title{font-weight:700;margin:6px 0 4px}
    .card-description{color:var(--muted);margin:0}
    .run{list-style:none;margin:0;padding:0;display:grid;gap:4px;color:var(--muted)}
    .run span{display:inline-block;min-width:210px;color:var(--ink);font-weight:600}
    @media(max-width:760px){.hero,.target>header,.card{grid-template-columns:1fr}.thumb{min-height:110px;border-right:0;border-bottom:1px solid var(--line)}th,td{padding:7px 8px}}
    @media(prefers-color-scheme:dark){:root{--bg:#151817;--panel:#1d211f;--ink:#f0f3f1;--muted:#aab2ad;--line:#363d39;--red:#ff9a90;--red-bg:#321d1a;--amber:#f0bd6a;--amber-bg:#2f2717;--green:#73d6a6;--green-bg:#173125;--blue:#8fc7ff;--blue-bg:#172a3a;--chip:#2a2f2c}}
    @media print{body{background:#fff}.target,.finding,.card{break-inside:avoid}.panel{padding:12px 16px}.skip{display:none}}
  </style>
</head>
<body>
<a class="skip" href="#main">Skip to report</a>
<main id="main">
  <section class="hero">
    <div>
      <p class="eyebrow">SSRWire ${escapeHtml(audit.version)} · server-rendered HTML audit</p>
      <h1>${escapeHtml(verdict.headline)}</h1>
      <p class="lede">${escapeHtml(verdict.detail)}</p>
      <p class="muted">SSRWire requested each page the way real crawlers and browsers do and recorded the HTML they received — without executing JavaScript, and without a browser.</p>
    </div>
    <aside class="outcome">
      ${verdictBadge(verdict)}
      <div class="counts">
        <div><b>${summary.errors}</b><span>errors</span></div>
        <div><b>${summary.warnings}</b><span>warnings</span></div>
        <div><b>${summary.incomplete}</b><span>incomplete</span></div>
      </div>
    </aside>
  </section>
  <section class="panel">
    <h2>What this report covers</h2>
    ${renderFrameworkNote(framework)}
    <p>Each target is requested once per crawler profile. SSRWire records what arrived, when it arrived, and where in the document it appeared, then checks the contracts configured for that URL.</p>
    <p class="muted">This is not a JavaScript-rendered view of the page, not proof of how a crawler will index it, and not a Core Web Vitals measurement. Run it against targets you are authorized to inspect.</p>
    ${renderRunNote(audit, policy)}
  </section>
  ${targets || '<section class="target"><p class="clean">This report contains no targets.</p></section>'}
  ${renderReproduce(audit)}
  <p class="muted">SSRWire never embeds raw response HTML. Values are redacted using configured header secrets before they reach this report.</p>
</main>
</body>
</html>
`;
}
