#!/usr/bin/env node

import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { runAudit } from "./audit.js";
import { ConfigError, loadConfig } from "./config.js";
import { renderReport } from "./reporters.js";
import type { ReportFormat } from "./types.js";
import { VERSION } from "./version.js";

interface CliOptions {
  readonly config?: string;
  readonly agent: readonly string[];
  readonly header: readonly string[];
  readonly timeout?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly format: ReportFormat;
  readonly output?: string;
  readonly failOn: "error" | "warning" | "never";
  readonly color: boolean;
}

const CONFIG_TEMPLATE = `# SSRWire configuration
targets:
  - url: https://example.com/
    expectedStatus: 200
    require:
      title: true
      description: true
      canonical: true
      h1: true
      mainText: true

agents:
  - browser
  - googlebot
  - bingbot
  - twitterbot

timeoutMs: 15000
maxBytes: 10485760
maxRedirects: 10

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
  if (value === "terminal" || value === "json" || value === "sarif") {
    return value;
  }
  throw new InvalidArgumentError("Expected terminal, json, or sarif.");
}

function parseFailOn(value: string): CliOptions["failOn"] {
  if (value === "error" || value === "warning" || value === "never") {
    return value;
  }
  throw new InvalidArgumentError("Expected error, warning, or never.");
}

function addCheckOptions(command: Command): Command {
  return command
    .option("-c, --config <path>", "configuration file")
    .option("-a, --agent <name>", "built-in crawler agent; repeatable", collect, [])
    .option("-H, --header <header>", "same-origin request header; repeatable", collect, [])
    .option("--timeout <ms>", "request timeout in milliseconds", parseInteger)
    .option("--max-bytes <bytes>", "maximum response bytes", parseInteger)
    .option("--max-redirects <count>", "maximum redirects", parseInteger)
    .option("-f, --format <format>", "terminal, json, or sarif", parseFormat, "terminal")
    .option("-o, --output <path>", "write the report to a file")
    .option("--fail-on <level>", "error, warning, or never", parseFailOn, "error")
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

async function check(urls: readonly string[], options: CliOptions): Promise<void> {
  const config = await loadConfig({
    ...(options.config ? { configPath: options.config } : {}),
    urls,
    agents: options.agent,
    headers: options.header,
    ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
  });
  const audit = await runAudit(config);
  const color =
    options.color &&
    !options.output &&
    Boolean(process.stdout.isTTY) &&
    !Reflect.has(process.env, "NO_COLOR");
  const report = renderReport(audit, options.format, { color });

  if (options.output) {
    await writeReport(options.output, report);
    process.stderr.write(`SSRWire wrote ${options.format} report to ${options.output}\n`);
  } else {
    process.stdout.write(report);
  }

  process.exitCode = reportExitCode(audit.summary, options.failOn);
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
    .description("Inspect streamed SSR HTML and crawler-specific metadata delivery.")
    .version(VERSION)
    .exitOverride()
    .showHelpAfterError();

  addCheckOptions(program)
    .argument("[urls...]", "HTTP or HTTPS URLs to inspect")
    .action(async (urls: string[], _options: CliOptions, command: Command) => {
      await check(urls, optionsFrom(command));
    });

  addCheckOptions(
    program
      .command("check")
      .description("inspect one or more SSR responses")
      .argument("[urls...]", "HTTP or HTTPS URLs to inspect"),
  ).action(async (urls: string[], _options: CliOptions, command: Command) => {
    await check(urls, optionsFrom(command));
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

const invokedPath = process.argv[1];
if (invokedPath) {
  let invokedUrl = pathToFileURL(resolve(invokedPath)).href;
  try {
    invokedUrl = pathToFileURL(await realpath(invokedPath)).href;
  } catch {
    // The unresolved path still supports direct source execution when realpath is unavailable.
  }
  if (import.meta.url === invokedUrl) await main();
}
