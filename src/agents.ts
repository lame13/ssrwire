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
  // AI crawler profiles. These request and parse HTML without executing JavaScript, but they
  // read the whole document, so they are not head-only parsers. User-agent strings carry the
  // published product token, which is what user-agent branching on a target actually matches;
  // the surrounding browser tokens and version numbers change over time.
  gptbot: Object.freeze({
    key: "gptbot",
    label: "GPTBot (OpenAI)",
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot",
    requiresHeadMetadata: false,
  }),
  "oai-searchbot": Object.freeze({
    key: "oai-searchbot",
    label: "OAI-SearchBot (OpenAI)",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
    requiresHeadMetadata: false,
  }),
  "chatgpt-user": Object.freeze({
    key: "chatgpt-user",
    label: "ChatGPT-User (OpenAI)",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    requiresHeadMetadata: false,
  }),
  claudebot: Object.freeze({
    key: "claudebot",
    label: "ClaudeBot (Anthropic)",
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com",
    requiresHeadMetadata: false,
  }),
  perplexitybot: Object.freeze({
    key: "perplexitybot",
    label: "PerplexityBot",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot",
    requiresHeadMetadata: false,
  }),
});

export type BuiltinAgentKey =
  | "browser"
  | "googlebot"
  | "bingbot"
  | "twitterbot"
  | "facebook"
  | "gptbot"
  | "oai-searchbot"
  | "chatgpt-user"
  | "claudebot"
  | "perplexitybot";
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
  gpt: "gptbot",
  gptbot: "gptbot",
  openai: "gptbot",
  "oai-searchbot": "oai-searchbot",
  oaisearchbot: "oai-searchbot",
  searchbot: "oai-searchbot",
  "chatgpt-user": "chatgpt-user",
  chatgptuser: "chatgpt-user",
  chatgpt: "chatgpt-user",
  claude: "claudebot",
  claudebot: "claudebot",
  anthropic: "claudebot",
  perplexity: "perplexitybot",
  perplexitybot: "perplexitybot",
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
        `Unknown agent "${input}". Use a built-in profile such as browser, googlebot, bingbot, ` +
          "twitterbot, facebook, gptbot, oai-searchbot, chatgpt-user, claudebot, perplexitybot, " +
          "or a custom agent object.",
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
