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
      '<meta property="og:title" content="Café preview">',
      '<meta property="og:image" content="https://example.test/preview.jpg">',
      '<meta name="twitter:card" content="summary_large_image">',
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
    expect(signals.socialMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "og:title", value: "Café preview", location: "head" }),
        expect.objectContaining({
          property: "og:image",
          value: "https://example.test/preview.jpg",
          location: "head",
        }),
        expect.objectContaining({
          property: "twitter:card",
          value: "summary_large_image",
          location: "head",
        }),
      ]),
    );
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
          '<meta property="og:title" content="Template preview">' +
          '<link rel="canonical" href="/template"><meta name="robots" content="none">' +
          "<h1>Template H1</h1><main>Template main</main>" +
          '<script type="application/ld+json">{"@type":"TemplateThing"}</script></template>' +
          '</head><body><svg><title>SVG title</title><meta name="description" content="svg">' +
          '<meta property="og:title" content="SVG preview">' +
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
    expect(signals.socialMetadata).toEqual([]);
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

  it("captures social metadata from property or name attributes with body timing", () => {
    const inspector = createStreamInspector();
    inspector.write(
      Buffer.from(
        '<html><head><meta PROPERTY="OG:TITLE" content="Open Graph title">' +
          '<meta name="og:description" content="Open Graph description">' +
          '<meta property="twitter:card" content="summary"></head><body>' +
          '<meta name="twitter:image" content="https://example.test/card.jpg"></body></html>',
      ),
      41,
    );

    const social = inspector.end(45).socialMetadata ?? [];
    expect(social.map(({ property, value, location }) => ({ property, value, location }))).toEqual([
      { property: "og:title", value: "Open Graph title", location: "head" },
      { property: "og:description", value: "Open Graph description", location: "head" },
      { property: "twitter:card", value: "summary", location: "head" },
      {
        property: "twitter:image",
        value: "https://example.test/card.jpg",
        location: "body",
      },
    ]);
    expect(social.every((signal) => signal.atMs === 41)).toBe(true);
  });

  it("bounds each repeated social metadata property independently", () => {
    const inspector = createStreamInspector();
    inspector.write(
      Buffer.from(
        `<head>${Array.from(
          { length: 257 },
          (_, index) => `<meta property="og:image" content="https://example.test/${index}.jpg">`,
        ).join("")}<meta property="og:title" content="Still captured"></head>`,
      ),
      10,
    );

    const social = inspector.end(12).socialMetadata ?? [];
    expect(social.filter((signal) => signal.property === "og:image")).toHaveLength(256);
    expect(social).toContainEqual(
      expect.objectContaining({ property: "og:title", value: "Still captured" }),
    );
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

  it("decodes a charset declared inside the document when the response declares none", () => {
    const html =
      '<html><head><meta charset="windows-1252"><title>Café ünïcode</title>' +
      '<meta name="description" content="Résumé of the page"></head><body></body></html>';
    const encoded = Buffer.from(html, "latin1");
    const inspector = createStreamInspector();
    // Split inside the declaration so the decoder has to wait for buffered bytes.
    inspector.write(encoded.subarray(0, 32), 7);
    inspector.write(encoded.subarray(32), 11);

    const signals = inspector.end(13);

    expect(signals.title).toMatchObject({ value: "Café ünïcode", location: "head", atMs: 11 });
    expect(signals.descriptions[0]).toMatchObject({ value: "Résumé of the page" });
    expect(signals.title?.observedByByte).toBe(encoded.byteLength);
  });

  it("prefers the response charset over an in-document declaration", () => {
    const html =
      '<html><head><meta charset="windows-1252"><title>Café</title></head><body></body></html>';
    const inspector = createStreamInspector({ charset: "utf-8" });
    inspector.write(Buffer.from(html, "latin1"), 3);

    const signals = inspector.end(4);

    expect(signals.title?.value).toContain("\uFFFD");
    expect(signals.title?.value).not.toBe("Café");
  });

  it("decodes a UTF-16LE document that starts with a byte-order mark", () => {
    const html = "<html><head><title>Wide</title></head><body></body></html>";
    const encoded = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, "utf16le")]);
    const inspector = createStreamInspector();
    inspector.write(encoded, 6);

    const signals = inspector.end(7);

    expect(signals.title?.value).toBe("Wide");
  });

  it("falls back to UTF-8 for an unsupported charset label", () => {
    const inspector = createStreamInspector({ charset: "x-not-a-real-encoding" });
    inspector.write(Buffer.from("<html><head><title>Fallback</title></head></html>"), 3);

    expect(inspector.end(4).title?.value).toBe("Fallback");
  });

  it("counts buffered bytes as observed and keeps parsing after the sniff window", () => {
    const inspector = createStreamInspector();
    const padding = `<html><head>${"<!-- padding -->".repeat(100)}`;
    inspector.write(Buffer.from(padding), 9);

    expect(inspector.bytesObserved).toBe(Buffer.byteLength(padding));
    expect(inspector.bytesObserved).toBeGreaterThan(1_024);

    inspector.write(
      Buffer.from('<meta charset="windows-1252"><title>Late Café</title></head></html>'),
      12,
    );
    const signals = inspector.end(13);

    expect(signals.title).toMatchObject({ value: "Late Café", atMs: 12 });
  });

  it.each([
    '<!-- <meta charset="windows-1252"> -->',
    '<meta name="description" content="charset=windows-1252">',
    '<meta data-charset="windows-1252">',
    '<metadata charset="windows-1252"></metadata>',
    "<script>const example = '<meta charset=\"windows-1252\">';</script>",
  ])("ignores charset-like text in %s", (prefix) => {
    const { signals } = feedOneByteAtATime(
      `<html><head>${prefix}<meta charset="utf-8"><title>Café</title></head></html>`,
    );

    expect(signals.title?.value).toBe("Café");
  });

  it("skips unsupported meta labels and accepts a later Content-Type pragma", () => {
    const inspector = createStreamInspector();
    inspector.write(
      Buffer.from(
        '<meta charset="x-unsupported"><meta content="text/html; charset=windows-1252" ' +
          'http-equiv="Content-Type"><title>Café</title>',
        "latin1",
      ),
      8,
    );

    expect(inspector.end().title?.value).toBe("Café");
  });

  it.each(["utf-16le", "utf-16be"])(
    "treats an ASCII meta declaration of %s as UTF-8",
    (charset) => {
      const { signals } = feedOneByteAtATime(`<meta charset="${charset}"><title>Café</title>`);

      expect(signals.title?.value).toBe("Café");
    },
  );

  it("lets a split byte-order mark override the response charset", () => {
    const inspector = createStreamInspector({ charset: "utf-8" });
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("<title>Café</title>", "utf16le"),
    ]);
    for (let index = 0; index < bytes.length; index += 1) {
      inspector.write(bytes.subarray(index, index + 1), index + 1);
    }

    expect(inspector.end().title).toMatchObject({
      value: "Café",
      atMs: bytes.length,
      observedByByte: bytes.length,
    });
  });

  it.each(["end", "finish"] as const)(
    "preserves the last arrival time when %s closes buffered HTML",
    (method) => {
      const inspector = createStreamInspector();
      const bytes = Buffer.from("<html><head><title>Unclosed");
      inspector.write(bytes, 42);

      expect(inspector[method]().title).toMatchObject({
        value: "Unclosed",
        atMs: 42,
        observedByByte: bytes.length,
      });
    },
  );

  it("retains buffered bytes when the caller reuses a chunk after write", () => {
    const inspector = createStreamInspector();
    const bytes = Buffer.from("<title>Original</title>");
    inspector.write(bytes, 7);
    bytes.fill(0);

    expect(inspector.end().title).toMatchObject({ value: "Original", atMs: 7 });
  });
});
