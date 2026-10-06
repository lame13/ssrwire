import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseDocument } from "htmlparser2";
import { readBody } from "./read-body.js";

export interface SitemapOptions {
  /** Maximum number of sitemap documents to read, including nested sitemap indexes. */
  readonly maxSitemaps?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Path globs; when non-empty, a URL must match at least one to be kept. */
  readonly include?: readonly string[];
  /** Path globs; a URL matching any of these is dropped. */
  readonly exclude?: readonly string[];
  readonly limit?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface SitemapDiscovery {
  /** Discovered page URLs, de-duplicated and in document order. */
  readonly urls: readonly string[];
  /** Sitemap documents that were read, including nested indexes. */
  readonly sitemaps: readonly string[];
  /** True when a configured bound stopped discovery before it finished. */
  readonly truncated: boolean;
  /** Non-fatal problems, such as a nested sitemap that could not be read. */
  readonly errors: readonly string[];
}

export class SitemapError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SitemapError";
  }
}

const DEFAULT_MAX_SITEMAPS = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LIMIT = 100;
const DISCOVERY_USER_AGENT = "ssrwire-sitemap/1.0 (+https://nikom.work)";

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

/**
 * Translate a path glob into a regular expression.
 *
 * `*` spans any characters and `?` matches exactly one. A pattern without either is treated as a
 * fragment that may appear anywhere in the path, so `--sitemap-exclude blog` drops `/blog/…`
 * without the caller having to know the left anchor.
 */
export function globToRegExp(glob: string): RegExp {
  const trimmed = glob.trim();
  const effective = /[*?]/u.test(trimmed) ? trimmed : `*${trimmed}*`;
  const escaped = effective.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "u");
}

function normalizeGlob(glob: string): RegExp {
  return globToRegExp(glob);
}

function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function maybeGunzip(buffer: Buffer, maxBytes: number): Buffer {
  const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  return isGzip ? gunzipSync(buffer, { maxOutputLength: maxBytes }) : buffer;
}

interface XmlNode {
  readonly type?: string;
  readonly name?: string;
  readonly data?: string;
  readonly children?: readonly unknown[];
}

function asXmlNode(value: unknown): XmlNode | undefined {
  return value !== null && typeof value === "object" ? (value as XmlNode) : undefined;
}

function textOf(node: unknown): string {
  const text: string[] = [];
  const pending = [node];
  while (pending.length > 0) {
    const candidate = asXmlNode(pending.pop());
    if (candidate?.type === "text") text.push(candidate.data ?? "");
    else {
      for (let index = (candidate?.children?.length ?? 0) - 1; index >= 0; index -= 1) {
        pending.push(candidate?.children?.[index]);
      }
    }
  }
  return text.join("");
}

/**
 * Return the text of every `<loc>` that appears inside a `<container>` element.
 *
 * Sitemap and sitemap-index documents put their payload in `loc`, but which kind of entry a `loc`
 * belongs to is decided by its parent, so the walk is anchored at the container name rather than
 * collecting every `loc` in the document.
 */
function locsWithin(source: string, container: string): readonly string[] {
  const found: string[] = [];

  const pending: unknown[] = [parseDocument(source, { xmlMode: true })];
  while (pending.length > 0) {
    const candidate = asXmlNode(pending.pop());
    if (candidate === undefined) {
      continue;
    }
    const isContainer = candidate.type === "tag" && candidate.name?.toLowerCase() === container;
    for (const child of candidate.children ?? []) {
      const childNode = asXmlNode(child);
      if (childNode === undefined) {
        continue;
      }
      if (isContainer && childNode.type === "tag" && childNode.name?.toLowerCase() === "loc") {
        const text = textOf(childNode).trim();
        if (text.length > 0) {
          found.push(text);
        }
      }
    }
    for (let index = (candidate.children?.length ?? 0) - 1; index >= 0; index -= 1) {
      pending.push(candidate.children?.[index]);
    }
  }
  return found;
}

function validHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    url.hash = "";
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

async function readTarget(
  source: string,
  options: Required<Pick<SitemapOptions, "timeoutMs" | "maxBytes">> & { Fetch: typeof fetch },
): Promise<Buffer> {
  if (!isHttpUrl(source)) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of createReadStream(source)) {
      bytes += chunk.length;
      if (bytes > options.maxBytes)
        throw new SitemapError(`Sitemap exceeded ${options.maxBytes} bytes.`);
      chunks.push(chunk);
    }
    return maybeGunzip(Buffer.concat(chunks, bytes), options.maxBytes);
  }

  const origin = new URL(source).origin;
  const signal = AbortSignal.timeout(options.timeoutMs);
  let current = source;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await options.Fetch(current, {
      redirect: "manual",
      headers: { "user-agent": DISCOVERY_USER_AGENT, accept: "application/xml,text/xml,*/*" },
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      const next = location === null ? undefined : validHttpUrl(new URL(location, current).href);
      if (next === undefined) throw new SitemapError(`Invalid sitemap redirect from ${current}.`);
      if (new URL(next).origin !== origin)
        throw new SitemapError(`Skipped cross-origin sitemap redirect to ${next}.`);
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SitemapError(`${current} answered HTTP ${response.status}.`);
    }
    return maybeGunzip(await readBody(response, options.maxBytes), options.maxBytes);
  }
  throw new SitemapError(`${source} exceeded the sitemap redirect limit.`);
}

