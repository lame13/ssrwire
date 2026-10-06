import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  assignTargetIds,
  discoverSitemapTargets,
  globToRegExp,
  SitemapError,
  targetIdFromUrl,
} from "../src/sitemap.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ssrwire-sitemap-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function urlset(locations: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locations.map((location) => `  <url><loc>${location}</loc></url>`).join("\n")}
</urlset>`;
}

function sitemapIndex(locations: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locations.map((location) => `  <sitemap><loc>${location}</loc></sitemap>`).join("\n")}
</sitemapindex>`;
}

function respond(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

describe("globToRegExp", () => {
  it("anchors wildcards and treats a bare fragment as a substring match", () => {
    expect(globToRegExp("/blog/*").test("/blog/post")).toBe(true);
    expect(globToRegExp("/blog/*").test("/news/post")).toBe(false);
    expect(globToRegExp("blog").test("/deep/blog/post")).toBe(true);
    expect(globToRegExp("/page?").test("/page7")).toBe(true);
  });
});

describe("targetIdFromUrl", () => {
  it("derives a stable id from the path so two origins can be matched", () => {
    expect(targetIdFromUrl("https://example.com/")).toBe("home");
    expect(targetIdFromUrl("https://www.example.com/pricing/")).toBe("pricing");
    expect(targetIdFromUrl("https://preview.example.net/pricing/")).toBe("pricing");
    expect(targetIdFromUrl("https://example.com/blog/Hello World/")).toBe("blog-hello-world");
  });
});

describe("assignTargetIds", () => {
  it("keeps ids unique by suffixing a hash only where they collide", () => {
    const ids = assignTargetIds([
      "https://example.com/docs/guide",
      "https://example.com/docs/guide-",
      "https://example.com/about",
    ]);

    expect(ids.get("https://example.com/about")).toBe("about");
    expect(ids.get("https://example.com/docs/guide")).toMatch(/^docs-guide-[0-9a-f]{8}$/u);
    expect(ids.get("https://example.com/docs/guide-")).toMatch(/^docs-guide-[0-9a-f]{8}$/u);
  });
});

describe("discoverSitemapTargets", () => {
  it("reads CDATA locations and normalizes fragments before deduplication", async () => {
    const discovery = await discoverSitemapTargets("https://example.com/sitemap.xml", {
      fetchImpl: async () =>
        respond(
          urlset([
            "<![CDATA[https://example.com/a?x=1&y=2]]>",
            "https://example.com/a?x=1&amp;y=2#part",
          ]),
        ),
    });
    expect(discovery.urls).toEqual(["https://example.com/a?x=1&y=2"]);
  });

  it("rejects invalid discovery limits before fetching", async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(
        discoverSitemapTargets("https://example.com/map.xml", { limit }),
      ).rejects.toThrow("positive integer");
    }
  });

  it("stops fetching children when the URL budget is full", async () => {
    const calls: string[] = [];
    const discovery = await discoverSitemapTargets("https://example.com/sitemap.xml", {
      limit: 1,
      fetchImpl: async (input) => {
        calls.push(String(input));
        return respond(
          String(input).endsWith("sitemap.xml")
            ? sitemapIndex(["https://example.com/a.xml", "https://example.com/b.xml"])
            : urlset(["https://example.com/page"]),
        );
      },
    });
    expect(calls).toHaveLength(2);
    expect(discovery.truncated).toBe(true);
  });

  it("counts failed children toward the document budget", async () => {
    const calls: string[] = [];
    const discovery = await discoverSitemapTargets("https://example.com/sitemap.xml", {
      maxSitemaps: 2,
      fetchImpl: async (input) => {
        calls.push(String(input));
        return String(input).endsWith("sitemap.xml")
          ? respond(
              sitemapIndex(["https://example.com/a.xml", "https://example.com/b.xml"]) +
                urlset(["https://example.com/page"]),
            )
          : respond("failed", 503);
      },
    });
    expect(calls).toHaveLength(2);
    expect(discovery.truncated).toBe(true);
  });

  it("rejects cross-origin redirects before fetching their destination", async () => {
    const calls: string[] = [];
    await expect(
      discoverSitemapTargets("https://example.com/sitemap.xml", {
        fetchImpl: async (input) => {
          calls.push(String(input));
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.test/map.xml" },
          });
        },
      }),
    ).rejects.toThrow("cross-origin");
    expect(calls).toHaveLength(1);
  });

  it("bounds local files and decompressed gzip output", async () => {
    const directory = await temporaryDirectory();
    const body = urlset([`https://example.com/${"a".repeat(2000)}`]);
    for (const gzip of [false, true]) {
      const path = join(directory, gzip ? "map.xml.gz" : "map.xml");
      await writeFile(path, gzip ? gzipSync(body) : body);
      await expect(discoverSitemapTargets(path, { maxBytes: 512 })).rejects.toBeInstanceOf(
        SitemapError,
      );
    }
  });

  it("cancels oversized remote sitemaps", async () => {
    let cancelled = false;
    await expect(
      discoverSitemapTargets("https://example.com/map.xml", {
        maxBytes: 8,
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(9));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      }),
    ).rejects.toThrow("exceeded");
    expect(cancelled).toBe(true);
  });
  it("reads a urlset and de-duplicates repeated locations", async () => {
    const discovery = await discoverSitemapTargets("https://example.com/sitemap.xml", {
      fetchImpl: async () =>
        respond(
          urlset(["https://example.com/", "https://example.com/pricing/", "https://example.com/"]),
        ),
    });

    expect(discovery.urls).toEqual(["https://example.com/", "https://example.com/pricing/"]);
    expect(discovery.truncated).toBe(false);
  });

  it("follows a sitemap index within the same origin only", async () => {
    const discovery = await discoverSitemapTargets("https://example.com/sitemap.xml", {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/sitemap.xml")) {
          return respond(
            sitemapIndex(["https://example.com/pages.xml", "https://cdn.example.net/other.xml"]),
          );
        }
        return respond(urlset(["https://example.com/from-child"]));
      },
    });

    expect(discovery.urls).toEqual(["https://example.com/from-child"]);
    expect(discovery.sitemaps).toEqual([
      "https://example.com/sitemap.xml",
      "https://example.com/pages.xml",
    ]);
    expect(discovery.errors.join(" ")).toContain("cross-origin");
  });

  it("applies include and exclude globs to the path", async () => {
    const discovery = await discoverSitemapTargets("https://example.com/sitemap.xml", {
      fetchImpl: async () =>
        respond(
          urlset([
            "https://example.com/blog/one",
            "https://example.com/blog/two",
            "https://example.com/pricing/",
          ]),
        ),
      include: ["/blog/*"],
      exclude: ["/blog/two"],
    });

    expect(discovery.urls).toEqual(["https://example.com/blog/one"]);
  });

  it("stops at the URL limit and reports that it truncated", async () => {
    const discovery = await discoverSitemapTargets("https://example.com/sitemap.xml", {
      limit: 2,
      fetchImpl: async () =>
        respond(
          urlset(["https://example.com/a", "https://example.com/b", "https://example.com/c"]),
        ),
    });

    expect(discovery.urls).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(discovery.truncated).toBe(true);
  });

  it("keeps URLs from the documents it could read when one child fails", async () => {
    const discovery = await discoverSitemapTargets("https://example.com/sitemap.xml", {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/broken.xml")) {
          return respond("nope", 500);
        }
        if (url.endsWith("/sitemap.xml")) {
          return respond(
            sitemapIndex(["https://example.com/good.xml", "https://example.com/broken.xml"]),
          );
        }
        return respond(urlset(["https://example.com/kept"]));
      },
    });

    expect(discovery.urls).toEqual(["https://example.com/kept"]);
    expect(discovery.errors.join(" ")).toContain("broken.xml");
  });

  it("reads a gzipped sitemap from disk", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "sitemap.xml.gz");
    await writeFile(path, gzipSync(Buffer.from(urlset(["https://example.com/from-gzip"]))));

    const discovery = await discoverSitemapTargets(path);

    expect(discovery.urls).toEqual(["https://example.com/from-gzip"]);
  });

  it("fails with a clear message when the sitemap yields no URLs", async () => {
    await expect(
      discoverSitemapTargets("https://example.com/sitemap.xml", {
        fetchImpl: async () => respond(urlset([])),
      }),
    ).rejects.toBeInstanceOf(SitemapError);
  });

  it("surfaces a non-2xx source as an error", async () => {
    await expect(
      discoverSitemapTargets("https://example.com/sitemap.xml", {
        fetchImpl: async () => respond("missing", 404),
      }),
    ).rejects.toThrow(/HTTP 404/u);
  });
});

it("keeps colliding IDs stable across origins and sitemap order", () => {
  const paths = ["/docs/guide", "/docs/guide-", "/page?a=1", "/page?a=2"];
  const baseline = assignTargetIds(paths.map((path) => `https://prod.test${path}`));
  const candidate = assignTargetIds(
    [...paths].reverse().map((path) => `https://preview.test${path}`),
  );
  for (const path of paths)
    expect(baseline.get(`https://prod.test${path}`)).toBe(
      candidate.get(`https://preview.test${path}`),
    );
  const firstId = baseline.get("https://prod.test/docs/guide");
  const withCollision = assignTargetIds([...baseline.keys(), `https://prod.test/${firstId}`]);
  expect(new Set(withCollision.values()).size).toBe(withCollision.size);
});
