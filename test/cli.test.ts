import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

let server: Server | undefined;
let stdout = "";
let stderr = "";

beforeEach(() => {
  stdout = "";
  stderr = "";
  process.exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (server) {
    const active = server;
    server = undefined;
    await new Promise<void>((resolve, reject) =>
      active.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function serveHealthyPage(): Promise<string> {
  server = createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><head>
        <title>SSRWire fixture</title>
        <meta name="description" content="A complete fixture">
        <meta name="robots" content="index,follow">
        <link rel="canonical" href="${origin}/page">
        <meta property="og:title" content="SSRWire fixture preview">
        <meta property="og:type" content="website">
        <meta property="og:url" content="${origin}/page">
        <meta property="og:image" content="${origin}/preview.jpg">
        <meta property="og:description" content="A complete social fixture">
        <meta name="twitter:card" content="summary_large_image">
        <script type="application/ld+json">{"@type":"Article"}</script>
      </head><body><main><h1>Fixture heading</h1><p>Useful main content.</p></main></body></html>`);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not bind.");
  }
  return `http://127.0.0.1:${address.port}/page`;
}

describe("CLI", () => {
  it("runs a real audit and emits machine-readable JSON", async () => {
    const url = await serveHealthyPage();

    await main(["node", "ssrwire", url, "--agent", "browser", "--format", "json"]);

    const report = JSON.parse(stdout) as {
      schemaVersion: number;
      summary: { errors: number; incomplete: number; probes: number };
      results: Array<{ probes: Array<{ status: number }> }>;
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.summary).toMatchObject({ errors: 0, incomplete: 0, probes: 1 });
    expect(report.results[0]?.probes[0]?.status).toBe(200);
    expect(stderr).toBe("");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("applies options passed to the explicit check subcommand", async () => {
    const url = await serveHealthyPage();

    await main([
      "node",
      "ssrwire",
      "check",
      url,
      "--agent",
      "browser",
      "--format",
      "json",
      "--timeout",
      "2000",
    ]);

    const report = JSON.parse(stdout) as {
      results: Array<{ probes: Array<{ agent: { key: string } }> }>;
      summary: { probes: number };
    };
    expect(report.summary.probes).toBe(1);
    expect(report.results[0]?.probes[0]?.agent.key).toBe("browser");
    expect(stderr).toBe("");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("enforces social-preview contracts from strict YAML configuration", async () => {
    const url = await serveHealthyPage();
    const directory = await mkdtemp(join(tmpdir(), "ssrwire-cli-social-"));
    const configPath = join(directory, "ssrwire.config.yml");
    await writeFile(
      configPath,
      `targets:
  - url: ${url}
    require:
      openGraph: true
      twitterCard: true
agents: [browser]
`,
    );

    try {
      await main(["node", "ssrwire", "check", "--config", configPath, "--format", "json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const report = JSON.parse(stdout) as {
      results: Array<{
        findings: Array<{ code: string }>;
        probes: Array<{ signals: { socialMetadata: Array<{ property: string }> } }>;
      }>;
    };
    expect(report.results[0]?.findings).toEqual([]);
    expect(report.results[0]?.probes[0]?.signals.socialMetadata).toHaveLength(6);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("uses setup exit code 2 for invalid input", async () => {
    await main(["node", "ssrwire", "ftp://example.com"]);

    expect(stderr).toContain("must use HTTP or HTTPS");
    expect(process.exitCode).toBe(2);
  });

  it("uses setup exit code 2 for command-line syntax errors", async () => {
    await main(["node", "ssrwire", "--timeout", "not-a-number"]);

    expect(stderr).toContain("Expected an integer");
    expect(process.exitCode).toBe(2);
  });

  it("keeps check and comparison format and failure policies separate", async () => {
    await main(["node", "ssrwire", "https://example.com", "--format", "html"]);
    expect(stderr).toContain("Expected terminal, json, or sarif");
    expect(process.exitCode).toBe(2);

    stdout = "";
    stderr = "";
    process.exitCode = undefined;
    await main([
      "node",
      "ssrwire",
      "compare",
      "baseline.json",
      "candidate.json",
      "--fail-on",
      "error",
    ]);
    expect(stderr).toContain("Expected regression or never");
    expect(process.exitCode).toBe(2);
  });

  it("runs the requested number of sequential samples", async () => {
    const url = await serveHealthyPage();

    await main(["node", "ssrwire", url, "--agent", "browser", "--repeat", "3", "--format", "json"]);

    const report = JSON.parse(stdout) as {
      repeat: number;
      summary: { probes: number };
      results: Array<{ probes: Array<{ sample: number }> }>;
    };
    expect(report.repeat).toBe(3);
    expect(report.summary.probes).toBe(3);
    expect(report.results[0]?.probes.map((probe) => probe.sample)).toEqual([1, 2, 3]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("does not fail on informational body drift but honors warning policy", async () => {
    let request = 0;
    let varyTitle = false;
    server = createServer((incoming, response) => {
      request += 1;
      const origin = `http://${incoming.headers.host}`;
      const title = varyTitle ? `SSRWire fixture ${request}` : "SSRWire fixture";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html><head>
          <title>${title}</title>
          <meta name="description" content="A complete fixture">
          <link rel="canonical" href="${origin}/page">
        </head><body><main><h1>Fixture heading</h1><p>Useful main content.</p></main>
        <!-- sample ${request} --></body></html>`);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    const url = `http://127.0.0.1:${address.port}/page`;

    await main([
      "node",
      "ssrwire",
      url,
      "--agent",
      "browser",
      "--repeat",
      "2",
      "--format",
      "json",
      "--fail-on",
      "warning",
    ]);

    const informational = JSON.parse(stdout) as {
      results: Array<{ findings: Array<{ code: string; severity: string }> }>;
    };
    expect(informational.results[0]?.findings).toContainEqual(
      expect.objectContaining({ code: "stream-instability", severity: "info" }),
    );
    expect(process.exitCode ?? 0).toBe(0);

    stdout = "";
    stderr = "";
    process.exitCode = undefined;
    request = 0;
    varyTitle = true;

    await main([
      "node",
      "ssrwire",
      url,
      "--agent",
      "browser",
      "--repeat",
      "2",
      "--format",
      "json",
      "--fail-on",
      "warning",
    ]);

    const warning = JSON.parse(stdout) as {
      results: Array<{ findings: Array<{ code: string; severity: string }> }>;
    };
    expect(warning.results[0]?.findings).toContainEqual(
      expect.objectContaining({ code: "stream-instability", severity: "warning" }),
    );
    expect(stderr).toBe("");
    expect(process.exitCode).toBe(1);
  });

  it("rejects an out-of-range repeat count", async () => {
    await main(["node", "ssrwire", "https://example.com", "--repeat", "11"]);

    expect(stderr).toContain("repeat must be an integer between 1 and 10");
    expect(process.exitCode).toBe(2);
  });

  it("compares JSON reports, fails on regressions, and writes self-contained HTML", async () => {
    const url = await serveHealthyPage();
    await main(["node", "ssrwire", url, "--agent", "browser", "--format", "json"]);
    const baselineText = stdout;
    const candidate = JSON.parse(baselineText) as {
      results: Array<{
        findings: Array<{
          code: string;
          severity: string;
          message: string;
          url: string;
          agent?: string;
        }>;
      }>;
    };
    candidate.results[0]?.findings.push({
      code: "new-regression",
      severity: "error",
      message: "Candidate introduced a regression.",
      url,
      agent: "browser",
    });

    const directory = await mkdtemp(join(tmpdir(), "ssrwire-cli-compare-"));
    const baselinePath = join(directory, "production.json");
    const candidatePath = join(directory, "preview.json");
    const htmlPath = join(directory, "comparison.html");
    await writeFile(baselinePath, baselineText);
    await writeFile(candidatePath, JSON.stringify(candidate));

    try {
      stdout = "";
      stderr = "";
      process.exitCode = undefined;
      await main(["node", "ssrwire", "compare", baselinePath, candidatePath, "--format", "json"]);

      const comparison = JSON.parse(stdout) as {
        kind: string;
        summary: { regressions: number };
      };
      expect(comparison).toMatchObject({ kind: "comparison", summary: { regressions: 1 } });
      expect(process.exitCode).toBe(1);

      stdout = "";
      stderr = "";
      process.exitCode = undefined;
      await main([
        "node",
        "ssrwire",
        "compare",
        baselinePath,
        candidatePath,
        "--format",
        "html",
        "--output",
        htmlPath,
        "--fail-on",
        "never",
      ]);

      expect(await readFile(htmlPath, "utf8")).toContain("Wire waterfall");
      expect(stderr).toContain("wrote html comparison");
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
