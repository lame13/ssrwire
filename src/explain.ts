import { type FrameworkDetection, type FrameworkKey, frameworkLabel } from "./framework.js";
import type { AuditResult, Finding, Severity, TargetAuditResult } from "./types.js";

/**
 * Human-facing reading of a machine finding.
 *
 * SSRWire's evidence is deliberately precise and terse. `explainFinding()` translates one
 * finding into what a person needs: what was seen, why it matters, and what to change. The
 * rendered detail is derived from the finding code and its evidence, so explanations stay in
 * step with machine reports without changing the persisted audit contract.
 */
export interface FindingExplanation {
  readonly code: string;
  readonly title: string;
  readonly means: string;
  readonly impact: string;
  readonly fix: string;
  readonly snippet?: FindingSnippet;
  /** True when no dedicated explanation exists and the text is derived from the raw finding. */
  readonly generic?: boolean;
}

export interface FindingSnippet {
  /** Label for the example, such as "Next.js App Router" or "Nuxt 3". */
  readonly label: string;
  readonly text: string;
}

export interface ExplanationContext {
  readonly framework?: FrameworkDetection;
}

const SUBJECT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  title: "title",
  description: "meta description",
  canonical: "canonical link",
  robots: "robots directives",
  "social-metadata": "social metadata",
});

const DRIFT_SUBJECTS: Readonly<Record<string, string>> = Object.freeze({
  status: "HTTP status",
  "final-url": "final URL",
  title: "title",
  canonical: "canonical URL",
  robots: "effective robots directives",
  "open-graph": "Open Graph metadata",
  "twitter-card": "Twitter Card metadata",
});

interface ExplanationTemplate {
  readonly title: string;
  readonly means: string;
  readonly impact: string;
  readonly fix: string;
}

