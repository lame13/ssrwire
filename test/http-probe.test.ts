import { createHash } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { BUILTIN_AGENTS, resolveAgent, resolveAgents } from "../src/agents.js";
import { probeUrl } from "../src/http-probe.js";

const servers = new Set<Server>();

async function listen(handler: RequestListener): Promise<{ origin: string; server: Server }> {
  const server = createServer(handler);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing TCP address");
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

afterEach(async () => {
  const active = [...servers];
  servers.clear();
  for (const server of active) server.closeAllConnections();
  await Promise.all(
    active.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function baseOptions(url: string) {
  return {
    url,
    agent: resolveAgent("googlebot"),
    timeoutMs: 2_000,
    maxBytes: 100_000,
    maxRedirects: 4,
  } as const;
}

describe("agent profiles", () => {
  it("provides the five crawler modes and validates custom profiles", () => {
    expect(Object.keys(BUILTIN_AGENTS)).toEqual([
      "browser",
      "googlebot",
      "bingbot",
      "twitterbot",
      "facebook",
    ]);
    expect(resolveAgent("chrome").key).toBe("browser");
    expect(resolveAgent("bingbot").requiresHeadMetadata).toBe(true);
    expect(resolveAgent({ key: "preview-crawler", userAgent: "PreviewCrawler/1.0" })).toEqual({
      key: "preview-crawler",
      label: "preview-crawler",
      userAgent: "PreviewCrawler/1.0",
      requiresHeadMetadata: false,
    });
    expect(() => resolveAgent("not-a-crawler")).toThrow(/Unknown agent/u);
    expect(() => resolveAgents(["browser", "chrome"])).toThrow(/Duplicate agent key/u);
  });
});

describe("probeUrl", () => {
  it("follows same-origin redirects and preserves streamed timing, hashes, and safe headers", async () => {
    const first = "<html><head><title>Streamed</title></head>";
    const second = "<body><h1>Ready</h1><main>Useful response</main></body></html>";
    let observedUserAgent = "";
    let observedEncoding = "";
    let observedPreview = "";
    const { origin } = await listen((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/page" });
        response.end();
        return;
      }
      observedUserAgent = request.headers["user-agent"] ?? "";
      observedEncoding = request.headers["accept-encoding"] ?? "";
      const previewHeader = request.headers["x-preview"];
      observedPreview = Array.isArray(previewHeader)
        ? previewHeader.join(", ")
        : (previewHeader ?? "");
      response.writeHead(200, {
        "cache-control": "public, max-age=60",
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "session=private; HttpOnly",
        "x-not-allowlisted": "do not report",
      });
      response.flushHeaders();
      const firstTimer = setTimeout(() => {
        response.write(first);
        const secondTimer = setTimeout(() => response.end(second), 25);
        response.once("close", () => clearTimeout(secondTimer));
      }, 25);
      response.once("close", () => clearTimeout(firstTimer));
    });

    const result = await probeUrl({
      ...baseOptions(`${origin}/start`),
      headers: { "x-preview": "allowed-here" },
    });

    expect(result.completion).toBe("complete");
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe(`${origin}/page`);
    expect(result.redirects).toHaveLength(1);
    expect(result.redirects[0]).toMatchObject({
      url: `${origin}/start`,
      status: 302,
      location: `${origin}/page`,
    });
    expect(observedUserAgent).toContain("Googlebot");
    expect(observedEncoding).toBe("identity");
    expect(observedPreview).toBe("allowed-here");
    expect(result.timings.firstByteMs).toBeGreaterThan(result.timings.headersMs);
    expect(result.timings.completeMs).toBeGreaterThan(result.timings.firstByteMs ?? 0);
    expect(result.signals.title).toMatchObject({ value: "Streamed", location: "head" });
    expect(result.signals.h1s[0]).toMatchObject({ value: "Ready", location: "body" });
    expect(result.signals.title?.atMs).toBeLessThan(result.signals.h1s[0]?.atMs ?? 0);
    expect(result.headers.values["cache-control"]).toBe("public, max-age=60");
    expect(result.headers.values["x-not-allowlisted"]).toBeUndefined();
    expect(result.headers.setCookiePresent).toBe(true);
    expect(result.bytesRead).toBe(Buffer.byteLength(first + second));
    expect(result.bodySha256).toBe(
      createHash("sha256")
        .update(first + second)
        .digest("hex"),
    );
  });

  it("permanently strips all custom headers after a cross-origin redirect", async () => {
    const secret = "preview-secret-58193";
    const previewHeader = "second-preview-value-413";
    let targetAuthorization: string | undefined;
    let targetPreview: string | undefined;
    let targetUserAgent = "";
    const target = await listen((request, response) => {
      targetAuthorization = request.headers.authorization;
      targetPreview = request.headers["x-preview"] as string | undefined;
      targetUserAgent = request.headers["user-agent"] ?? "";
      response.writeHead(200, {
        "content-type": "text/html",
        etag: secret,
      });
      response.end("<html><head><title>Safe</title></head><body></body></html>");
    });

    let sourceAuthorization = "";
    const source = await listen((request, response) => {
      sourceAuthorization = request.headers.authorization ?? "";
      response.writeHead(302, { location: `${target.origin}/destination` });
      response.end();
    });

    const result = await probeUrl({
      ...baseOptions(`${source.origin}/source`),
      headers: {
        authorization: `Bearer ${secret}`,
        "x-preview": previewHeader,
      },
    });

    expect(sourceAuthorization).toBe(`Bearer ${secret}`);
    expect(targetAuthorization).toBeUndefined();
    expect(targetPreview).toBeUndefined();
    expect(targetUserAgent).toContain("Googlebot");
    expect(result.completion).toBe("complete");
    const { etag } = result.headers.values;
    expect(etag).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(previewHeader);
  });

  it("returns a bounded partial result when the response exceeds maxBytes", async () => {
    const body = `<html><head><title>Large</title></head><body>${"x".repeat(1_000)}</body></html>`;
    const { origin } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(body);
    });

    const result = await probeUrl({ ...baseOptions(origin), maxBytes: 80 });

    expect(result.completion).toBe("max-bytes-exceeded");
    expect(result.bytesRead).toBe(80);
    expect(result.bodySha256).toBe(
      createHash("sha256").update(Buffer.from(body).subarray(0, 80)).digest("hex"),
    );
    expect(result.signals.title?.value).toBe("Large");
    expect(result.timings.completeMs).toBeUndefined();
  });

  it("returns partial signals on timeout without exposing custom header values", async () => {
    const secret = "do-not-print-2208";
    const { origin } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.flushHeaders();
      response.write("<html><head><title>Early</title></head><body>");
      const timer = setTimeout(() => response.end("<h1>Too late</h1></body></html>"), 250);
      response.once("close", () => clearTimeout(timer));
    });

    const result = await probeUrl({
      ...baseOptions(origin),
      timeoutMs: 40,
      headers: { authorization: secret },
    });

    expect(result.completion).toBe("timeout");
    expect(result.signals.title?.value).toBe("Early");
    expect(result.signals.h1s).toHaveLength(0);
    expect(result.timings.completeMs).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("returns invalid-response instead of throwing for unsupported URLs and limits", async () => {
    const result = await probeUrl({
      ...baseOptions("file:///private/page.html"),
      headers: { authorization: "never-serialize-this" },
    });
    expect(result.completion).toBe("invalid-response");
    expect(result.status).toBeUndefined();
    expect(result.error).toMatch(/http/u);
    expect(JSON.stringify(result)).not.toContain("never-serialize-this");
  });

  it("rejects URL credentials without serializing or sending them", async () => {
    const result = await probeUrl(baseOptions("http://alice:correct-horse@127.0.0.1:9/page"));

    expect(result.completion).toBe("invalid-response");
    expect(result.error).toMatch(/credentials/u);
    expect(JSON.stringify(result)).not.toContain("alice");
    expect(JSON.stringify(result)).not.toContain("correct-horse");
  });

  it("rejects redirect targets containing credentials before recording them", async () => {
    const { origin } = await listen((_request, response) => {
      const target = new URL(origin);
      target.username = "alice";
      target.password = "correct-horse";
      target.pathname = "/private";
      response.writeHead(302, { location: target.href });
      response.end();
    });

    const result = await probeUrl(baseOptions(origin));

    expect(result.completion).toBe("invalid-response");
    expect(result.error).toMatch(/credentials/u);
    expect(result.redirects).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("correct-horse");
  });

  it("rejects a non-HTML response even when its text resembles HTML", async () => {
    const { origin } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ html: "<title>False pass</title><main><h1>Not HTML</h1></main>" }),
      );
    });

    const result = await probeUrl(baseOptions(origin));

    expect(result.completion).toBe("invalid-response");
    expect(result.error).toContain("application/json");
    expect(result.bytesRead).toBe(0);
    expect(result.signals.title).toBeUndefined();
  });

  it("rejects a response with no Content-Type instead of sniffing HTML-like text", async () => {
    const { origin } = await listen((_request, response) => {
      response.writeHead(200);
      response.end("<html><head><title>Untrusted sniff</title></head></html>");
    });

    const result = await probeUrl(baseOptions(origin));

    expect(result.completion).toBe("invalid-response");
    expect(result.error).toMatch(/Content-Type header was missing/u);
    expect(result.signals.title).toBeUndefined();
  });

  it("does not corrupt ordinary output when a custom header value is one character", async () => {
    const { origin } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<html><head><title>Alpha</title><link rel="canonical" href="/page"></head><body></body></html>',
      );
    });

    const result = await probeUrl({ ...baseOptions(`${origin}/page`), headers: { "x-flag": "a" } });

    expect(result.finalUrl).toBe(`${origin}/page`);
    expect(result.signals.title?.value).toBe("Alpha");
    expect(result.signals.canonicals[0]?.value).toBe("/page");
    expect(JSON.stringify(result)).not.toContain("[REDACTED]lph");
  });
});
