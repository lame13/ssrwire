import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProbeResult } from "./types.js";

export type FrameworkKey =
  | "nextjs"
  | "nuxt"
  | "astro"
  | "sveltekit"
  | "remix"
  | "laravel"
  | "wordpress"
  | "php"
  | "unknown";

export interface FrameworkDetection {
  readonly key: FrameworkKey;
  readonly label: string;
  /** Human-readable reason SSRWire believes this is the stack, such as a header or a file. */
  readonly evidence: string;
}

const LABELS: Readonly<Record<FrameworkKey, string>> = Object.freeze({
  nextjs: "Next.js",
  nuxt: "Nuxt",
  astro: "Astro",
  sveltekit: "SvelteKit",
  remix: "Remix",
  laravel: "Laravel",
  wordpress: "WordPress",
  php: "PHP",
  unknown: "an unidentified stack",
});

export const FRAMEWORK_KEYS: readonly FrameworkKey[] = Object.freeze([
  "nextjs",
  "nuxt",
  "astro",
  "sveltekit",
  "remix",
  "laravel",
  "wordpress",
  "php",
]);

export function isFrameworkKey(value: string): value is FrameworkKey {
  return (FRAMEWORK_KEYS as readonly string[]).includes(value);
}

export function frameworkLabel(key: FrameworkKey): string {
  return LABELS[key];
}

function detection(key: FrameworkKey, evidence: string): FrameworkDetection {
  return { key, label: LABELS[key], evidence };
}

/** Response headers that identify a stack without executing anything on the target. */
const POWERED_BY_MATCHERS: readonly (readonly [RegExp, FrameworkKey])[] = Object.freeze([
  [/next\.js/i, "nextjs"],
  [/\bnuxt\b/i, "nuxt"],
  [/\bastro\b/i, "astro"],
  [/sveltekit/i, "sveltekit"],
  [/\bremix\b/i, "remix"],
  [/laravel/i, "laravel"],
  [/wordpress|wp[- ]?engine/i, "wordpress"],
  [/\bphp\b/i, "php"],
]);

const PACKAGE_MATCHERS: readonly (readonly [string, FrameworkKey])[] = Object.freeze([
  ["next", "nextjs"],
  ["nuxt", "nuxt"],
  ["astro", "astro"],
  ["@sveltejs/kit", "sveltekit"],
  ["@remix-run/dev", "remix"],
  ["@remix-run/react", "remix"],
  ["@remix-run/node", "remix"],
]);

const COMPOSER_MATCHERS: readonly (readonly [string, FrameworkKey])[] = Object.freeze([
  ["laravel/framework", "laravel"],
  ["roots/wordpress", "wordpress"],
  ["symfony/framework-bundle", "php"],
]);

/**
 * Identify the framework behind a response from evidence SSRWire already captured.
 *
 * Only headers are used: they are cheap, bounded, and available for any remote target. An
 * unrecognized stack returns undefined rather than a guess.
 */
export function detectFrameworkFromProbes(
  probes: readonly ProbeResult[],
): FrameworkDetection | undefined {
  for (const probe of probes) {
    if (probe.headers.values["x-nextjs-cache"] !== undefined) {
      return detection("nextjs", "x-nextjs-cache response header");
    }
  }

  for (const probe of probes) {
    const poweredBy = probe.headers.values["x-powered-by"];
    if (poweredBy === undefined) continue;
    for (const [pattern, key] of POWERED_BY_MATCHERS) {
      if (pattern.test(poweredBy)) {
        return detection(key, `x-powered-by: ${poweredBy}`);
      }
    }
  }

  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(
  path: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}

function dependencyNames(source: Readonly<Record<string, unknown>> | undefined): Set<string> {
  const names = new Set<string>();
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    const group = field(source, section);
    if (typeof group !== "object" || group === null || Array.isArray(group)) continue;
    for (const name of Object.keys(group as Readonly<Record<string, unknown>>)) {
      names.add(name);
    }
  }
  return names;
}

function field(source: Readonly<Record<string, unknown>> | undefined, key: string): unknown {
  return source === undefined ? undefined : source[key];
}

/**
 * Identify the framework of the repository SSRWire is being run from.
 *
 * Fix recipes are more useful when they name the tool the maintainer actually builds with, so a
 * local manifest beats header sniffing whenever both are available. Missing or unreadable
 * manifests are normal, not errors: remote-only audits simply fall back to header evidence.
 */
export async function detectProjectFramework(cwd: string): Promise<FrameworkDetection | undefined> {
  const packageJson = await readJsonObject(join(cwd, "package.json"));
  const packageNames = dependencyNames(packageJson);
  for (const [name, key] of PACKAGE_MATCHERS) {
    if (packageNames.has(name)) {
      return detection(key, `package.json depends on ${name}`);
    }
  }

  const composerJson = await readJsonObject(join(cwd, "composer.json"));
  const required = field(composerJson, "require");
  if (typeof required === "object" && required !== null && !Array.isArray(required)) {
    const requiredNames = new Set(Object.keys(required as Readonly<Record<string, unknown>>));
    for (const [name, key] of COMPOSER_MATCHERS) {
      if (requiredNames.has(name)) {
        return detection(key, `composer.json requires ${name}`);
      }
    }
  }

  if (await pathExists(join(cwd, "wp-config.php"))) {
    return detection("wordpress", "wp-config.php in the working directory");
  }

  return undefined;
}
