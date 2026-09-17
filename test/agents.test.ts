import { describe, expect, it } from "vitest";
import { resolveAgent, resolveAgents } from "../src/agents.js";

describe("built-in crawler profiles", () => {
  it("resolves AI crawler keys and aliases", () => {
    expect(resolveAgent("gptbot")).toMatchObject({ key: "gptbot", requiresHeadMetadata: false });
    expect(resolveAgent("Claude")).toMatchObject({ key: "claudebot" });
    expect(resolveAgent("oai-searchbot")).toMatchObject({ key: "oai-searchbot" });
    expect(resolveAgent("perplexity")).toMatchObject({ key: "perplexitybot" });
    expect(resolveAgent("chatgpt-user").userAgent).toContain("ChatGPT-User");
  });

  it("keeps every crawler product token in its user agent", () => {
    for (const [input, token] of [
      ["gptbot", "GPTBot/"],
      ["oai-searchbot", "OAI-SearchBot/"],
      ["chatgpt-user", "ChatGPT-User/"],
      ["claudebot", "ClaudeBot/"],
      ["perplexitybot", "PerplexityBot/"],
      ["googlebot", "Googlebot/"],
    ] as const) {
      expect(resolveAgent(input).userAgent).toContain(token);
    }
  });

  it("rejects unknown profiles with the available names", () => {
    expect(() => resolveAgent("megabot")).toThrow(/gptbot/u);
  });

  it("rejects duplicate keys in one run", () => {
    expect(() => resolveAgents(["gptbot", "openai"])).toThrow(/Duplicate agent key/u);
  });
});
