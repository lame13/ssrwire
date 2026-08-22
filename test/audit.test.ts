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
    let receivedSecret = false;
    server = createServer((request, response) => {
      receivedSecret = request.headers["x-preview-token"] === secret;
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
    };

    const audit = await runAudit(config);
    const serialized = JSON.stringify(audit);

    expect(receivedSecret).toBe(true);
    expect(audit.summary).toMatchObject({ errors: 0, warnings: 0, incomplete: 0 });
    expect(
      audit.results[0]?.findings.some((finding) => finding.code === "final-url-mismatch"),
    ).toBe(false);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });
});
