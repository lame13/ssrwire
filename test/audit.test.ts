import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../src/agents.js";
import { runAudit } from "../src/audit.js";
import type { SsrWireConfig } from "../src/types.js";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  const active = server;
  server = undefined;
  active.closeAllConnections();
  await new Promise<void>((resolve) => active.close(() => resolve()));
});

describe("runAudit", () => {
  it("analyzes raw protected-preview evidence before redacting the complete report", async () => {
    const secret = "preview-secret-741";
    let receivedSecret = 0;
    server = createServer((request, response) => {
      if (request.headers["x-preview-token"] === secret) receivedSecret += 1;
      const origin = `http://${request.headers.host}`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<html><head><title>Preview ${secret}</title>` +
          '<meta name="description" content="Protected preview">' +
          `<link rel="canonical" href="${origin}/${secret}"></head>` +
          "<body><main><h1>Preview</h1><p>Ready.</p></main></body></html>",
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    const url = `http://127.0.0.1:${address.port}/${secret}`;
    const config: SsrWireConfig = {
      targets: [
        {
          url,
          expectations: {
            statuses: [200],
            finalUrl: url,
            requireTitle: true,
            requireDescription: true,
            requireCanonical: true,
            requireH1: true,
            requireMainText: true,
          },
        },
      ],
      agents: [resolveAgent("browser")],
      headers: { "x-preview-token": secret },
      timeoutMs: 2_000,
      maxBytes: 100_000,
      maxRedirects: 4,
      repeat: 2,
    };

    const audit = await runAudit(config);
    const serialized = JSON.stringify(audit);

    expect(receivedSecret).toBe(2);
    expect(audit.summary).toMatchObject({ errors: 0, warnings: 0, incomplete: 0 });
    expect(audit.repeat).toBe(2);
    expect(audit.results[0]?.probes.map((probe) => probe.sample)).toEqual([1, 2]);
    expect(audit.results[0]?.stability).toHaveLength(1);
    expect(
      audit.results[0]?.findings.some((finding) => finding.code === "final-url-mismatch"),
    ).toBe(false);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("runs samples sequentially within one target-agent lane", async () => {
    let active = 0;
    let maximumActive = 0;
    let requests = 0;
    server = createServer((request, response) => {
      requests += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const origin = `http://${request.headers.host}`;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<html><head><title>Stable</title><meta name="description" content="Ready">` +
            `<link rel="canonical" href="${origin}/page"></head>` +
            "<body><main><h1>Stable</h1><p>Ready.</p></main></body></html>",
          () => {
            active -= 1;
          },
        );
      }, 10);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    const url = `http://127.0.0.1:${address.port}/page`;

    const audit = await runAudit({
      targets: [
        {
          url,
          expectations: {
            statuses: [200],
            requireTitle: true,
            requireDescription: true,
            requireCanonical: true,
            requireH1: true,
            requireMainText: true,
          },
        },
      ],
      agents: [resolveAgent("browser")],
      headers: {},
      timeoutMs: 2_000,
      maxBytes: 100_000,
      maxRedirects: 4,
      repeat: 3,
    });

    expect(requests).toBe(3);
    expect(maximumActive).toBe(1);
    expect(audit.results[0]?.probes.map((probe) => probe.sample)).toEqual([1, 2, 3]);
    expect(audit.summary.probes).toBe(3);
  });

  it("coalesces the same policy finding across samples", async () => {
    server = createServer((request, response) => {
      const origin = `http://${request.headers.host}`;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<html><head><title>Stable</title><link rel="canonical" href="${origin}/page"></head>` +
          "<body><main><h1>Stable</h1><p>Ready.</p></main></body></html>",
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    const url = `http://127.0.0.1:${address.port}/page`;

    const audit = await runAudit({
      targets: [
        {
          url,
          expectations: {
            statuses: [200],
            requireTitle: true,
            requireDescription: true,
            requireCanonical: true,
            requireH1: true,
            requireMainText: true,
          },
        },
      ],
      agents: [resolveAgent("browser")],
      headers: {},
      timeoutMs: 2_000,
      maxBytes: 100_000,
      maxRedirects: 4,
      repeat: 3,
    });

    const findings = audit.results[0]?.findings.filter(
      (finding) => finding.code === "missing-description",
    );
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.evidence).toMatchObject({
      sampleNumbers: "1, 2, 3",
      occurrences: 3,
      totalSamples: 3,
    });
    expect(audit.summary.warnings).toBe(1);
  });

  it("reports repeat variation per agent without mislabeling it as crawler-agent drift", async () => {
    const requestsByAgent = new Map<string, number>();
    server = createServer((incoming, response) => {
      const userAgent = incoming.headers["user-agent"] ?? "";
      const agent = userAgent.includes("Googlebot") ? "googlebot" : "browser";
      const request = (requestsByAgent.get(agent) ?? 0) + 1;
      requestsByAgent.set(agent, request);
      const origin = `http://${incoming.headers.host}`;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<html><head><title>Version ${request}</title>` +
          '<meta name="description" content="Ready">' +
          `<link rel="canonical" href="${origin}/page"></head>` +
          "<body><main><h1>Stable</h1><p>Ready.</p></main></body></html>",
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    const url = `http://127.0.0.1:${address.port}/page`;

    const audit = await runAudit({
      targets: [
        {
          url,
          expectations: {
            statuses: [200],
            requireTitle: true,
            requireDescription: true,
            requireCanonical: true,
            requireH1: true,
            requireMainText: true,
          },
        },
      ],
      agents: [resolveAgent("browser"), resolveAgent("googlebot")],
      headers: {},
      timeoutMs: 2_000,
      maxBytes: 100_000,
      maxRedirects: 4,
      repeat: 2,
    });

    const findings = audit.results[0]?.findings ?? [];
    expect(
      findings
        .filter((finding) => finding.code === "stream-instability")
        .map((finding) => finding.agent),
    ).toEqual(["browser", "googlebot"]);
    expect(findings.some((finding) => finding.code.startsWith("agent-"))).toBe(false);
  });

  it("preserves crawler-agent drift when each agent is stable across samples", async () => {
    server = createServer((incoming, response) => {
      const userAgent = incoming.headers["user-agent"] ?? "";
      const title = userAgent.includes("Googlebot") ? "Google title" : "Browser title";
      const origin = `http://${incoming.headers.host}`;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<html><head><title>${title}</title>` +
          '<meta name="description" content="Ready">' +
          `<link rel="canonical" href="${origin}/page"></head>` +
          "<body><main><h1>Stable</h1><p>Ready.</p></main></body></html>",
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    const url = `http://127.0.0.1:${address.port}/page`;

    const audit = await runAudit({
      targets: [
        {
          url,
          expectations: {
            statuses: [200],
            requireTitle: true,
            requireDescription: true,
            requireCanonical: true,
            requireH1: true,
            requireMainText: true,
          },
        },
      ],
      agents: [resolveAgent("browser"), resolveAgent("googlebot")],
      headers: {},
      timeoutMs: 2_000,
      maxBytes: 100_000,
      maxRedirects: 4,
      repeat: 2,
    });

    const findings = audit.results[0]?.findings ?? [];
    const titleDrift = findings.filter((finding) => finding.code === "agent-title-drift");
    expect(titleDrift).toHaveLength(1);
    expect(titleDrift[0]?.evidence).toMatchObject({
      sampleNumbers: "1, 2",
      occurrences: 2,
      totalSamples: 2,
    });
    expect(findings.some((finding) => finding.code === "stream-instability")).toBe(false);
  });

  it("keeps repeated output ordered by target, agent, and sample", async () => {
    server = createServer((request, response) => {
      const origin = `http://${request.headers.host}`;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<html><head><title>Stable</title><meta name="description" content="Ready">` +
          `<link rel="canonical" href="${origin}/page"></head>` +
          "<body><main><h1>Stable</h1><p>Ready.</p></main></body></html>",
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
    const url = `http://127.0.0.1:${address.port}/page`;

    const audit = await runAudit({
      targets: [
        {
          url,
          expectations: {
            statuses: [200],
            requireTitle: true,
            requireDescription: true,
            requireCanonical: true,
            requireH1: true,
            requireMainText: true,
          },
        },
      ],
      agents: [resolveAgent("browser"), resolveAgent("googlebot")],
      headers: {},
      timeoutMs: 2_000,
      maxBytes: 100_000,
      maxRedirects: 4,
      repeat: 2,
    });

    expect(audit.results[0]?.probes.map((probe) => `${probe.agent.key}:${probe.sample}`)).toEqual([
      "browser:1",
      "browser:2",
      "googlebot:1",
      "googlebot:2",
    ]);
  });

  it("rejects invalid repeat counts for programmatic callers", async () => {
    await expect(
      runAudit({
        targets: [],
        agents: [],
        headers: {},
        timeoutMs: 2_000,
        maxBytes: 100_000,
        maxRedirects: 4,
        repeat: 11,
      }),
    ).rejects.toThrow("repeat must be an integer between 1 and 10");
  });
});
