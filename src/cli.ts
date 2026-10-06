import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { runAudit } from "./audit.js";
import { AuditReportError, parseAuditReportText } from "./audit-report.js";
import { compareAudits } from "./compare.js";
import { renderComparisonReport } from "./comparison-reporters.js";
import { ConfigError, loadConfig, type SitemapTarget } from "./config.js";
import {
  detectFrameworkFromProbes,
  detectProjectFramework,
  FRAMEWORK_KEYS,
  type FrameworkDetection,
  frameworkLabel,
  isFrameworkKey,
} from "./framework.js";
import { renderJson, renderReport } from "./reporters.js";
import { assignTargetIds, discoverSitemapTargets, targetIdFromUrl } from "./sitemap.js";
import type { AuditResult, ComparisonReportFormat, ReportFormat } from "./types.js";
import { VERSION } from "./version.js";

interface CliOptions {
  readonly config?: string;
  readonly agent: readonly string[];
  readonly header: readonly string[];
  readonly timeout?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly repeat?: number;
  readonly concurrency?: number;
  readonly sitemap?: string;
  readonly sitemapInclude: readonly string[];
  readonly sitemapExclude: readonly string[];
  readonly sitemapLimit?: number;
  readonly baseline?: string;
  readonly updateBaseline?: boolean;
  readonly format: ReportFormat;
  readonly output?: string;
  readonly failOn: "error" | "warning" | "never";
  readonly framework?: string;
  readonly color: boolean;
}

interface CompareCliOptions {
  readonly format: ComparisonReportFormat;
  readonly output?: string;
  readonly failOn: "regression" | "never";
  readonly timingRegressionMs: number;
  readonly timingRegressionPercent: number;
  readonly color: boolean;
}

const CONFIG_TEMPLATE = `# SSRWire configuration
targets:
  - id: home
    url: https://example.com/
    expectedStatus: 200
    require:
      title: true
      description: true
      canonical: true
      h1: true
      mainText: true
      openGraph: false
      twitterCard: false

agents:
  - browser
  - googlebot
  - bingbot
  - twitterbot

timeoutMs: 15000
maxBytes: 10485760
maxRedirects: 10
repeat: 1
concurrency: 4

# Waive a finding you have accepted, with a reason and an optional expiry date.
# ignore:
#   - code: missing-description
#     target: home
#     reason: tracked in SEO-1487
#     until: 2026-12-31

# Keep preview credentials in environment variables. SSRWire redacts configured values from reports.
# headers:
#   Authorization: \${PREVIEW_TOKEN}
`;

function collect(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError("Expected an integer.");
  }
  return parsed;
}

function parseFormat(value: string): ReportFormat {
  if (
    value === "terminal" ||
    value === "json" ||
    value === "sarif" ||
    value === "html" ||
    value === "junit" ||
    value === "markdown" ||
    value === "github"
  ) {
    return value;
  }
  throw new InvalidArgumentError(
    "Expected terminal, json, sarif, html, junit, markdown, or github.",
  );
}

function parseFrameworkOption(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "none" || isFrameworkKey(normalized)) {
    return normalized;
  }
  throw new InvalidArgumentError(`Expected auto, none, or one of ${FRAMEWORK_KEYS.join(", ")}.`);
}

function parseFailOn(value: string): CliOptions["failOn"] {
  if (value === "error" || value === "warning" || value === "never") {
    return value;
  }
  throw new InvalidArgumentError("Expected error, warning, or never.");
}

function parseComparisonFormat(value: string): ComparisonReportFormat {
  if (
    value === "terminal" ||
    value === "json" ||
    value === "html" ||
    value === "markdown" ||
    value === "github"
  ) {
    return value;
  }
  throw new InvalidArgumentError("Expected terminal, json, html, markdown, or github.");
}

function parseComparisonFailOn(value: string): CompareCliOptions["failOn"] {
  if (value === "regression" || value === "never") return value;
  throw new InvalidArgumentError("Expected regression or never.");
}

function parseNonNegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Expected a finite non-negative number.");
  }
  return parsed;
}

function addCheckOptions(command: Command): Command {
  return command
    .option("-c, --config <path>", "configuration file")
    .option("-a, --agent <name>", "built-in crawler agent; repeatable", collect, [])
    .option("-H, --header <header>", "same-origin request header; repeatable", collect, [])
    .option("--timeout <ms>", "request timeout in milliseconds", parseInteger)
    .option("--max-bytes <bytes>", "maximum response bytes", parseInteger)
    .option("--max-redirects <count>", "maximum redirects", parseInteger)
    .option("--repeat <count>", "sequential samples per URL and agent", parseInteger)
    .option("--concurrency <count>", "parallel probes, 1-16", parseInteger)
    .option("--sitemap <source>", "discover targets from a sitemap URL or local file")
    .option(
      "--sitemap-include <glob>",
      "only keep sitemap paths matching this glob; repeatable",
      collect,
      [],
    )
    .option(
      "--sitemap-exclude <glob>",
      "drop sitemap paths matching this glob; repeatable",
      collect,
      [],
    )
    .option("--sitemap-limit <count>", "maximum page URLs to take from the sitemap", parseInteger)
    .option("--baseline <path>", "compare this run against a stored JSON baseline")
    .option("--update-baseline", "write this run to the --baseline path instead of comparing")
    .option(
      "-f, --format <format>",
      "terminal, json, sarif, html, junit, markdown, or github",
      parseFormat,
      "terminal",
    )
    .option("-o, --output <path>", "write the report to a file")
    .option("--fail-on <level>", "error, warning, or never", parseFailOn, "error")
    .option(
      "--framework <name>",
      "fix recipes for auto, none, or a framework name",
      parseFrameworkOption,
      "auto",
    )
    .option("--no-color", "disable terminal colors");
}