const EXPLANATIONS: Readonly<Record<string, ExplanationTemplate>> = Object.freeze({
  "missing-title": {
    title: "No title in the HTML",
    means:
      "The response finished, but the HTML delivered to this crawler contained no non-empty " +
      "<title> element.",
    impact:
      "Search results fall back to the URL as the headline, and the page gives up the single " +
      "strongest signal it controls for ranking and for click-through.",
    fix: "Render a unique, descriptive <title> into the initial HTML response, not only after client-side JavaScript runs.",
  },
  "missing-description": {
    title: "No meta description",
    means: 'No non-empty <meta name="description"> appeared before the response finished.',
    impact:
      "Search engines write their own snippet, which often pulls in navigation text or an " +
      "unrelated paragraph, and social previews lose their summary line.",
    fix: "Add a 50–160 character summary as a meta description in the server-rendered HTML.",
  },
  "missing-canonical": {
    title: "No canonical URL",
    means: 'No non-empty <link rel="canonical"> appeared before the response finished.',
    impact:
      "When the same content is reachable at several URLs, search engines pick one themselves, " +
      "which can split ranking signals or surface the wrong address.",
    fix: "Emit one absolute canonical URL that names the preferred address for this page.",
  },
  "missing-h1": {
    title: "No H1 heading",
    means: "The HTML contained no non-empty <h1> element.",
    impact:
      "Readers, screen readers, and search engines lose the page's main heading, so the topic " +
      "is harder to identify at a glance.",
    fix: "Render the page's main heading as an <h1> in the server response.",
  },
  "missing-main-text": {
    title: "No main content in the first response",
    means: "No text inside <main> arrived with the HTML response.",
    impact:
      "Anyone, or any crawler, that does not execute JavaScript receives an empty page shell — " +
      "the most common cause of a page ranking well in a browser but not in search.",
    fix: "Render the primary article or product text inside <main> during server rendering.",
  },
  "multiple-robots": {
    title: "Several robots tags apply at once",
    means: "More than one meta robots tag applied to this crawler.",
    impact:
      "Crawlers combine the directives and the harshest one wins, so a leftover tag can quietly " +
      "remove a page from search results.",
    fix: "Keep a single meta robots tag per page, produced by one place in the code.",
  },
  "head-metadata-in-body": {
    title: "Crawler metadata arrived in the body",
    means:
      "Title, description, canonical, robots, or social tags were delivered inside <body> to a " +
      "crawler that only reads <head>.",
    impact:
      "Crawlers that read head metadata only — such as Bingbot and link-preview bots — never see " +
      "these values, even though a browser shows them normally.",
    fix:
      "Deliver SEO and social tags inside <head> for these user agents. The usual cause is a " +
      "framework that streams metadata into the body for browsers and never switches back to " +
      "head delivery for an HTML-limited bot.",
  },
  "invalid-json-ld": {
    title: "Structured data is not valid JSON",
    means: "At least one application/ld+json block could not be parsed.",
    impact:
      "Search engines discard the block, so rich results such as ratings, prices, or FAQs " +
      "silently disappear from listings.",
    fix: "Fix the JSON syntax in every structured-data block, and validate it with a schema checker.",
  },
  "json-ld-analysis-limit": {
    title: "Structured data exceeded an analysis limit",
    means: "A JSON-LD block was larger than SSRWire analyzes, so it was recorded but not checked.",
    impact:
      "A syntax error inside that block would go unreported, and very large blocks are usually a " +
      "sign of duplicated or generated markup.",
    fix: "Split oversized structured-data blocks into focused ones, or accept the reported gap.",
  },
  "missing-open-graph-metadata": {
    title: "Incomplete Open Graph metadata",
    means: "One or more of og:title, og:type, og:url, and og:image were missing.",
    impact:
      "Links shared to Facebook, LinkedIn, WhatsApp, Slack, or Discord lose their title, " +
      "description, or image and collapse into a bare URL.",
    fix: "Emit the four Open Graph properties in the server-rendered <head>.",
  },
  "missing-twitter-card-metadata": {
    title: "Incomplete Twitter Card metadata",
    means: "twitter:card, or a usable title, description, and image, were missing.",
    impact: "Links posted to X render as plain text instead of a preview card.",
    fix:
      "Emit twitter:card plus twitter:title, twitter:description, and twitter:image, or the " +
      "corresponding Open Graph values SSRWire falls back to.",
  },
  "invalid-social-metadata-url": {
    title: "A social preview URL is not absolute",
    means: "An og:url, og:image, or twitter:image value was not an absolute HTTP(S) URL.",
    impact:
      "Platforms resolve relative addresses inconsistently, so preview images go missing exactly " +
      "where the link is shared most.",
    fix: "Use absolute https:// URLs for every social metadata URL.",
  },
  "slow-first-byte": {
    title: "Slow first byte",
    means: "Response headers took longer than the configured budget for this target.",
    impact:
      "Crawlers and visitors wait longer before anything arrives, which delays indexing and " +
      "hurts perceived performance.",
    fix:
      "Measure the origin render separately from the CDN: a first byte above ~1 second is usually " +
      "an application or database problem, not a network one.",
  },
  "slow-critical-signals": {
    title: "Important metadata arrived late",
    means: "Required metadata was observed after the configured time budget for this target.",
    impact:
      "Crawlers with a short patience window may stop reading, or cache a version of the page " +
      "without the tag that arrived last.",
    fix: "Flush <head> metadata earlier in the response instead of streaming it near the end.",
  },
  "status-mismatch": {
    title: "Unexpected HTTP status",
    means: "The response status did not match the contract configured for this URL.",
    impact:
      "Crawlers react to the status before they read anything else: a 200 that should be a 404 " +
      "creates a soft 404, and an unexpected redirect can drop the URL.",
    fix: "Return the status this URL is meant to serve, or update the configured expectation.",
  },
  "final-url-mismatch": {
    title: "Unexpected final URL after redirects",
    means: "The request ended at a URL other than the configured expected final URL.",
    impact:
      "The final URL is the address crawlers index and the address social platforms attribute " +
      "shares to, so a wrong redirect rewrites how the page is stored and reported.",
    fix: "Point the redirect at the intended destination, or align expectedFinalUrl with it.",
  },
  "incomplete-probe": {
    title: "The check did not finish",
    means:
      "The response timed out, failed, was not HTML, or exceeded the configured byte limit, so " +
      "SSRWire could not confirm the rest of the document.",
    impact:
      "Everything after the failure point is unverified, and a stream that stalls mid-document is " +
      "usually visible to real visitors too.",
    fix:
      "Check the timeout, the response size limit, and whether the server stalls before closing " +
      "the HTML.",
  },
  "response-instability": {
    title: "Response changes between samples",
    means: "Repeated requests produced different HTTP or streamed HTML evidence.",
    impact:
      "Visitors and crawlers see inconsistent pages, which confuses indexing and makes ranking " +
      "behaviour hard to reproduce or debug.",
    fix:
      "Make the response deterministic, or make the variation intentional with a cache key and an " +
      "explicit canonical URL.",
  },
  "stream-instability": {
    title: "Streamed HTML changes between samples",
    means: "Repeated requests delivered the same URL with different streamed signal evidence.",
    impact:
      "Metadata that appears in one response and not the next cannot be relied on by search " +
      "engines or link previews.",
    fix: "Identify the source of variation — cache, personalization, or A/B tests — and pin it.",
  },
  "robots-header-noindex": {
    title: "A response header blocks indexing",
    means: "X-Robots-Tag sent noindex or none for the crawler that made this request.",
    impact:
      "The page is removed from search results no matter how complete the HTML is, and the HTML " +
      "itself gives no hint that it is happening.",
    fix:
      "Remove noindex/none from X-Robots-Tag. Check the CDN, the hosting platform, and staging " +
      "environment headers — not only the application templates.",
  },
  "robots-header-restrictive": {
    title: "A response header restricts the crawler",
    means:
      "X-Robots-Tag applied a restrictive directive such as nofollow, nosnippet, or noarchive.",
    impact:
      "Header directives apply to the whole response, override per-page intentions, and are easy " +
      "to leave behind after a migration or an incident.",
    fix:
      "Remove the directive, or scope it to the single user agent that needs it with " +
      "'X-Robots-Tag: <agent>: <directive>'.",
  },
  "robots-header-ineffective": {
    title: "A response header is overridden by the page",
    means:
      "X-Robots-Tag allowed indexing, but a meta robots tag in the HTML restricted it, so the " +
      "header had no effect.",
    impact:
      "The page stays excluded from search results while the header suggests it is allowed, which " +
      "makes the exclusion hard to find.",
    fix: "Remove either the header or the meta tag so one directive states the intent clearly.",
  },
});

