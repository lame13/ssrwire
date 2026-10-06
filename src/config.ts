import { access, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type AgentInput, resolveAgents } from "./agents.js";
import type {
  AgentProfile,
  AuditTarget,
  SsrWireConfig,
  TargetExpectations,
  WaiverRecord,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_REPEAT = 1;
const DEFAULT_CONCURRENCY = 4;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;
const DEFAULT_AGENTS = ["browser", "googlebot", "bingbot", "twitterbot"] as const;
const DEFAULT_CONFIG_FILES = [
  "ssrwire.config.yml",
  "ssrwire.config.yaml",
  "ssrwire.config.json",
] as const;

const requireSchema = z
  .object({
    title: z.boolean().optional(),
    description: z.boolean().optional(),
    canonical: z.boolean().optional(),
    h1: z.boolean().optional(),
    mainText: z.boolean().optional(),
    openGraph: z.boolean().optional(),
    twitterCard: z.boolean().optional(),
  })
  .strict();

const targetObjectSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i)
      .optional(),
    url: z.string().min(1),
    expectedStatus: z
      .union([
        z.number().int().min(100).max(599),
        z.array(z.number().int().min(100).max(599)).min(1),
      ])
      .optional(),
    expectedFinalUrl: z.string().min(1).optional(),
    require: requireSchema.optional(),
    maxFirstByteMs: z.number().positive().finite().optional(),
    maxCriticalMs: z.number().positive().finite().optional(),
  })
  .strict();

const agentObjectSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i),
    label: z.string().min(1).optional(),
    userAgent: z.string().min(1),
    requiresHeadMetadata: z.boolean().optional(),
  })
  .strict();

const waiverSchema = z
  .object({
    code: z.string().regex(/^\*$|^[a-z0-9][a-z0-9-]{0,63}$/, {
      message: "expected a finding code such as 'missing-description', or '*'",
    }),
    target: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    reason: z.string().trim().min(1).max(500),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, {
        message: "expected an ISO date such as 2026-12-31",
      })
      .optional(),
  })
  .strict();

const fileConfigSchema = z
  .object({
    targets: z.array(z.union([z.string().min(1), targetObjectSchema])).optional(),
    agents: z
      .array(z.union([z.string().min(1), agentObjectSchema]))
      .min(1)
      .optional(),
    ignore: z.array(waiverSchema).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
    maxBytes: z
      .number()
      .int()
      .min(1_024)
      .max(50 * 1024 * 1024)
      .optional(),
    maxRedirects: z.number().int().min(0).max(20).optional(),
    repeat: z.number().int().min(1).max(10).optional(),
    concurrency: z.number().int().min(MIN_CONCURRENCY).max(MAX_CONCURRENCY).optional(),
  })
  .strict();

type FileConfig = z.infer<typeof fileConfigSchema>;

export interface LoadConfigOptions {
  readonly configPath?: string;
  readonly urls?: readonly string[];
  /** Targets discovered from a sitemap. Explicit config and CLI targets win for the same URL. */
  readonly discovered?: readonly SitemapTarget[];
  readonly agents?: readonly string[];
  readonly headers?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly repeat?: number;
  readonly concurrency?: number;
  readonly cwd?: string;
}

export interface SitemapTarget {
  readonly url: string;
  readonly id: string;
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function validateHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${label} must be an absolute HTTP or HTTPS URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${label} must use HTTP or HTTPS.`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${label} must not contain embedded credentials.`);
  }

  url.hash = "";
  return url.href;
}

function normalizeStatuses(value: number | number[] | undefined): readonly number[] {
  const statuses = value === undefined ? [200] : Array.isArray(value) ? value : [value];
  return [...new Set(statuses)];
}

type TargetInput = z.infer<typeof targetObjectSchema>;

function normalizeTarget(value: string | TargetInput): AuditTarget {
  const item: TargetInput = typeof value === "string" ? { url: value } : value;
  const required = item.require;
  const expectations: TargetExpectations = {
    statuses: normalizeStatuses(item.expectedStatus),
    ...(item.expectedFinalUrl
      ? { finalUrl: validateHttpUrl(item.expectedFinalUrl, "expectedFinalUrl") }
      : {}),
    requireTitle: required?.title ?? true,
    requireDescription: required?.description ?? true,
    requireCanonical: required?.canonical ?? true,
    requireH1: required?.h1 ?? true,
    requireMainText: required?.mainText ?? true,
    requireOpenGraph: required?.openGraph ?? false,
    requireTwitterCard: required?.twitterCard ?? false,
    ...(item.maxFirstByteMs === undefined ? {} : { maxFirstByteMs: item.maxFirstByteMs }),
    ...(item.maxCriticalMs === undefined ? {} : { maxCriticalMs: item.maxCriticalMs }),
  };

  return {
    ...(item.id === undefined ? {} : { id: item.id }),
    url: validateHttpUrl(item.url, "target URL"),
    expectations,
  };
}

