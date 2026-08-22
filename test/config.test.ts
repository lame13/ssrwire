import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig, parseHeaderOption } from "../src/config.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ssrwire-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("loadConfig", () => {
  it("loads strict YAML, interpolates headers, and normalizes targets", async () => {
    const cwd = await temporaryDirectory();
    vi.stubEnv("PREVIEW_TOKEN", "secret-value");
    await writeFile(
      join(cwd, "ssrwire.config.yml"),
      `targets:
  - url: https://example.com/path#section
    expectedStatus: [200, 404, 200]
    require:
      description: false
agents:
  - browser
  - key: social-preview
    userAgent: PreviewBot/1.0
    requiresHeadMetadata: true
headers:
  Authorization: Bearer \${PREVIEW_TOKEN}
timeoutMs: 5000
`,
    );

    const config = await loadConfig({ cwd });

    expect(config.targets[0]?.url).toBe("https://example.com/path");
    expect(config.targets[0]?.expectations.statuses).toEqual([200, 404]);
    expect(config.targets[0]?.expectations.requireDescription).toBe(false);
    expect(config.agents.map((agent) => agent.key)).toEqual(["browser", "social-preview"]);
    expect(new Map(Object.entries(config.headers)).get("authorization")).toBe(
      "Bearer secret-value",
    );
    expect(config.timeoutMs).toBe(5000);
  });

  it("rejects unknown configuration keys", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(
      join(cwd, "ssrwire.config.yml"),
      "targets: [https://example.com]\nmagicalCrawlerMode: true\n",
    );

    await expect(loadConfig({ cwd })).rejects.toThrow(/unrecognized|Invalid configuration/i);
  });

  it("does not echo malformed configuration content", async () => {
    const cwd = await temporaryDirectory();
    const secret = "do-not-print-this-token";
    await writeFile(
      join(cwd, "ssrwire.config.yml"),
      `targets: [https://example.com]\nheaders: [${secret}\n`,
    );

    await expect(loadConfig({ cwd })).rejects.toThrow("Could not parse configuration file.");
    try {
      await loadConfig({ cwd });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("rejects missing environment variables without exposing header content", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(
      join(cwd, "ssrwire.config.yml"),
      "targets: [https://example.com]\nheaders:\n  Authorization: Bearer $" + "{MISSING_TOKEN}\n",
    );

    await expect(loadConfig({ cwd })).rejects.toThrow("Environment variable MISSING_TOKEN");
  });

  it("combines config and command-line targets without duplicates", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(
      join(cwd, "ssrwire.config.json"),
      JSON.stringify({ targets: ["https://example.com/a"] }),
    );

    const config = await loadConfig({
      cwd,
      urls: ["https://example.com/a", "https://example.com/b"],
      agents: ["browser"],
    });

    expect(config.targets.map((target) => target.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("rejects transport headers managed by the probe", () => {
    expect(() => parseHeaderOption("Accept-Encoding: gzip")).toThrow(/managed by SSRWire/u);
  });

  it("rejects embedded URL credentials and managed headers", async () => {
    await expect(loadConfig({ urls: ["https://user:pass@example.com"] })).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect(() => parseHeaderOption("Host: attacker.example")).toThrow(/managed/);
    expect(() => parseHeaderOption("Broken header")).toThrow(/form/);
  });
});
