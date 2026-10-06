import { readBody } from "./read-body.js";
import type { RobotsTxtEvidence } from "./types.js";

export interface RobotsTxtRule {
  readonly allow: boolean;
  readonly path: string;
}

export interface RobotsTxtGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsTxtRule[];
  readonly crawlDelayMs?: number;
}

export interface RobotsTxtDocument {
  readonly url: string;
  /** True when a usable document was read, including a 404 that legitimately means "allow all". */
  readonly fetched: boolean;
  readonly status?: number;
  readonly groups: readonly RobotsTxtGroup[];
  readonly sitemaps: readonly string[];
  readonly error?: string;
}

export interface RobotsVerdict {
  readonly verdict: "allowed" | "disallowed" | "unavailable";
  readonly matched?: string;
}

export interface RobotsFetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly fetchImpl?: typeof fetch;
  /** Overrides the user agent used for the discovery request, not for rule matching. */
  readonly userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DISCOVERY_USER_AGENT = "ssrwire-robots/1.0 (+https://nikom.work)";

interface MutableGroup {
  agents: string[];
  rules: RobotsTxtRule[];
  crawlDelayMs?: number;
}

/**
 * Parse a robots.txt document into groups.
 *
 * Consecutive `user-agent` lines share one group, and a `user-agent` line that follows a rule
 * starts a new one. `Sitemap` is a document-level record rather than a group rule, so it is
 * collected separately. An empty `Disallow` carries no restriction, so it produces no rule.
 */
export function parseRobotsTxt(text: string): {
  readonly groups: readonly RobotsTxtGroup[];
  readonly sitemaps: readonly string[];
} {
  const groups: MutableGroup[] = [];
  const sitemaps: string[] = [];
  let current: MutableGroup | undefined;
  let collectingAgents = false;

  for (const rawLine of text.split(/\r\n|\r|\n/u)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!collectingAgents || current === undefined) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (value.length > 0) {
        current.agents.push(value.toLowerCase());
      }
      collectingAgents = true;
      continue;
    }

    if (field === "sitemap") {
      if (value.length > 0) {
        sitemaps.push(value);
      }
      continue;
    }

    if (current === undefined) {
      continue;
    }

    if (field === "allow" || field === "disallow") {
      collectingAgents = false;
      // An empty field means "no restriction"; browsers and crawlers treat it as a no-op.
      if (value.length === 0) {
        continue;
      }
      current.rules.push({ allow: field === "allow", path: value });
      continue;
    }

    if (field === "crawl-delay") {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) {
        current.crawlDelayMs = Math.round(delay * 1000);
      }
    }
  }

  return {
    groups: groups
      .filter((group) => group.agents.length > 0)
      .map((group) => ({
        agents: group.agents,
        rules: group.rules,
        ...(group.crawlDelayMs === undefined ? {} : { crawlDelayMs: group.crawlDelayMs }),
      })),
    sitemaps,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.?+^${}()|[\]\\]/gu, "\\$&");
}

function normalizePath(value: string): string {
  return value
    .replace(/[^\p{ASCII}]/gu, (character) => encodeURIComponent(character))
    .replace(/%[0-9a-f]{2}/giu, (encoded) => {
      const character = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
      return /[a-z0-9._~-]/iu.test(character) ? character : encoded.toUpperCase();
    });
}

/** Match a path and return rule specificity, excluding wildcard expansion. */
export function matchRobotsRule(pattern: string, path: string): number | undefined {
  const anchored = pattern.endsWith("$");
  const normalized = normalizePath(pattern);
  const body = (anchored ? normalized.slice(0, -1) : normalized).replaceAll("$", "%24");
  const source = body
    .split("*")
    .map((part) => escapeRegExp(part))
    .join(".*");
  const expression = new RegExp(`^${source}${anchored ? "$" : ""}`, "u");
  const requestPath = normalizePath(path).replaceAll("*", "%2A").replaceAll("$", "%24");
  return expression.test(requestPath)
    ? Buffer.byteLength(normalized.replace(/\*+$/u, ""))
    : undefined;
}

/**
 * Pick the group that applies to a user agent.
 *
 * A group whose token appears in the user agent string wins over `*`, and the longest matching
 * token wins among specific groups, which mirrors how crawlers resolve competing records.
 */
