import { createServer, type Server } from "node:http";
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
      summary: { errors: number; incomplete: number; probes: number };
      results: Array<{ probes: Array<{ status: number }> }>;
    };
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
});
