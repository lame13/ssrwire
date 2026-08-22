import { describe, expect, it } from "vitest";

import { createStreamInspector } from "../src/stream-parser.js";

function feedOneByteAtATime(html: string) {
  const inspector = createStreamInspector();
  const encoded = Buffer.from(html);
  for (let index = 0; index < encoded.byteLength; index += 1) {
    inspector.write(encoded.subarray(index, index + 1), index + 1);
  }
  return { bytes: encoded.byteLength, signals: inspector.end(encoded.byteLength + 1) };
}

describe("createStreamInspector", () => {
  it("parses streamed UTF-8 and records where and when SEO signals become observable", () => {
    const html = [
      "<!doctype html><html><head>",
      "<title>Café 🚀</title>",
      '<meta name="description" content="Résumé of the page">',
      '<link rel="alternate canonical" href="https://example.test/café">',
      '<meta name="robots" content="index,follow">',
      '<script type="application/ld+json">',
      '{"@context":"https://schema.org","@type":"Product","offers":{"@type":"Offer"}}',
      "</script></head><body>",
      "<h1>Привет <span>мир</span></h1>",
      "<main> First <strong>useful</strong> text <script>ignored()</script></main>",
      "</body></html>",
    ].join("");

    const { bytes, signals } = feedOneByteAtATime(html);

    expect(signals.title).toMatchObject({ value: "Café 🚀", location: "head" });
    expect(signals.title?.atMs).toBe(signals.title?.observedByByte);
    expect(signals.descriptions).toHaveLength(1);
    expect(signals.descriptions[0]).toMatchObject({
      value: "Résumé of the page",
      location: "head",
    });
    expect(signals.canonicals[0]).toMatchObject({
      value: "https://example.test/café",
      location: "head",
    });
    expect(signals.robots[0]).toMatchObject({
      value: "index,follow",
      location: "head",
      audience: "robots",
    });
    expect(signals.h1s[0]).toMatchObject({ value: "Привет мир", location: "body" });
    expect(signals.firstMainText).toMatchObject({ value: "First useful text", location: "body" });
    expect(signals.jsonLd[0]).toMatchObject({
      valid: true,
      location: "head",
      types: ["Offer", "Product"],
    });
    expect(signals.jsonLd[0]?.bytes).toBeGreaterThan(50);
    expect(signals.headClosed?.observedByByte).toBeLessThan(
      signals.bodyStarted?.observedByByte ?? 0,
    );
    expect(signals.documentClosed?.observedByByte).toBe(bytes);
  });

  it("reports duplicated body metadata and invalid JSON-LD without treating it as head metadata", () => {
    const inspector = createStreamInspector();
    inspector.write(
      Buffer.from(
        '<html><body><meta name="description" content="one"><meta name="description" content="two">' +
          '<link rel="canonical" href="/late"><script type="APPLICATION/LD+JSON">{"bad":</script></body></html>',
      ),
      17,
    );

    const signals = inspector.finish(20);

    expect(signals.descriptions.map(({ value }) => value)).toEqual(["one", "two"]);
    expect(signals.descriptions.every(({ location }) => location === "body")).toBe(true);
    expect(signals.canonicals[0]).toMatchObject({ value: "/late", location: "body" });
    expect(signals.jsonLd[0]).toMatchObject({ valid: false, location: "body", types: [] });
    expect(signals.jsonLd[0]?.error).toMatch(/JSON/u);
    expect(signals.headClosed).toBeUndefined();
  });

  it("preserves crawler audiences and ignores template and foreign-content signals", () => {
    const inspector = createStreamInspector();
    inspector.write(
      Buffer.from(
        '<html><head><meta name="robots" content="index,follow">' +
          '<meta name="googlebot" content="noindex"><meta name="bingbot" content="nofollow">' +
          '<template><title>Template title</title><meta name="description" content="template">' +
          '<link rel="canonical" href="/template"><meta name="robots" content="none">' +
          "<h1>Template H1</h1><main>Template main</main>" +
          '<script type="application/ld+json">{"@type":"TemplateThing"}</script></template>' +
          '</head><body><svg><title>SVG title</title><meta name="description" content="svg">' +
          '<link rel="canonical" href="/svg"><h1>SVG H1</h1><main>SVG main</main>' +
          '<script type="application/ld+json">{"@type":"SvgThing"}</script></svg>' +
          '<math><title>Math title</title><meta name="robots" content="noindex">' +
          "<h1>Math H1</h1><main>Math main</main></math>" +
          "<h1>Real H1</h1><main>Real main</main></body></html>",
      ),
      10,
    );

    const signals = inspector.end(12);

    expect(signals.title).toBeUndefined();
    expect(signals.descriptions).toEqual([]);
    expect(signals.canonicals).toEqual([]);
    expect(signals.robots.map(({ audience, value }) => ({ audience, value }))).toEqual([
      { audience: "robots", value: "index,follow" },
      { audience: "googlebot", value: "noindex" },
      { audience: "bingbot", value: "nofollow" },
    ]);
    expect(signals.h1s.map(({ value }) => value)).toEqual(["Real H1"]);
    expect(signals.firstMainText?.value).toBe("Real main");
    expect(signals.jsonLd).toEqual([]);
  });

  it("captures every document title and accepts JSON-LD MIME parameters", () => {
    const inspector = createStreamInspector();
    inspector.write(
      Buffer.from(
        "<html><head><title>Loading</title></head><body><title>Final</title>" +
          '<script type="application/ld+json; charset=utf-8">{"@type":"Article"}</script>' +
          "</body></html>",
      ),
      10,
    );

    const signals = inspector.end(12);
    expect(signals.title?.value).toBe("Loading");
    expect(signals.titles?.map((signal) => signal.value)).toEqual(["Loading", "Final"]);
    expect(signals.jsonLd[0]).toMatchObject({ valid: true, types: ["Article"] });
  });

  it("bounds very large main text and JSON-LD captures", () => {
    const inspector = createStreamInspector();
    inspector.write(
      Buffer.from(
        `<html><body><main>${"x".repeat(20_000)}</main>` +
          `<script type="application/ld+json">"${"y".repeat(1_048_577)}"</script>` +
          "</body></html>",
      ),
      10,
    );

    const signals = inspector.end(12);
    expect(signals.firstMainText?.value).toHaveLength(240);
    expect(signals.jsonLd[0]?.valid).toBeUndefined();
    expect(signals.jsonLd[0]?.analysisLimit).toMatch(/analysis limit/u);
  });

  it("is idempotent when finalized and rejects writes after finalization", () => {
    const inspector = createStreamInspector();
    inspector.write(Buffer.from("<main>hello</main>"), 4);
    const first = inspector.end(5);
    expect(inspector.finish(99)).toBe(first);
    expect(() => inspector.write(Buffer.from("later"), 6)).toThrow(/finished/u);
  });
});