function optionsFrom(command: Command): CliOptions {
  return command.optsWithGlobals<CliOptions>();
}

function reportExitCode(
  summary: Awaited<ReturnType<typeof runAudit>>["summary"],
  failOn: CliOptions["failOn"],
): number {
  if (summary.incomplete > 0) {
    return 2;
  }
  if (failOn === "never") {
    return 0;
  }
  if (summary.errors > 0) {
    return 1;
  }
  if (failOn === "warning" && summary.warnings > 0) {
    return 1;
  }
  return 0;
}

async function writeReport(path: string, report: string): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, report, "utf8");
}

async function readAuditFile(path: string, label: string): Promise<AuditResult> {
  let text: string;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch {
    throw new AuditReportError(`Could not read ${label} audit report: ${path}`);
  }
  return parseAuditReportText(text, `${label} audit report`);
}

const DEFAULT_BASELINE_PATH = "ssrwire.baseline.json";

async function resolveSitemapTargets(
  options: CliOptions,
): Promise<readonly SitemapTarget[] | undefined> {
  if (options.sitemap === undefined) {
    return undefined;
  }
  const discovery = await discoverSitemapTargets(options.sitemap, {
    ...(options.sitemapLimit === undefined ? {} : { limit: options.sitemapLimit }),
    include: options.sitemapInclude,
    exclude: options.sitemapExclude,
  });
  for (const error of discovery.errors) {
    process.stderr.write(`SSRWire: ${error}\n`);
  }
  if (discovery.truncated) {
    process.stderr.write(
      `SSRWire: stopped sitemap discovery at a URL or document limit after ${discovery.urls.length} ` +
        "URL(s). Raise --sitemap-limit or audit a child sitemap separately.\n",
    );
  }
  const ids = assignTargetIds(discovery.urls);
  return discovery.urls.map((url) => ({ url, id: ids.get(url) ?? targetIdFromUrl(url) }));
}

/**
 * Apply the baseline contract for this run.
 *
 * `--update-baseline` records the current run; otherwise an existing baseline is compared against
 * it. The comparison is written to stderr so stdout keeps exactly one machine-readable report.
 */
async function applyBaseline(
  audit: AuditResult,
  options: CliOptions,
  baseline?: AuditResult,
): Promise<number> {
  if (options.baseline === undefined && options.updateBaseline !== true) {
    return 0;
  }
  const path = options.baseline ?? DEFAULT_BASELINE_PATH;

  if (options.updateBaseline === true) {
    if (audit.summary.incomplete > 0) {
      process.stderr.write(
        "SSRWire: baseline was not updated because the audit has incomplete probes.\n",
      );
      return 2;
    }
    await writeReport(path, renderJson(audit));
    process.stderr.write(`SSRWire wrote the new baseline to ${path}\n`);
    return 0;
  }

  if (baseline === undefined) throw new AuditReportError("No baseline report was loaded.");
  const comparison = compareAudits(baseline, audit, {
    baselineLabel: basename(path),
    candidateLabel: "current run",
  });
  process.stderr.write(renderComparisonReport(comparison, "terminal", { color: false }));
  const failed = options.failOn !== "never" && comparison.summary.regressions > 0;
  if (failed) {
    process.stderr.write(
      `SSRWire: ${comparison.summary.regressions} regression(s) against ${path}. ` +
        `Re-run with --update-baseline once the change is intended.\n`,
    );
  }
  return failed ? 1 : 0;
}

/**
 * Decide which stack the fix recipes should describe.
 *
 * Response headers describe the thing that actually answered, so they win over the local
 * manifest. The manifest is the fallback for a local build, and `--framework` lets anyone
 * override both when the report is being prepared for a project SSRWire cannot see.
 */
async function resolveFramework(
  option: string | undefined,
  audit: AuditResult,
): Promise<FrameworkDetection | undefined> {
  if (option === "none") {
    return undefined;
  }
  if (option !== undefined && option !== "auto") {
    if (!isFrameworkKey(option)) {
      throw new ConfigError(`Unsupported framework: ${option}.`);
    }
    return { key: option, label: frameworkLabel(option), evidence: "requested with --framework" };
  }

  for (const result of audit.results) {
    const detected = detectFrameworkFromProbes(result.probes);
    if (detected !== undefined) return detected;
  }
  return detectProjectFramework(process.cwd());
}