function interpolateEnvironment(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new ConfigError(`Environment variable ${name} is required by a configured header.`);
    }
    return resolved;
  });
}

const FORBIDDEN_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
  "user-agent",
]);

function validateHeader(name: string, value: string): readonly [string, string] {
  const normalizedName = name.trim().toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(normalizedName)) {
    throw new ConfigError(`Invalid header name: ${name.trim() || "(empty)"}.`);
  }
  if (FORBIDDEN_HEADERS.has(normalizedName)) {
    throw new ConfigError(
      `Header ${normalizedName} is managed by SSRWire and cannot be overridden.`,
    );
  }
  if (/\r|\n/.test(value)) {
    throw new ConfigError(`Header ${normalizedName} contains a forbidden line break.`);
  }
  return [normalizedName, interpolateEnvironment(value.trim())];
}

export function parseHeaderOption(value: string): readonly [string, string] {
  const separator = value.indexOf(":");
  if (separator < 1) {
    throw new ConfigError("Headers must use the form 'Name: value'.");
  }
  return validateHeader(value.slice(0, separator), value.slice(separator + 1));
}

function normalizeHeaders(
  configured: Readonly<Record<string, string>> | undefined,
  commandLine: readonly string[] | undefined,
): Readonly<Record<string, string>> {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(configured ?? {})) {
    const [normalizedName, normalizedValue] = validateHeader(name, value);
    headers.set(normalizedName, normalizedValue);
  }
  for (const value of commandLine ?? []) {
    const [name, normalizedValue] = parseHeaderOption(value);
    headers.set(name, normalizedValue);
  }
  return Object.fromEntries(headers);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveConfigPath(
  explicitPath: string | undefined,
  cwd: string,
): Promise<string | undefined> {
  if (explicitPath) {
    const path = resolve(cwd, explicitPath);
    if (!(await fileExists(path))) {
      throw new ConfigError(`Configuration file not found: ${explicitPath}`);
    }
    return path;
  }

  for (const name of DEFAULT_CONFIG_FILES) {
    const path = resolve(cwd, name);
    if (await fileExists(path)) {
      return path;
    }
  }
  return undefined;
}

function parseConfigText(path: string, text: string): unknown {
  try {
    return extname(path).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text);
  } catch {
    // Parser messages may quote the malformed source line, including a literal header secret.
    throw new ConfigError("Could not parse configuration file.");
  }
}

