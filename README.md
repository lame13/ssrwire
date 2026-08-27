# SSRWire

[![CI](https://github.com/lame13/ssrwire/actions/workflows/ci.yml/badge.svg)](https://github.com/lame13/ssrwire/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ssrwire.svg)](https://www.npmjs.com/package/ssrwire)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Inspect streamed SSR HTML, SEO and social metadata timing, and crawler-specific
delivery from the command line.

SSRWire makes a real HTTP request for each selected user-agent profile, reads
the response incrementally, and records when important SEO and social-preview
signals become observable to its parser. It reports their elapsed time,
observed byte position, and document location without launching a browser or
executing JavaScript.

```bash
npx ssrwire https://example.com/product
```

## Why this exists

Modern SSR output is not always one complete HTML document delivered at once:

- metadata may arrive later than the first meaningful content;
- a framework may intentionally stream metadata into `<body>` for a capable
  crawler while blocking for an HTML-limited bot;
- browser, search-crawler, and social-crawler user agents may receive different
  titles, canonicals, social-preview metadata, robots directives, redirects, or
  statuses;
- the same URL and user agent may receive inconsistent SSR output between requests;
- an interrupted or oversized stream may never deliver the expected elements;
- a working hydrated page can hide thin or incomplete source HTML.

SSRWire turns those behaviors into small, repeatable HTTP-level checks. It is
not a browser, a JavaScript renderer, a packet capture, or a replacement for a
site crawler.

## Requirements

- Node.js 22.12.0 or newer
- No browser installation

Run it without installing:

```bash
npx ssrwire https://example.com/
npx ssrwire https://example.com/ https://example.com/pricing/
```

Or add it to a project:

```bash
npm install --save-dev ssrwire
npx ssrwire init
npx ssrwire check
```

## Quick start

Create `ssrwire.config.yml`:

```bash
npx ssrwire init
```

Then run all configured targets:

```bash
npx ssrwire check
npx ssrwire check --format json --output reports/ssrwire.json
npx ssrwire check --format sarif --output reports/ssrwire.sarif
```

One-off checks need no config:

```bash
npx ssrwire check \
  https://example.com/ \
  https://example.com/pricing/ \
  --agent browser \
  --agent googlebot \
  --fail-on warning
```

The root command and `check` are equivalent, so `npx ssrwire URL` is the short
form of `npx ssrwire check URL`.

## What it observes

For each target, agent, and configured sample, SSRWire captures:

- response status, final URL, redirect chain, and an allowlisted response-header snapshot;
- time to response headers, first response-body bytes, and completed body;
- total bytes delivered to the stream parser and a body fingerprint;
- title, meta description, canonical, meta robots, Open Graph, Twitter Card,
  H1, first main-content text, and JSON-LD blocks;
- elapsed arrival time, observed byte position, and `head`/`body` location for
  each signal;
- clean completion, timeout, network failure, invalid response, or configured
  byte-limit termination.

It then checks:

| Contract | Default finding |
|---|---|
| Unexpected status or configured final URL | Error |
| Missing or explicit non-HTML `Content-Type` | Error / incomplete run |
| Missing title | Error |
| Missing description, canonical, H1, or main text | Warning |
| Duplicate or conflicting title, description, canonical, or robots values | Warning |
| Missing an enabled Open Graph or Twitter Card contract | Warning |
| Invalid social metadata URL or conflicting scalar social metadata | Warning |
| Invalid JSON-LD | Warning |
| JSON-LD block/count exceeds the bounded analysis budget | Warning |
| Critical or enabled social metadata in `<body>` for a profile that requires head metadata | Error |
| Status, final URL, title, canonical, robots, or enabled social metadata drift between profiles | Warning |
| Completion, status, final URL, or redirect-chain drift between samples | Warning |
| Metadata value or document-location drift between complete samples | Warning |
| Exact body fingerprint drift without metadata drift | Information |
| First byte or required-signal arrival over a configured limit | Warning |
| Timeout, truncation, network error, or another incomplete probe | Error / incomplete run |

Body-located metadata is not inherently an error. SSRWire only fails it for an
agent whose profile declares `requiresHeadMetadata: true`. This matters for
frameworks such as Next.js that can deliberately stream metadata differently
for JavaScript-capable and HTML-limited bots.

## Agent profiles

The default run uses:

| Key | Intended view | Requires metadata in `<head>` |
|---|---|---:|
| `browser` | Normal browser user agent | No |
| `googlebot` | Googlebot user agent | No |
| `bingbot` | Bingbot user agent | Yes |
| `twitterbot` | X/Twitter link-preview user agent | Yes |

`facebook` is also built in and can be selected explicitly. A repeated CLI
`--agent` list replaces the configured/default list for that run:

```bash
npx ssrwire https://example.com/ --agent googlebot --agent facebook
```

These profiles send user-agent strings; they do not prove how a real crawler
will fetch, render, index, or cache a page. SSRWire does not perform crawler IP
or reverse-DNS verification. `requiresHeadMetadata` is SSRWire's default audit
policy for a profile, not a guarantee about that crawler's current parser or
rendering capabilities; use a custom profile when your contract differs.

Generic `robots` directives apply to every profile. Matching `googlebot` and
`bingbot` directives are combined with the generic directives, with restrictive
rules winning. SSRWire keeps audiences separate for duplicate checks and warns
when a crawler-specific permissive rule cannot relax a generic restriction.

Custom profiles are supported in configuration:

```yaml
agents:
  - browser
  - key: internal-preview-bot
    label: Internal preview bot
    userAgent: ExamplePreviewBot/1.0
    requiresHeadMetadata: true
```

## Social preview metadata

Every probe captures these bounded, ordered metadata signals when they arrive
before completion or termination:

- Open Graph: `og:title`, `og:type`, `og:url`, `og:image`, and
  `og:description`;
- Twitter Card: `twitter:card`, `twitter:title`, `twitter:description`, and
  `twitter:image`.

SSRWire accepts either the conventional `property` attribute or a `name`
attribute for those keys. Each captured value carries the same arrival time,
observed byte position, and document location as the existing metadata
signals. The terminal report shows a compact readiness table whenever social
metadata is observed or required, while JSON retains every captured value.

Social policy is opt-in per target. `openGraph: true` requires the four basic
[Open Graph protocol](https://ogp.me/) properties: title, type, URL, and image.
The `twitterCard: true` option requires `twitter:card` plus a usable title,
description, and image; SSRWire prefers the corresponding `twitter:*` value
and falls back to `og:title`, `og:description`, or `og:image`. These are
explicit SSRWire audit contracts, not a claim that a social platform will
render a particular preview.

Enabled contracts also participate in critical-signal timing, head/body
policy, cross-agent drift, and repeated-sample stability checks. URL-valued
fields must be absolute HTTP or HTTPS URLs. Open Graph permits multiple images,
so SSRWire retains them in order without treating the array as a scalar
conflict; the first non-empty image satisfies readiness.

When both options are false, SSRWire still records and reports raw social
signals but emits no social-policy or social-drift findings. It does not fetch
images, verify dimensions or media types, execute JavaScript, or simulate a
platform's rendered preview.

## Configuration

SSRWire automatically looks for `ssrwire.config.yml`,
`ssrwire.config.yaml`, or `ssrwire.config.json`. An explicit `--config` path
takes precedence.

```yaml
targets:
  - url: https://example.com/
    expectedStatus: 200
    expectedFinalUrl: https://example.com/
    require:
      title: true
      description: true
      canonical: true
      h1: true
      mainText: true
      openGraph: true
      twitterCard: true
    maxFirstByteMs: 1200
    maxCriticalMs: 2500

  - url: https://example.com/not-found/
    expectedStatus: [404]
    require:
      title: true
      description: false
      canonical: false
      h1: true
      mainText: true
      openGraph: false
      twitterCard: false

agents:
  - browser
  - googlebot
  - bingbot
  - twitterbot

headers:
  x-preview-token: "${PREVIEW_TOKEN}"

timeoutMs: 15000
maxBytes: 10485760
maxRedirects: 10
repeat: 1
```

A target can also be a plain URL string when defaults are sufficient:

```yaml
targets:
  - https://example.com/
  - https://example.com/pricing/
```

Defaults:

- expected status: `200`;
- title, description, canonical, H1, and main text: required;
- Open Graph and Twitter Card contracts: disabled;
- agents: `browser`, `googlebot`, `bingbot`, and `twitterbot`;
- timeout: 15 seconds per probe;
- response limit: 10 MiB;
- redirect limit: 10;
- samples per target and agent: 1, with an allowed range of 1–10.

Unknown configuration keys are rejected. URLs must be absolute HTTP or HTTPS
URLs and cannot contain embedded credentials.

### Protected previews

Header values can interpolate environment variables. Export them in the
current shell or provide them through the CI secret store; SSRWire does not
load `.env` files itself.

```bash
export PREVIEW_TOKEN="..."
npx ssrwire check
```

For an ephemeral override:

```bash
npx ssrwire https://preview.example.com/ \
  --header "x-preview-token: $PREVIEW_TOKEN"
```

CLI headers override a configured header with the same case-insensitive name.
SSRWire rejects `Accept-Encoding`, `Host`, `Content-Length`, `Connection`,
`Transfer-Encoding`, and `User-Agent` overrides. Custom headers are sent to the
initial origin and same-origin redirects only; the first cross-origin redirect removes them for
the rest of that probe. Request-header configuration is not serialized. The
CLI and `runAudit()` redact known values and common URL/base64 encodings from
the complete probe, including parsed HTML signals, response-header snapshots,
redirects, and errors. A target can apply an unknown transformation before
reflecting a secret, so review reports from untrusted targets before sharing
them. Direct low-level `probeUrl()` callers should apply `redactProbe()` before
persisting results.

The final response must declare `text/html` or `application/xhtml+xml` as its
`Content-Type`; parameters such as `charset=utf-8` are allowed. SSRWire does not
sniff headerless, JSON, text, or binary responses for HTML-looking fragments.

To keep hostile or accidentally huge pages bounded, SSRWire retains at most
256 signals of each repeated metadata kind, including each supported social
property, analyzes at most 64 JSON-LD blocks, and captures at most 1,048,576
characters from one JSON-LD block. Exceeding a JSON-LD analysis budget produces
a dedicated warning rather than being mislabeled as invalid JSON. The
configured response-byte limit remains the outer bound.

## Timing interpretation

SSRWire reports when its own process observed bytes and parsed elements. That
is useful for regression testing, but it is not a record of the application's
original `flush()` calls or network packets.

CDNs, reverse proxies, compression, TLS, HTTP implementations, and local
buffering can split or coalesce data before the process receives it. Agent
profiles are requested separately, and network/cache variance can affect their
times. Use timing thresholds with margin and compare repeated CI runs from a
stable location. Treat byte positions as parser-observation offsets, not
transfer-size or packet-boundary evidence. They count bytes delivered by the
Fetch implementation to SSRWire; those bytes are post-content-decoding when a
server ignores SSRWire's `Accept-Encoding: identity` request.

## Repeated sampling

Use repeated sampling when one successful request does not prove that SSR output
is stable:

```bash
npx ssrwire check --repeat 3
```

`repeat` is the total number of samples, not a retry count. SSRWire retains
failures instead of replacing them with a later success. Samples for one
target-agent pair run sequentially; different target-agent pairs may still run
concurrently. SSRWire does not add delays, cache-busting parameters, or special
cache headers.

The request count is `targets × agents × repeat`, plus redirect hops. Configured
same-origin headers are sent for every sample and retain the existing
cross-origin stripping and report-redaction behavior.

For repeated runs, terminal reports include individual sample numbers and a
per-agent timing table. JSON retains every probe and adds per-agent stability
summaries. The summaries report sample count, minimum, median, nearest-rank p95,
maximum, and spread for available header, first-byte, required-signal, and
completion timings. With small sample counts, nearest-rank p95 will often equal
the maximum.

Timing spread alone is evidence, not a failure. Network and cache variation can
change timings without changing the response contract. SSRWire warns when HTTP
response evidence or streamed metadata changes across samples. Enabled social
contracts are included in metadata stability; observed social tags remain
evidence-only when their contracts are disabled. Exact body-hash variation by
itself is informational because timestamps, nonces, and other legitimate
dynamic values commonly change source HTML.

## CLI reference

```text
ssrwire [urls...] [options]
ssrwire check [urls...] [options]
ssrwire init [path] [--force]
```

Check options:

| Option | Purpose |
|---|---|
| `-c, --config <path>` | Use a specific YAML or JSON config |
| `-a, --agent <name>` | Select a built-in agent; repeatable |
| `-H, --header "Name: value"` | Add/override a request header; repeatable |
| `--timeout <ms>` | Override request timeout |
| `--max-bytes <bytes>` | Override response-body limit |
| `--max-redirects <count>` | Override redirect limit |
| `--repeat <count>` | Run 1–10 sequential samples per URL and agent |
| `-f, --format <format>` | `terminal`, `json`, or `sarif` |
| `-o, --output <path>` | Write the report to a file |
| `--fail-on <level>` | `error`, `warning`, or `never` |
| `--no-color` | Disable terminal color |

Config-file targets and CLI URLs are combined, with exact duplicate URLs
removed.

## Reports and exit codes

- `terminal`: compact sample, social-readiness, aggregate-timing, and finding
  tables for local use.
- `json`: structured machine-readable evidence, including every probe and timing
  signal plus repeated-run stability summaries.
- `sarif`: findings suitable for GitHub Code Scanning and other SARIF 2.1.0
  consumers.

Exit codes are stable:

- `0`: the run completed and passed the selected policy;
- `1`: the run completed but crossed the `--fail-on` threshold;
- `2`: configuration/setup failure or incomplete probe evidence.

`--fail-on never` suppresses policy failures, but it never converts an
incomplete probe into a pass.

## GitHub Actions

Copy [examples/github-actions.yml](examples/github-actions.yml) into the site
repository and commit [examples/ssrwire.config.yml](examples/ssrwire.config.yml)
as `ssrwire.config.yml`. Store preview credentials as repository or environment
secrets. The example deliberately withholds those credentials from pull-request
runs because the checked-out configuration is controlled by that pull request;
credentialed checks run only after trusted code reaches the protected branch or
through a manual dispatch. Keep PR targets public and credential-free. If the
main audit requires `${PREVIEW_TOKEN}`, point the PR step at a separate
credential-free configuration or remove the PR trigger.

The workflow always keeps the SARIF file as a downloadable artifact. It also
uploads findings to Code Scanning for public repositories. Private/internal
repositories can remove the public-only condition after GitHub Code Security is
enabled for that repository.

This repository's own CI tests Node.js 22.12.0 and 24, runs the packaged CLI smoke
test on macOS and Windows, validates the npm tarball, and builds and executes
the Docker image. It contains no automatic npm publishing job; npm releases
are made manually from a local interactive terminal.

## Docker

The image is a small, browser-free Node.js runtime and runs as the non-root
`node` user:

```bash
docker build -t ssrwire .
docker run --rm ssrwire https://example.com/
```

Run a mounted configuration:

```bash
docker run --rm \
  --env PREVIEW_TOKEN \
  --volume "$PWD/ssrwire.config.yml:/work/ssrwire.config.yml:ro" \
  --workdir /work \
  ssrwire check
```

## Programmatic API

The package exports the probe, parser, analysis, and reporter primitives used
by the CLI:

```ts
import { loadConfig, renderJson, runAudit } from "ssrwire";

const config = await loadConfig({ urls: ["https://example.com/"], repeat: 3 });
const audit = await runAudit(config);
process.stdout.write(renderJson(audit));
```

Treat the JSON report's top-level `version` as the SSRWire software version,
not a promise that every nested field will remain unchanged across major
versions.

## Scope

SSRWire does not execute JavaScript, inspect a hydrated DOM, render social
previews, fetch social images, measure Core Web Vitals, discover URLs, validate
indexing, bypass access controls, perform load testing, or emulate a crawler's
rendering pipeline. Use
[RoutePlay](https://github.com/lame13/routeplay) for server HTML versus a cold
browser versus real client-side navigation. Use
[RouteLint](https://github.com/lame13/routelint) for route discovery,
indexability, and technical SEO policy.

Run SSRWire only against targets you are authorized to inspect. Keep target
lists and repeat counts intentionally small. It is a consistency sampler, not a
load generator.

## Development

```bash
npm ci
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md),
[CHANGELOG.md](CHANGELOG.md), and [PUBLISHING.md](PUBLISHING.md).

MIT licensed. Built by [Niko M.](https://nikom.work).