/**
 * Read a sitemap or sitemap index and return the page URLs it advertises.
 *
 * Nested sitemap indexes are followed only within the origin of the initial source, so a sitemap
 * cannot point SSRWire at unrelated hosts. Discovery is bounded by document count, byte size, and
 * a URL limit so that `check --sitemap` stays a bounded amount of work.
 */
export async function discoverSitemapTargets(
  source: string,
  options: SitemapOptions = {},
): Promise<SitemapDiscovery> {
  const maxSitemaps = options.maxSitemaps ?? DEFAULT_MAX_SITEMAPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const limit = options.limit ?? DEFAULT_LIMIT;
  for (const [name, value] of Object.entries({ maxSitemaps, timeoutMs, maxBytes, limit })) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new SitemapError(`${name} must be a positive integer.`);
  }
  const Fetch = options.fetchImpl ?? fetch;
  const includes = (options.include ?? []).map(normalizeGlob);
  const excludes = (options.exclude ?? []).map(normalizeGlob);

  const origin = isHttpUrl(source) ? new URL(source).origin : undefined;
  const queue: string[] = [source];
  const queued = new Set(queue);
  const seenSitemaps = new Set<string>();
  const seenUrls = new Set<string>();
  const urls: string[] = [];
  const sitemaps: string[] = [];
  const errors: string[] = [];
  let truncated = false;

  while (queue.length > 0) {
    if (seenSitemaps.size >= maxSitemaps || urls.length >= limit) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    if (current === undefined || seenSitemaps.has(current)) {
      continue;
    }
    seenSitemaps.add(current);

    let buffer: Buffer;
    try {
      buffer = await readTarget(current, { timeoutMs, maxBytes, Fetch });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The initial source is fatal; a nested sitemap only removes its own URLs from the run.
      if (current === source) {
        throw error instanceof SitemapError ? error : new SitemapError(message);
      }
      errors.push(`Could not read ${current}: ${message}`);
      continue;
    }
    sitemaps.push(current);
    const text = buffer.toString("utf8");

    for (const candidate of locsWithin(text, "sitemap")) {
      const url = validHttpUrl(candidate);
      if (url === undefined || queued.has(url)) {
        continue;
      }
      if (origin !== undefined && new URL(url).origin !== origin) {
        errors.push(`Skipped cross-origin nested sitemap ${url}.`);
        continue;
      }
      queue.push(url);
      queued.add(url);
    }

    for (const candidate of locsWithin(text, "url")) {
      const url = validHttpUrl(candidate);
      if (url === undefined || seenUrls.has(url)) {
        continue;
      }
      seenUrls.add(url);
      const path = new URL(url).pathname;
      if (includes.length > 0 && !matchesAny(includes, path)) {
        continue;
      }
      if (excludes.length > 0 && matchesAny(excludes, path)) {
        continue;
      }
      if (urls.length >= limit) {
        truncated = true;
        break;
      }
      urls.push(url);
    }
  }

  if (urls.length === 0) {
    throw new SitemapError(
      `${source} produced no page URLs. Check the sitemap, or relax --sitemap-include and ` +
        "--sitemap-exclude.",
    );
  }

  return { urls, sitemaps, truncated, errors };
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .replace(/-+$/u, "");
  return cleaned.slice(0, 48);
}

/**
 * Derive a stable target id from a URL path.
 *
 * The id depends only on the path, so the same route gets the same id on a production and a
 * preview origin and `ssrwire compare` can match them without a hand-written config.
 */
export function targetIdFromUrl(url: string): string {
  const pathname = new URL(url).pathname;
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape sequence is not worth failing over; the raw path still slugs cleanly.
  }
  const trimmed = decoded.replace(/^\/+|\/+$/gu, "");
  if (trimmed.length === 0) {
    return "home";
  }
  const base = slug(trimmed) === "" ? "page" : slug(trimmed);
  return base === "home" ? "home-page" : base;
}

/** Resolve collisions using path/query hashes that also work across deployment origins. */
export function assignTargetIds(urls: readonly string[]): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  const unique = [...new Set(urls)].sort();
  const counts = new Map<string, number>();
  for (const url of unique) {
    const base = targetIdFromUrl(url);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const used = new Set(counts.keys());
  for (const url of unique) {
    const base = targetIdFromUrl(url);
    if (counts.get(base) === 1) {
      ids.set(url, base);
      continue;
    }
    const parsed = new URL(url);
    const hash = createHash("sha256")
      .update(parsed.pathname + parsed.search)
      .digest("hex")
      .slice(0, 8);
    let id = `${base}-${hash}`;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${hash}-${suffix++}`;
    used.add(id);
    ids.set(url, id);
  }
  return ids;
}