const SNIPPETS: Readonly<Record<FrameworkKey, Readonly<Record<SnippetTheme, string>> | undefined>> =
  Object.freeze({
    nextjs: {
      metadata: `// app/product/page.tsx — the App Router Metadata API renders these tags into <head>
export const metadata = {
  title: "Product name",
  description: "One sentence about this page.",
  alternates: { canonical: "https://example.com/product" },
  openGraph: {
    title: "Product name",
    type: "article",
    url: "https://example.com/product",
    images: ["https://example.com/product.jpg"],
  },
};`,
      content: `// app/product/page.tsx — render real content, not a client-only shell
export default async function Page() {
  const product = await getProduct();
  return (
    <main>
      <h1>{product.name}</h1>
      <p>{product.summary}</p>
    </main>
  );
}`,
      delivery: `// next.config.ts — Next.js streams metadata to browsers by default.
// Add the crawlers that must receive a complete <head> instead.
const nextConfig = {
  htmlLimitedBots: /Googlebot|Bingbot|Twitterbot|facebookexternalhit|GPTBot|ClaudeBot/,
};`,
    },
    nuxt: {
      metadata: `<!-- pages/product.vue -->
<script setup>
useSeoMeta({
  title: "Product name",
  description: "One sentence about this page.",
  ogTitle: "Product name",
  ogType: "article",
  ogUrl: "https://example.com/product",
  ogImage: "https://example.com/product.jpg",
});
useHead({ link: [{ rel: "canonical", href: "https://example.com/product" }] });
</script>`,
      content: `<!-- pages/product.vue -->
<template>
  <main>
    <h1>{{ product.name }}</h1>
    <p>{{ product.summary }}</p>
  </main>
</template>`,
      delivery: `// nuxt.config.ts — metadata is rendered into <head> server-side by default.
// If a proxy reshapes the stream, verify the tags reach crawlers unchanged.
export default defineNuxtConfig({ ssr: true });`,
    },
    astro: {
      metadata: `---
// src/layouts/Base.astro
const { title, description, canonical, image } = Astro.props;
---
<head>
  <title>{title}</title>
  <meta name="description" content={description} />
  <link rel="canonical" href={canonical} />
  <meta property="og:title" content={title} />
  <meta property="og:type" content="article" />
  <meta property="og:url" content={canonical} />
  <meta property="og:image" content={image} />
</head>`,
      content: `---
// src/pages/product.astro
const product = await getProduct();
---
<main>
  <h1>{product.name}</h1>
  <p>{product.summary}</p>
</main>`,
      delivery: `---
// src/layouts/Base.astro — keep SEO tags in the layout head so every
// prerendered or SSR page ships them in the first response.
---
<slot />`,
    },
    sveltekit: {
      metadata: `<script lang="ts">
  // src/routes/product/+page.svelte
  export let data;
</script>

<svelte:head>
  <title>{data.title}</title>
  <meta name="description" content={data.description} />
  <link rel="canonical" href={data.canonical} />
  <meta property="og:title" content={data.title} />
  <meta property="og:type" content="article" />
  <meta property="og:url" content={data.canonical} />
  <meta property="og:image" content={data.image} />
</svelte:head>`,
      content: `<!-- src/routes/product/+page.svelte -->
<main>
  <h1>{data.product.name}</h1>
  <p>{data.product.summary}</p>
</main>`,
      delivery: `// src/routes/product/+page.server.ts — load data on the server so the
// first response already contains the page's content and metadata.
export function load() {
  return { product: getProduct() };
}`,
    },
    remix: {
      metadata: `// app/routes/product.tsx
import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [
  { title: "Product name" },
  { name: "description", content: "One sentence about this page." },
  { tagName: "link", rel: "canonical", href: "https://example.com/product" },
  { property: "og:title", content: "Product name" },
  { property: "og:type", content: "article" },
  { property: "og:url", content: "https://example.com/product" },
  { property: "og:image", content: "https://example.com/product.jpg" },
];`,
      content: `// app/routes/product.tsx — data comes from a server loader, so the
// first response already contains the heading and body text.
export async function loader() {
  return json({ product: await getProduct() });
}

export default function Product() {
  const { product } = useLoaderData<typeof loader>();
  return (
    <main>
      <h1>{product.name}</h1>
      <p>{product.summary}</p>
    </main>
  );
}`,
      delivery: `// app/root.tsx — Remix renders meta on the server by default.
// Verify any CDN or edge transform preserves the <head> order.
export default function App() {
  return <Outlet />;
}`,
    },
    laravel: {
      metadata: `{{-- resources/views/layouts/app.blade.php --}}
<head>
  <title>@yield('title', $title ?? config('app.name'))</title>
  <meta name="description" content="@yield('description')">
  <link rel="canonical" href="{{ $canonical ?? url()->current() }}">
  <meta property="og:title" content="@yield('title')">
  <meta property="og:type" content="article">
  <meta property="og:url" content="{{ $canonical ?? url()->current() }}">
  <meta property="og:image" content="@yield('ogImage')">
</head>`,
      content: `{{-- resources/views/product/show.blade.php --}}
@extends('layouts.app')

@section('content')
  <main>
    <h1>{{ $product->name }}</h1>
    <p>{{ $product->summary }}</p>
  </main>
@endsection`,
      delivery: `{{-- Keep SEO tags in the shared layout head rather than in a
     partial rendered after the body, so every response ships them together. --}}`,
    },
    wordpress: {
      metadata: `<?php
// functions.php — WordPress emits head tags through wp_head().
add_action('wp_head', function () {
    if (!is_singular()) {
        return;
    }
    $post_id = get_queried_object_id();
    printf('<meta name="description" content="%s">', esc_attr(get_the_excerpt($post_id)));
    printf('<link rel="canonical" href="%s">', esc_url(get_permalink($post_id)));
}, 1);
// A maintained SEO plugin (Yoast, Rank Math, SEOPress) covers the same ground.`,
      content: `<?php
// single.php — keep the heading inside the main content area so it is
// present in the server response rather than added by a client script.
?>
<main>
  <h1><?php the_title(); ?></h1>
  <?php the_content(); ?>
</main>`,
      delivery: `<?php
// header.php must call wp_head() inside <head> before </head>.
?><head>
  <?php wp_head(); ?>
</head>`,
    },
    php: {
      metadata: `<?php // templates/head.php — echo the tags into <head> server-side ?>
<head>
  <title><?= htmlspecialchars($title) ?></title>
  <meta name="description" content="<?= htmlspecialchars($description) ?>">
  <link rel="canonical" href="<?= htmlspecialchars($canonical) ?>">
  <meta property="og:title" content="<?= htmlspecialchars($title) ?>">
  <meta property="og:type" content="article">
  <meta property="og:url" content="<?= htmlspecialchars($canonical) ?>">
  <meta property="og:image" content="<?= htmlspecialchars($image) ?>">
</head>`,
      content: `<?php // Keep the page heading and body text in the rendered template ?>
<main>
  <h1><?= htmlspecialchars($product['name']) ?></h1>
  <p><?= htmlspecialchars($product['summary']) ?></p>
</main>`,
      delivery: `<?php // Render <head> completely before flushing the body so every
// crawler receives the same tag order, regardless of buffering. ?>`,
    },
    unknown: undefined,
  });