export function selectRobotsGroup(
  document: RobotsTxtDocument,
  userAgent: string,
): RobotsTxtGroup | undefined {
  const haystack = userAgent.toLowerCase();
  let bestScore = -1;
  let matches: RobotsTxtGroup[] = [];
  for (const group of document.groups) {
    const score = Math.max(
      -1,
      ...group.agents.map((agent) =>
        agent === "*" ? 0 : haystack.includes(agent) ? agent.length : -1,
      ),
    );
    if (score < 0 || score < bestScore) continue;
    if (score > bestScore) {
      bestScore = score;
      matches = [];
    }
    matches.push(group);
  }

  const first = matches[0];
  return first === undefined
    ? undefined
    : {
        ...first,
        agents: [...new Set(matches.flatMap((group) => group.agents))],
        rules: matches.flatMap((group) => group.rules),
      };
}

/**
 * Decide whether robots.txt lets one user agent request one path.
 *
 * The longest matching rule decides, and an `Allow` wins a tie, which is the behaviour crawlers
 * document for equally specific rules.
 */
export function robotsVerdict(
  document: RobotsTxtDocument,
  userAgent: string,
  path: string,
): RobotsVerdict {
  if (!document.fetched) {
    return { verdict: "unavailable" };
  }
  if (path === "/robots.txt") return { verdict: "allowed" };
  const group = selectRobotsGroup(document, userAgent);
  if (group === undefined) {
    return { verdict: "allowed" };
  }

  let decided: { readonly rule: RobotsTxtRule; readonly length: number } | undefined;
  for (const rule of group.rules) {
    const length = matchRobotsRule(rule.path, path);
    if (length === undefined) {
      continue;
    }
    if (decided === undefined || length > decided.length) {
      decided = { rule, length };
      continue;
    }
    // Equal specificity: an allow beats a disallow.
    if (length === decided.length && rule.allow) {
      decided = { rule, length };
    }
  }

  if (decided === undefined) {
    return { verdict: "allowed" };
  }
  return {
    verdict: decided.rule.allow ? "allowed" : "disallowed",
    matched: `${decided.rule.allow ? "Allow" : "Disallow"}: ${decided.rule.path}`,
  };
}

/**
 * Read one origin's robots.txt.
 *
 * A 4xx response is a legitimate "no robots.txt" and therefore allows everything. A 5xx or a
 * network failure leaves crawler behaviour undefined, so the document is marked unavailable and
 * analysis reports it rather than guessing.
 */
export async function fetchRobotsTxt(
  origin: string,
  options: RobotsFetchOptions = {},
): Promise<RobotsTxtDocument> {
  const url = `${origin}/robots.txt`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const Fetch = options.fetchImpl ?? fetch;

  try {
    const response = await Fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": options.userAgent ?? DISCOVERY_USER_AGENT,
        accept: "text/plain,*/*",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel();
      return { url, fetched: true, status: response.status, groups: [], sitemaps: [] };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return {
        url,
        fetched: false,
        status: response.status,
        groups: [],
        sitemaps: [],
        error: `robots.txt answered HTTP ${response.status}`,
      };
    }

    const buffer = await readBody(response, maxBytes);
    const parsed = parseRobotsTxt(buffer.toString("utf8"));
    return {
      url,
      fetched: true,
      status: response.status,
      groups: parsed.groups,
      sitemaps: parsed.sitemaps,
    };
  } catch (error) {
    return {
      url,
      fetched: false,
      groups: [],
      sitemaps: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read robots.txt once per origin with a bounded number of requests. */
export async function collectRobotsTxt(
  origins: readonly string[],
  options: RobotsFetchOptions = {},
  concurrency = 4,
): Promise<ReadonlyMap<string, RobotsTxtDocument>> {
  const unique = [...new Set(origins)];
  const documents = new Map<string, RobotsTxtDocument>();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
      while (cursor < unique.length) {
        const origin = unique[cursor++];
        if (origin !== undefined) documents.set(origin, await fetchRobotsTxt(origin, options));
      }
    }),
  );
  return documents;
}

/** Build the per-probe evidence record for one agent and URL. */
export function robotsEvidenceFor(
  document: RobotsTxtDocument | undefined,
  userAgent: string,
  url: string,
): RobotsTxtEvidence | undefined {
  if (document === undefined) {
    return undefined;
  }
  const path = `${new URL(url).pathname}${new URL(url).search}`;
  const verdict = robotsVerdict(document, userAgent, path);
  return {
    url: document.url,
    fetched: document.fetched,
    ...(document.status === undefined ? {} : { status: document.status }),
    verdict: verdict.verdict,
    ...(verdict.matched === undefined ? {} : { matched: verdict.matched }),
    ...(document.error === undefined ? {} : { error: document.error }),
  };
}
