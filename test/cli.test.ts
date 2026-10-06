import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

/** A page that is complete except for its canonical link, so findings are produced. */
/**
 * SSRWire reads /robots.txt once per origin. Fixtures that count requests answer it explicitly
 * with a 404, which models a site that has no robots.txt at all.
 */
function serveNoRobots(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.url !== "/robots.txt") {
    return false;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
  return true;
}

async function servePageWithoutCanonical(): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><head>
        <title>Incomplete fixture</title>
        <meta name="description" content="A fixture without a canonical link">
      </head><body><main><h1>Fixture heading</h1><p>Useful main content.</p></main></body></html>`);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not bind.");
  }
  return `http://127.0.0.1:${address.port}/page`;
}

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
    expect(report.schemaVersion).toBe(2);
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

  it("writes a readable HTML report with framework fix recipes", async () => {
    const url = await servePageWithoutCanonical();
    const directory = await mkdtemp(join(tmpdir(), "ssrwire-cli-html-"));
    const reportPath = join(directory, "ssrwire.html");

    await main([
      "node",
      "ssrwire",
      url,
      "--agent",
      "browser",
      "--agent",
      "gptbot",
      "--format",
      "html",
      "--output",
      reportPath,
      "--framework",
      "nextjs",
    ]);

    const report = await readFile(reportPath, "utf8");
    expect(report.startsWith("<!doctype html>")).toBe(true);
    expect(report).toContain("No canonical URL");
    expect(report).toContain("The page works, with room to improve");
    expect(report).toContain("GPTBot (OpenAI)");
    expect(report).toContain("Next.js example");
    expect(report).not.toContain("<script");
    expect(stderr).toContain("SSRWire wrote html report");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("describes the check formats and framework option in help output", async () => {
    await main(["node", "ssrwire", "check", "--help"]);

    expect(stdout).toContain("--framework <name>");
    expect(stdout).toContain("junit");
    expect(stdout).toContain("--sitemap <source>");
    expect(stdout).toContain("--baseline <path>");
    expect(stdout).toContain("--concurrency <count>");
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
    await main(["node", "ssrwire", "https://example.com", "--format", "yaml"]);
    expect(stderr).toContain("Expected terminal, json, sarif, html, junit, markdown, or github");
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
      if (serveNoRobots(incoming, response)) return;
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

describe("CLI baselines, sitemaps, and waivers", () => {
  it("rejects output paths that would overwrite the baseline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ssrwire-baseline-clash-"));
    const path = join(directory, "baseline.json");
    try {
      await writeFile(path, "keep this baseline");
      await main(["node", "ssrwire", "https://example.com/", "--baseline", path, "--output", path]);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain("different paths");
      expect(await readFile(path, "utf8")).toBe("keep this baseline");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the existing baseline when an update has incomplete probes", async () => {
    server = createServer((request, response) => {
      if (serveNoRobots(request, response)) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    const directory = await mkdtemp(join(tmpdir(), "ssrwire-baseline-incomplete-"));
    const path = join(directory, "baseline.json");
    try {
      await writeFile(path, "keep this baseline");
      await main([
        "node",
        "ssrwire",
        `http://127.0.0.1:${address.port}/`,
        "--agent",
        "browser",
        "--baseline",
        path,
        "--update-baseline",
      ]);
      expect(process.exitCode).toBe(2);
      expect(stderr).toContain("baseline was not updated");
      expect(await readFile(path, "utf8")).toBe("keep this baseline");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("records a baseline, compares against it, and fails on a regression", async () => {
    const url = await servePageWithoutCanonical();
    const directory = await mkdtemp(join(tmpdir(), "ssrwire-cli-baseline-"));
    const baselinePath = join(directory, "ssrwire.baseline.json");

    try {
      await main([
        "node",
        "ssrwire",
        url,
        "--agent",
        "browser",
        "--format",
        "json",
        "--baseline",
        baselinePath,
        "--update-baseline",
      ]);

      const stored = JSON.parse(await readFile(baselinePath, "utf8")) as {
        schemaVersion: number;
        results: Array<{ findings: readonly unknown[] }>;
      };
      expect(stored.schemaVersion).toBe(2);
      expect(stored.results[0]?.findings.length).toBeGreaterThan(0);

      // An unchanged run matches the baseline it just recorded.
      stdout = "";
      stderr = "";
      process.exitCode = undefined;
      await main([
        "node",
        "ssrwire",
        url,
        "--agent",
        "browser",
        "--format",
        "json",
        "--baseline",
        baselinePath,
      ]);
      expect(stderr).toContain("0 regression");
      expect(process.exitCode ?? 0).toBe(0);

      // Rewriting the baseline without its findings turns them into regressions next run.
      const clean = JSON.parse(await readFile(baselinePath, "utf8")) as {
        results: Array<{ findings: readonly unknown[] }>;
        summary: Record<string, number>;
      };
      clean.results[0] = { ...clean.results[0], findings: [] } as never;
      clean.summary = { ...clean.summary, errors: 0, warnings: 0, info: 0 };
      await writeFile(baselinePath, JSON.stringify(clean));

      stdout = "";
      stderr = "";
      process.exitCode = undefined;
      await main([
        "node",
        "ssrwire",
        url,
        "--agent",
        "browser",
        "--format",
        "json",
        "--baseline",
        baselinePath,
      ]);

      expect(stderr).toContain("regression(s) against");
      expect(process.exitCode).toBe(1);

      stdout = "";
      await main([
        "node",
        "ssrwire",
        url,
        "--agent",
        "browser",
        "--format",
        "html",
        "--baseline",
        baselinePath,
      ]);
      expect(stdout).toContain("exit code 1");
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("discovers targets from a sitemap and derives their ids from the path", async () => {
    server = createServer((request, response) => {
      if (serveNoRobots(request, response)) return;
      const origin = `http://${request.headers.host}`;
      if (request.url === "/sitemap.xml") {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(
          `<?xml version="1.0" encoding="UTF-8"?><urlset>` +
            `<url><loc>${origin}/alpha</loc></url>` +
            `<url><loc>${origin}/beta</loc></url>` +
            `</urlset>`,
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>Fixture</title>` +
          `<meta name="description" content="Fixture page">` +
          `<link rel="canonical" href="${origin}${request.url}"></head>` +
          "<body><main><h1>Fixture</h1><p>Content.</p></main></body></html>",
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    const origin = `http://127.0.0.1:${address.port}`;

    await main([
      "node",
      "ssrwire",
      "check",
      "--sitemap",
      `${origin}/sitemap.xml`,
      "--agent",
      "browser",
      "--format",
      "json",
    ]);

    const report = JSON.parse(stdout) as {
      results: Array<{ target: { id?: string; url: string } }>;
    };
    expect(report.results.map((entry) => entry.target.id)).toEqual(["alpha", "beta"]);
    expect(report.results.map((entry) => entry.target.url)).toEqual([
      `${origin}/alpha`,
      `${origin}/beta`,
    ]);
  });

  it("honours --sitemap-exclude and reports the reduced target set", async () => {
    server = createServer((request, response) => {
      if (serveNoRobots(request, response)) return;
      const origin = `http://${request.headers.host}`;
      if (request.url === "/sitemap.xml") {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(
          `<?xml version="1.0" encoding="UTF-8"?><urlset>` +
            `<url><loc>${origin}/keep</loc></url>` +
            `<url><loc>${origin}/draft/one</loc></url>` +
            `</urlset>`,
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>Fixture</title>` +
          `<meta name="description" content="Fixture page">` +
          `<link rel="canonical" href="${origin}${request.url}"></head>` +
          "<body><main><h1>Fixture</h1><p>Content.</p></main></body></html>",
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    const origin = `http://127.0.0.1:${address.port}`;

    await main([
      "node",
      "ssrwire",
      "check",
      "--sitemap",
      `${origin}/sitemap.xml`,
      "--sitemap-exclude",
      "/draft/*",
      "--agent",
      "browser",
      "--format",
      "json",
    ]);

    const report = JSON.parse(stdout) as { results: Array<{ target: { id?: string } }> };
    expect(report.results.map((entry) => entry.target.id)).toEqual(["keep"]);
  });

  it("keeps waived findings out of the exit code and reports the count", async () => {
    const url = await servePageWithoutCanonical();
    const directory = await mkdtemp(join(tmpdir(), "ssrwire-cli-waiver-"));
    const configPath = join(directory, "ssrwire.config.yml");
    const base = `targets:
  - id: fixture
    url: ${url}
agents:
  - browser
`;
    await writeFile(configPath, base);

    try {
      // Without the waiver the warning is a failure under --fail-on warning.
      await main([
        "node",
        "ssrwire",
        "check",
        "--config",
        configPath,
        "--format",
        "json",
        "--fail-on",
        "warning",
      ]);
      expect(process.exitCode ?? 0).toBe(1);

      await writeFile(
        configPath,
        `${base}ignore:
  - code: missing-canonical
    target: fixture
    reason: canonical is injected by the edge
`,
      );

      stdout = "";
      stderr = "";
      process.exitCode = undefined;
      await main([
        "node",
        "ssrwire",
        "check",
        "--config",
        configPath,
        "--format",
        "json",
        "--fail-on",
        "warning",
      ]);
      const report = JSON.parse(stdout) as {
        summary: { waived?: number; warnings: number };
        waivers: readonly { code: string; reason: string }[];
      };
      expect(report.summary.waived).toBe(1);
      expect(report.summary.warnings).toBe(0);
      expect(report.waivers[0]).toMatchObject({
        code: "missing-canonical",
        reason: "canonical is injected by the edge",
      });
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a waiver that no longer matches anything", async () => {
    const url = await serveHealthyPage();
    const directory = await mkdtemp(join(tmpdir(), "ssrwire-cli-stale-waiver-"));
    const configPath = join(directory, "ssrwire.config.yml");
    await writeFile(
      configPath,
      `targets:
  - id: fixture
    url: ${url}
agents:
  - browser
ignore:
  - code: missing-canonical
    target: fixture
    reason: canonical is injected by the edge
`,
    );

    try {
      await main(["node", "ssrwire", "check", "--config", configPath, "--format", "json"]);
      const report = JSON.parse(stdout) as {
        results: Array<{ findings: readonly { code: string; severity: string }[] }>;
      };

      expect(report.results[0]?.findings).toContainEqual(
        expect.objectContaining({ code: "waiver-unused", severity: "info" }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits Markdown, JUnit, and GitHub annotation reports", async () => {
    const url = await servePageWithoutCanonical();

    await main(["node", "ssrwire", url, "--agent", "browser", "--format", "markdown"]);
    expect(stdout).toContain("## SSRWire");
    expect(stdout).toContain("missing-canonical");

    stdout = "";
    process.exitCode = undefined;
    await main(["node", "ssrwire", url, "--agent", "browser", "--format", "junit"]);
    expect(stdout).toContain("<testsuites");
    expect(stdout).toContain("<failure");

    stdout = "";
    process.exitCode = undefined;
    await main(["node", "ssrwire", url, "--agent", "browser", "--format", "github"]);
    expect(stdout).toContain("::warning title=");
  });
});