type SnippetTheme = "metadata" | "content" | "delivery";

const CODE_THEMES: Readonly<Record<string, SnippetTheme>> = Object.freeze({
  "missing-title": "metadata",
  "missing-description": "metadata",
  "missing-canonical": "metadata",
  "missing-open-graph-metadata": "metadata",
  "missing-twitter-card-metadata": "metadata",
  "missing-h1": "content",
  "missing-main-text": "content",
  "head-metadata-in-body": "delivery",
});

function snippetFor(
  code: string,
  framework: FrameworkDetection | undefined,
): FindingSnippet | undefined {
  if (framework === undefined || framework.key === "unknown") return undefined;
  const theme = CODE_THEMES[code];
  if (theme === undefined) return undefined;
  const text = SNIPPETS[framework.key]?.[theme];
  if (text === undefined) return undefined;
  return { label: `${framework.label} example`, text };
}

function repeatedExplanation(code: string): FindingExplanation | undefined {
  const match = /^(duplicate|conflicting)-(.+)$/.exec(code);
  const kind = match?.[1];
  const subject = match?.[2];
  if (kind === undefined || subject === undefined) return undefined;
  const label = SUBJECT_LABELS[subject] ?? subject.replaceAll("-", " ");
  const duplicated = kind === "duplicate";

  return {
    code,
    title: duplicated
      ? `The response contains more than one ${label}`
      : `The response contains conflicting ${label} values`,
    means: duplicated
      ? `Two or more ${label} values were delivered without conflicting with each other.`
      : `Two or more ${label} values disagree with each other.`,
    impact: duplicated
      ? `Crawlers pick one of the repeated values, and the choice is not guaranteed to be the ` +
        `one you intended.`
      : `Crawlers resolve the disagreement using their own rules, so different engines can store ` +
        `different values for the same page.`,
    fix: `Emit exactly one ${label} per response, from a single place in the code.`,
  };
}