async function check(urls: readonly string[], options: CliOptions): Promise<void> {
  const baselinePath =
    options.baseline ?? (options.updateBaseline ? DEFAULT_BASELINE_PATH : undefined);
  if (
    baselinePath !== undefined &&
    options.output !== undefined &&
    resolve(baselinePath) === resolve(options.output)
  ) {
    throw new ConfigError("--output and --baseline must use different paths.");
  }
  const baseline =
    baselinePath !== undefined && options.updateBaseline !== true
      ? await readAuditFile(baselinePath, "baseline")
      : undefined;
  const discovered = await resolveSitemapTargets(options);
  const config = await loadConfig({
    ...(options.config ? { configPath: options.config } : {}),
    urls,
    ...(discovered === undefined ? {} : { discovered }),
    agents: options.agent,
    headers: options.header,
    ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
    ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });
  const audit = await runAudit(config);
  const framework =
    options.format === "html" ? await resolveFramework(options.framework, audit) : undefined;
  const color =
    options.color &&
    !options.output &&
    Boolean(process.stdout.isTTY) &&
    !Reflect.has(process.env, "NO_COLOR");
  const baselineCode = await applyBaseline(audit, options, baseline);
  const reportCode = Math.max(reportExitCode(audit.summary, options.failOn), baselineCode);
  const report = renderReport(audit, options.format, {
    color,
    ...(framework === undefined ? {} : { framework }),
    policy: { failOn: options.failOn, exitCode: reportCode },
  });

  if (options.output) {
    await writeReport(options.output, report);
    process.stderr.write(`SSRWire wrote ${options.format} report to ${options.output}\n`);
  } else {
    process.stdout.write(report);
  }

  process.exitCode = reportCode;
}

async function compareReports(
  baselinePath: string,
  candidatePath: string,
  options: CompareCliOptions,
): Promise<void> {
  const [baseline, candidate] = await Promise.all([
    readAuditFile(baselinePath, "baseline"),
    readAuditFile(candidatePath, "candidate"),
  ]);
  const comparison = compareAudits(baseline, candidate, {
    baselineLabel: basename(baselinePath),
    candidateLabel: basename(candidatePath),
    timingRegressionMs: options.timingRegressionMs,
    timingRegressionPercent: options.timingRegressionPercent,
  });
  const color =
    options.color &&
    !options.output &&
    Boolean(process.stdout.isTTY) &&
    !Reflect.has(process.env, "NO_COLOR");
  const report = renderComparisonReport(comparison, options.format, { color });

  if (options.output) {
    await writeReport(options.output, report);
    process.stderr.write(`SSRWire wrote ${options.format} comparison to ${options.output}\n`);
  } else {
    process.stdout.write(report);
  }

  process.exitCode = options.failOn === "regression" && comparison.summary.regressions > 0 ? 1 : 0;
}

async function initialize(path: string, force: boolean): Promise<void> {
  const absolute = resolve(path);
  if (!force) {
    try {
      await access(absolute);
      throw new ConfigError(`${path} already exists. Use --force to replace it.`);
    } catch (error) {
      if (error instanceof ConfigError) {
        throw error;
      }
    }
  }
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, CONFIG_TEMPLATE, { encoding: "utf8", flag: force ? "w" : "wx" });
  process.stdout.write(`Created ${path}\n`);
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("ssrwire")
    .description("Inspect streamed SSR HTML, SEO, and social metadata delivery.")
    .version(VERSION)
    .exitOverride()
    .showHelpAfterError();

  addCheckOptions(
    program
      .command("check", { isDefault: true })
      .description("inspect one or more SSR responses")
      .argument("[urls...]", "HTTP or HTTPS URLs to inspect"),
  ).action(async (urls: string[], _options: CliOptions, command: Command) => {
    await check(urls, optionsFrom(command));
  });

  program
    .command("compare")
    .description("compare two SSRWire JSON audit reports")
    .argument("<baseline>", "baseline JSON audit report")
    .argument("<candidate>", "candidate JSON audit report")
    .option(
      "-f, --format <format>",
      "terminal, json, html, markdown, or github",
      parseComparisonFormat,
      "terminal",
    )
    .option("-o, --output <path>", "write the comparison to a file")
    .option("--fail-on <level>", "regression or never", parseComparisonFailOn, "regression")
    .option(
      "--timing-regression-ms <ms>",
      "minimum absolute median slowdown",
      parseNonNegativeNumber,
      250,
    )
    .option(
      "--timing-regression-percent <percent>",
      "minimum relative median slowdown",
      parseNonNegativeNumber,
      25,
    )
    .option("--no-color", "disable terminal colors")
    .action(async (baselinePath: string, candidatePath: string, options: CompareCliOptions) => {
      await compareReports(baselinePath, candidatePath, options);
    });

  program
    .command("init")
    .description("create a documented starter configuration")
    .argument("[path]", "configuration path", "ssrwire.config.yml")
    .option("--force", "replace an existing file")
    .action(async (path: string, options: { force?: boolean }) => {
      await initialize(path, options.force ?? false);
    });

  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode === 0 ? 0 : 2;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`SSRWire: ${message}\n`);
    process.exitCode = 2;
  }
}