async function readConfig(path: string | undefined): Promise<FileConfig> {
  if (!path) {
    return {};
  }
  const raw = parseConfigText(path, await readFile(path, "utf8"));
  const parsed = fileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${detail}`);
  }
  return parsed.data;
}

function stableSignature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Readonly<Record<string, unknown>>).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
}

function sameTargetContract(left: AuditTarget, right: AuditTarget): boolean {
  const signature = (target: AuditTarget) =>
    stableSignature({
      id: target.id ?? null,
      expectations: {
        ...target.expectations,
        statuses: [...target.expectations.statuses].sort((a, b) => a - b),
      },
    });
  return signature(left) === signature(right);
}

/**
 * Drop repeated URLs. A configuration that declares the same URL twice with different contracts
 * or ids is ambiguous, so it is rejected instead of silently keeping the first entry.
 */
function dedupeTargets(
  targets: readonly AuditTarget[],
  options: { readonly rejectConflicts: boolean },
): readonly AuditTarget[] {
  const unique: AuditTarget[] = [];
  const byUrl = new Map<string, AuditTarget>();
  for (const target of targets) {
    const existing = byUrl.get(target.url);
    if (existing === undefined) {
      byUrl.set(target.url, target);
      unique.push(target);
      continue;
    }
    if (options.rejectConflicts && !sameTargetContract(existing, target)) {
      throw new ConfigError(
        `${target.url} is declared more than once with different expectations or target ids. ` +
          "Keep a single contract per URL, or change one URL.",
      );
    }
  }
  return unique;
}

function uniqueTargets(targets: readonly AuditTarget[]): readonly AuditTarget[] {
  const unique = dedupeTargets(targets, { rejectConflicts: false });
  const ids = new Set<string>();
  for (const target of unique) {
    if (target.id === undefined) continue;
    if (ids.has(target.id)) {
      throw new ConfigError(`Target id ${target.id} is duplicated.`);
    }
    ids.add(target.id);
  }
  return unique;
}

function isRealDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Resolve waiver references against the targets and agents that actually exist.
 *
 * A typo in a waiver silently stops suppressing anything, which is the exact failure mode
 * waivers are meant to prevent, so unknown target and agent references are rejected instead.
 */
function normalizeWaivers(
  configured: readonly z.infer<typeof waiverSchema>[] | undefined,
  targets: readonly AuditTarget[],
  agents: readonly AgentProfile[],
): readonly WaiverRecord[] {
  if (configured === undefined || configured.length === 0) {
    return [];
  }

  const targetIds = new Set(
    targets.map((target) => target.id).filter((id): id is string => id !== undefined),
  );
  const targetUrls = new Set(targets.map((target) => target.url));
  const agentKeys = new Set(agents.map((agent) => agent.key));

  return configured.map((waiver) => {
    if (waiver.until !== undefined && !isRealDate(waiver.until)) {
      throw new ConfigError(`ignore entry for ${waiver.code} has an invalid 'until' date.`);
    }
    if (
      waiver.target !== undefined &&
      !targetIds.has(waiver.target) &&
      !targetUrls.has(waiver.target)
    ) {
      throw new ConfigError(
        `ignore entry for ${waiver.code} references unknown target '${waiver.target}'. ` +
          "Use a configured target id or an exact target URL.",
      );
    }
    if (waiver.agent !== undefined && !agentKeys.has(waiver.agent)) {
      throw new ConfigError(
        `ignore entry for ${waiver.code} references unknown agent '${waiver.agent}'. ` +
          `Known agents: ${[...agentKeys].join(", ")}.`,
      );
    }
    return {
      code: waiver.code,
      ...(waiver.target === undefined ? {} : { target: waiver.target }),
      ...(waiver.agent === undefined ? {} : { agent: waiver.agent }),
      reason: waiver.reason,
      ...(waiver.until === undefined ? {} : { until: waiver.until }),
    };
  });
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<SsrWireConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = await resolveConfigPath(options.configPath, cwd);
  const file = await readConfig(configPath);
  const fileTargets = dedupeTargets((file.targets ?? []).map(normalizeTarget), {
    rejectConflicts: true,
  });
  const discoveredTargets = dedupeTargets((options.discovered ?? []).map(normalizeTarget), {
    rejectConflicts: false,
  });
  const cliTargets = dedupeTargets((options.urls ?? []).map(normalizeTarget), {
    rejectConflicts: false,
  });
  const targets = uniqueTargets([...fileTargets, ...cliTargets, ...discoveredTargets]);
  if (targets.length === 0) {
    throw new ConfigError(
      "No target URL was provided. Pass a URL, add targets to ssrwire.config.yml, or use --sitemap.",
    );
  }

  const agentInputs: readonly AgentInput[] =
    options.agents && options.agents.length > 0
      ? options.agents
      : ((file.agents ?? DEFAULT_AGENTS) as readonly AgentInput[]);

  let agents: AgentProfile[];
  try {
    agents = resolveAgents(agentInputs);
  } catch (error) {
    throw new ConfigError(
      error instanceof Error ? error.message : "Invalid crawler agent configuration.",
    );
  }

  const timeoutMs = options.timeoutMs ?? file.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? file.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? file.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const repeat = options.repeat ?? file.repeat ?? DEFAULT_REPEAT;
  const concurrency = options.concurrency ?? file.concurrency ?? DEFAULT_CONCURRENCY;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new ConfigError("timeoutMs must be an integer between 100 and 120000.");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 50 * 1024 * 1024) {
    throw new ConfigError("maxBytes must be an integer between 1024 and 52428800.");
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new ConfigError("maxRedirects must be an integer between 0 and 20.");
  }
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
    throw new ConfigError("repeat must be an integer between 1 and 10.");
  }
  if (
    !Number.isInteger(concurrency) ||
    concurrency < MIN_CONCURRENCY ||
    concurrency > MAX_CONCURRENCY
  ) {
    throw new ConfigError(
      `concurrency must be an integer between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}.`,
    );
  }

  return {
    targets,
    agents,
    headers: normalizeHeaders(file.headers, options.headers),
    timeoutMs,
    maxBytes,
    maxRedirects,
    repeat,
    concurrency,
    waivers: normalizeWaivers(file.ignore, targets, agents),
  };
}
