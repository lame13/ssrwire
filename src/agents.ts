import type { AgentProfile } from "./types.js";

export const BUILTIN_AGENTS: Readonly<Record<string, AgentProfile>> = Object.freeze({
  browser: Object.freeze({
    key: "browser",
    label: "Browser",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    requiresHeadMetadata: false,
  }),
  googlebot: Object.freeze({
    key: "googlebot",
    label: "Googlebot",
    userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    requiresHeadMetadata: false,
  }),
  bingbot: Object.freeze({
    key: "bingbot",
    label: "Bingbot",
    userAgent: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    requiresHeadMetadata: true,
  }),
  twitterbot: Object.freeze({
    key: "twitterbot",
    label: "Twitterbot",
    userAgent: "Twitterbot/1.0",
    requiresHeadMetadata: true,
  }),
  facebook: Object.freeze({
    key: "facebook",
    label: "Facebook crawler",
    userAgent: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    requiresHeadMetadata: true,
  }),
});

export type BuiltinAgentKey = "browser" | "googlebot" | "bingbot" | "twitterbot" | "facebook";
export type AgentInput =
  | string
  | {
      readonly key: string;
      readonly label?: string;
      readonly userAgent: string;
      readonly requiresHeadMetadata?: boolean;
    };

const ALIASES: Readonly<Record<string, BuiltinAgentKey>> = Object.freeze({
  browser: "browser",
  chrome: "browser",
  google: "googlebot",
  googlebot: "googlebot",
  bing: "bingbot",
  bingbot: "bingbot",
  twitter: "twitterbot",
  twitterbot: "twitterbot",
  x: "twitterbot",
  facebook: "facebook",
  facebookbot: "facebook",
  facebookexternalhit: "facebook",
});

function isCustomAgent(value: unknown): value is Exclude<AgentInput, string> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly key?: unknown;
    readonly label?: unknown;
    readonly userAgent?: unknown;
    readonly requiresHeadMetadata?: unknown;
  };
  return (
    typeof candidate.key === "string" &&
    candidate.key.trim().length > 0 &&
    typeof candidate.userAgent === "string" &&
    candidate.userAgent.trim().length > 0 &&
    (candidate.label === undefined ||
      (typeof candidate.label === "string" && candidate.label.trim().length > 0)) &&
    (candidate.requiresHeadMetadata === undefined ||
      typeof candidate.requiresHeadMetadata === "boolean")
  );
}

/** Resolve a built-in key/alias or validate a complete custom agent profile. */
export function resolveAgent(input: AgentInput): AgentProfile {
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    const key = ALIASES[normalized];
    if (key === undefined) {
      throw new Error(
        `Unknown agent "${input}". Use browser, googlebot, bingbot, twitterbot, facebook, or a custom agent object.`,
      );
    }
    const agent = BUILTIN_AGENTS[key];
    if (agent === undefined) {
      throw new Error(`Built-in agent "${key}" is unavailable.`);
    }
    return agent;
  }

  if (!isCustomAgent(input)) {
    throw new TypeError(
      "Custom agents require non-empty key and userAgent strings; label and requiresHeadMetadata are optional.",
    );
  }

  if (/[\r\n]/u.test(input.userAgent)) {
    throw new TypeError("Custom agent userAgent cannot contain a line break.");
  }

  return Object.freeze({
    key: input.key.trim(),
    label: input.label?.trim() ?? input.key.trim(),
    userAgent: input.userAgent.trim(),
    requiresHeadMetadata: input.requiresHeadMetadata ?? false,
  });
}

/** Resolve an ordered list and reject duplicate keys, which would make reports ambiguous. */
export function resolveAgents(inputs: readonly AgentInput[]): AgentProfile[] {
  const resolved = inputs.map(resolveAgent);
  const seen = new Set<string>();
  for (const agent of resolved) {
    const normalized = agent.key.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`Duplicate agent key "${agent.key}".`);
    }
    seen.add(normalized);
  }
  return resolved;
}