function driftExplanation(code: string): FindingExplanation | undefined {
  const match = /^agent-(.+)-drift$/.exec(code);
  const subject = match?.[1];
  if (subject === undefined) return undefined;
  const label = DRIFT_SUBJECTS[subject] ?? subject.replaceAll("-", " ");

  return {
    code,
    title: `Different crawlers received a different ${label}`,
    means: `The crawler profiles in this run received different ${label} values for the same URL.`,
    impact:
      "Search engines and link previews will show different results depending on which one asks, " +
      "and the version visitors get may be a third one.",
    fix:
      "Serve one value to every crawler, or record why the difference is intentional. " +
      "Conditional responses are usually caused by user-agent branching or by a cache that stores " +
      "one variant and replays it to everyone.",
  };
}

function humanizeCode(code: string): string {
  const words = code.replaceAll("-", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function genericExplanation(finding: Finding): FindingExplanation {
  return {
    code: finding.code,
    title: humanizeCode(finding.code),
    means: finding.message,
    impact:
      "Review the raw evidence for this finding before deciding whether it changes anything for " +
      "visitors, crawlers, or link previews.",
    fix: "Inspect the recorded evidence, reproduce the response, and fix the underlying cause.",
    generic: true,
  };
}

/** Translate one finding into a human-readable explanation, with a fix recipe when available. */
export function explainFinding(
  finding: Finding,
  context: ExplanationContext = {},
): FindingExplanation {
  const template =
    EXPLANATIONS[finding.code] ??
    repeatedExplanation(finding.code) ??
    driftExplanation(finding.code);
  if (template === undefined) return genericExplanation(finding);

  const snippet = snippetFor(finding.code, context.framework);
  return {
    code: finding.code,
    title: template.title,
    means: template.means,
    impact: template.impact,
    fix: template.fix,
    ...(snippet === undefined ? {} : { snippet }),
  };
}

export type VerdictKind = "pass" | "attention" | "blocked" | "incomplete";

export interface AuditVerdict {
  readonly kind: VerdictKind;
  readonly headline: string;
  readonly detail: string;
}

function countSeverity(findings: readonly Finding[], severity: Severity): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A one-sentence reading of a single target, used by the terminal summary and the HTML report. */
export function targetVerdict(result: TargetAuditResult): AuditVerdict {
  const incomplete = result.probes.filter((probe) => probe.completion !== "complete").length;
  const errors = countSeverity(result.findings, "error");
  const warnings = countSeverity(result.findings, "warning");
  const infos = countSeverity(result.findings, "info");

  if (incomplete > 0) {
    return {
      kind: "incomplete",
      headline: "The check did not finish for every crawler",
      detail:
        `${plural(incomplete, "probe")} of ${result.probes.length} stopped before completion, ` +
        "so the response is only partly verified.",
    };
  }
  if (errors > 0) {
    return {
      kind: "blocked",
      headline: "Crawlers do not receive what this page promises",
      detail: `${plural(errors, "blocking issue")} and ${plural(warnings, "warning")} found.`,
    };
  }
  if (warnings > 0) {
    return {
      kind: "attention",
      headline: "The page works, with room to improve",
      detail: `${plural(warnings, "warning")} to review.`,
    };
  }
  if (infos > 0) {
    return {
      kind: "pass",
      headline: "Every checked crawler received the expected HTML",
      detail: `${plural(infos, "informational note")} recorded and no policy findings.`,
    };
  }
  return {
    kind: "pass",
    headline: "Every checked crawler received the expected HTML",
    detail: "No policy findings for this target.",
  };
}

/** A one-sentence reading of a complete run. */
export function auditVerdict(audit: AuditResult): AuditVerdict {
  const { summary } = audit;
  if (summary.incomplete > 0) {
    return {
      kind: "incomplete",
      headline: "Not every page could be checked",
      detail:
        `${plural(summary.incomplete, "probe")} of ${summary.probes} stopped early, so those ` +
        "responses are only partly verified.",
    };
  }
  if (summary.errors > 0) {
    const targets = new Set(
      audit.results
        .filter((result) => result.findings.some((finding) => finding.severity === "error"))
        .map((result) => result.target.id ?? result.target.url),
    );
    const affected =
      targets.size === 1
        ? "1 page needs attention before release"
        : `${targets.size} pages need attention before release`;
    return {
      kind: "blocked",
      headline: affected,
      detail:
        `${plural(summary.errors, "blocking issue")} and ${plural(summary.warnings, "warning")} ` +
        `found across ${plural(summary.targets, "target")}.`,
    };
  }
  if (summary.warnings > 0) {
    return {
      kind: "attention",
      headline: "Nothing blocks indexing, but the run found things to fix",
      detail:
        `${plural(summary.warnings, "warning")} across ${plural(summary.targets, "target")}, ` +
        "with no errors.",
    };
  }
  return {
    kind: "pass",
    headline: "Every checked crawler received the expected HTML",
    detail:
      `${plural(summary.targets, "target")} and ${plural(summary.probes, "probe")} passed every ` +
      "configured contract.",
  };
}

/** Distinct fixes worth acting on, in severity order, for terminal and report summaries. */
export interface NextStep {
  readonly severity: Severity;
  readonly title: string;
  readonly fix: string;
  readonly occurrences: number;
}

export function nextSteps(
  findings: readonly Finding[],
  context: ExplanationContext = {},
): readonly NextStep[] {
  const order: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };
  const groups = new Map<string, { step: NextStep; severity: Severity }>();

  for (const finding of findings) {
    const explanation = explainFinding(finding, context);
    const existing = groups.get(explanation.code);
    if (existing === undefined) {
      groups.set(explanation.code, {
        severity: finding.severity,
        step: {
          severity: finding.severity,
          title: explanation.title,
          fix: explanation.fix,
          occurrences: 1,
        },
      });
      continue;
    }
    existing.step = { ...existing.step, occurrences: existing.step.occurrences + 1 };
    if (order[finding.severity] < order[existing.severity]) {
      existing.severity = finding.severity;
      existing.step = { ...existing.step, severity: finding.severity };
    }
  }

  return [...groups.values()]
    .map((group) => group.step)
    .sort((left, right) => {
      const bySeverity = order[left.severity] - order[right.severity];
      if (bySeverity !== 0) return bySeverity;
      return right.occurrences - left.occurrences || left.title.localeCompare(right.title);
    });
}

/** Human label for a framework detection, used in report headers and fix recipes. */
export function detectedFrameworkLabel(detection: FrameworkDetection | undefined): string {
  return frameworkLabel(detection?.key ?? "unknown");
}
