import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectFrameworkFromProbes,
  detectProjectFramework,
  isFrameworkKey,
} from "../src/framework.js";
import type { ProbeResult } from "../src/types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function projectDirectory(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ssrwire-framework-"));
  directories.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents, "utf8");
  }
  return directory;
}

function probe(headers: Readonly<Record<string, string>>): ProbeResult {
  return {
    requestedUrl: "https://example.com/page",
    finalUrl: "https://example.com/page",
    agent: {
      key: "browser",
      label: "Browser",
      userAgent: "Browser UA",
      requiresHeadMetadata: false,
    },
    status: 200,
    redirects: [],
    headers: { values: headers, setCookiePresent: false },
    timings: { headersMs: 10, firstByteMs: 15, completeMs: 50 },
    bytesRead: 1_000,
    signals: { descriptions: [], canonicals: [], robots: [], h1s: [], jsonLd: [] },
    completion: "complete",
  };
}

describe("detectFrameworkFromProbes", () => {
  it("returns nothing when no response evidence identifies a stack", () => {
    expect(detectFrameworkFromProbes([probe({ server: "nginx" })])).toBeUndefined();
    expect(detectFrameworkFromProbes([])).toBeUndefined();
  });

  it("recognizes Next.js from its cache header", () => {
    expect(detectFrameworkFromProbes([probe({ "x-nextjs-cache": "HIT" })])).toMatchObject({
      key: "nextjs",
      label: "Next.js",
    });
  });

  it("recognizes stacks from x-powered-by", () => {
    expect(detectFrameworkFromProbes([probe({ "x-powered-by": "Nuxt" })])?.key).toBe("nuxt");
    expect(detectFrameworkFromProbes([probe({ "x-powered-by": "Astro" })])?.key).toBe("astro");
    expect(detectFrameworkFromProbes([probe({ "x-powered-by": "PHP/8.3.4" })])?.key).toBe("php");
    expect(
      detectFrameworkFromProbes([probe({ "x-powered-by": "WordPress VIP" })])?.evidence,
    ).toContain("x-powered-by");
  });

  it("prefers a framework-specific header over a generic one", () => {
    const detected = detectFrameworkFromProbes([
      probe({ "x-nextjs-cache": "STALE", "x-powered-by": "PHP/8.3.4" }),
    ]);
    expect(detected?.key).toBe("nextjs");
  });
});

describe("detectProjectFramework", () => {
  it("reads the stack from package.json dependencies", async () => {
    const directory = await projectDirectory({
      "package.json": JSON.stringify({ dependencies: { next: "16.0.0" } }),
    });
    expect(await detectProjectFramework(directory)).toMatchObject({ key: "nextjs" });
  });

  it("reads devDependencies and composer requirements", async () => {
    const dev = await projectDirectory({
      "package.json": JSON.stringify({ devDependencies: { "@sveltejs/kit": "2.0.0" } }),
    });
    expect(await detectProjectFramework(dev)).toMatchObject({ key: "sveltekit" });

    const composer = await projectDirectory({
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" } }),
    });
    expect(await detectProjectFramework(composer)).toMatchObject({ key: "laravel" });
  });

  it("recognizes WordPress from wp-config.php", async () => {
    const directory = await projectDirectory({ "wp-config.php": "<?php // config" });
    expect(await detectProjectFramework(directory)).toMatchObject({
      key: "wordpress",
      label: "WordPress",
    });
  });

  it("stays quiet for unreadable or unrelated manifests", async () => {
    const directory = await projectDirectory({
      "package.json": "not json",
      "composer.json": JSON.stringify({ require: { "guzzlehttp/guzzle": "^7.0" } }),
    });
    expect(await detectProjectFramework(directory)).toBeUndefined();
    expect(await detectProjectFramework(join(directory, "missing"))).toBeUndefined();
  });
});

describe("isFrameworkKey", () => {
  it("accepts known keys and rejects everything else", () => {
    expect(isFrameworkKey("nextjs")).toBe(true);
    expect(isFrameworkKey("wordpress")).toBe(true);
    expect(isFrameworkKey("unknown")).toBe(false);
    expect(isFrameworkKey("drupal")).toBe(false);
  });
});
