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

Add `--format html --output ssrwire.html` for a shareable report with findings, timing evidence,
and suggested fixes.

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
npx ssrwire check --format html --output reports/ssrwire.html
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

## Check a whole site

Point SSRWire at a sitemap instead of listing URLs by hand:

```bash
npx ssrwire check --sitemap https://example.com/sitemap.xml
npx ssrwire check --sitemap ./public/sitemap.xml \
  --sitemap-include '/products/*' \
  --sitemap-exclude '/products/archive/*' \
  --sitemap-limit 200
```

`--sitemap` accepts an HTTP(S) URL or a local path, including a gzipped `.gz` file. Remote indexes
and redirects stay on the source origin. Local indexes may name remote child sitemaps.
An unreadable child is reported on stderr; URLs from readable children are kept.
Discovery stops at `--sitemap-limit` (default 100) or 20 sitemap requests. Each document has a
10 MiB limit, including decompressed gzip content. HTTP requests time out after 15 seconds.

Each discovered URL gets a stable id derived from its path, so `https://www.example.com/pricing/`
and `https://preview.example.net/pricing/` both become `pricing` and match in `ssrwire compare`.
Paths that produce the same id get a path/query hash suffix; keep explicit ids if the set of
colliding routes changes between deployments. Explicit configuration and CLI targets take
precedence over the sitemap entry for the same URL.

A large sitemap multiplies the request count, so `--concurrency` (1–16, default 4) bounds how many
probes run at once. SSRWire adds no delays or cache-busting parameters: respect the `crawl-delay`
and rate limits of any site you point it at.

## Compare deployments

SSRWire can compare two JSON audits without making more network requests. Give
the same logical target a stable `id` in each environment so reports can match
across different origins:

```yaml
# production.yml
targets:
  - id: home
    url: https://www.example.com/
  - id: pricing
    url: https://www.example.com/pricing/
```

```yaml
# preview.yml
targets:
  - id: home
    url: https://preview.example.net/
  - id: pricing
    url: https://preview.example.net/pricing/
```

Capture and compare the already-redacted reports:

```bash
npx ssrwire check --config production.yml --format json --output production.json
npx ssrwire check --config preview.yml --format json --output preview.json

npx ssrwire compare production.json preview.json
npx ssrwire compare production.json preview.json \
  --format html \
  --output ssrwire-diff.html
```

The comparison classifies candidate-only warning/error findings and newly
incomplete probes as regressions, resolved findings and material timing
improvements as fixed, and response or metadata differences as neutral changes.
A metadata change becomes a regression when it causes a candidate policy
finding, such as required metadata disappearing or head-only crawler metadata
moving into the body.

Timing regressions use per-agent medians and require both an absolute increase
over 250 ms and a relative increase over 25% by default. Both floors are
configurable on `compare`; small timing differences remain visible in the HTML
waterfall without making CI noisy. `--fail-on regression` is the comparison
default, while `--fail-on never` always exits successfully after valid reports
are compared.

The HTML report is one self-contained, script-free file with synchronized
baseline and candidate milestones. It never embeds raw response HTML. SSRWire
does not create or update baseline files automatically.

Reports without target IDs match by exact target URL. IDs must be unique within
one report, so an ID mismatch is shown as one removed and one added target
instead of being guessed. Comparison requires the explicit `schemaVersion: 1`
audit contract emitted by SSRWire 0.4.0–0.5.0, or `schemaVersion: 2` written by SSRWire 0.6.0.
Reports from either version can be compared with each other.

## Baselines

Keep a baseline in the repository to check each deployment against an accepted audit:

```bash
# Record the current output as the baseline to compare against from now on.
npx ssrwire check --format json --baseline ssrwire.baseline.json --update-baseline

# Later runs compare automatically and fail on a regression.
npx ssrwire check --baseline ssrwire.baseline.json --fail-on error
```

`--baseline <path>` reads a stored JSON audit, compares this run against it with the same
classification rules as `ssrwire compare`, and exits `1` when a regression appears (unless
`--fail-on never`). `--update-baseline` writes the current run to that path instead of comparing;
without `--baseline` it defaults to `ssrwire.baseline.json`. The comparison is printed to stderr so
stdout keeps exactly one machine-readable report. Incomplete audits do not replace a baseline,
and `--output` must use a different path from `--baseline`.

Review baseline updates like other JSON changes. SSRWire only writes a baseline when you pass
`--update-baseline`.

## Waivers

Some findings are known, accepted, and tracked elsewhere. Record them instead of ignoring the whole
check:

```yaml
ignore:
  - code: missing-description
    target: home
    reason: tracked in SEO-1487
    until: 2026-12-31
  - code: robots-txt-disallowed
    agent: gptbot
    reason: AI crawlers are opted out by policy
```

A waiver matches on `code` (or `*`), and optionally narrows by `target` (a target id or an exact
URL) and `agent`. A nonblank `reason` is required. Waived findings are excluded from severity
counts and policy failures. Reports retain the configured waivers and `summary.waived` count;
they do not retain the suppressed findings. An incomplete probe still exits `2`, even if its
finding is waived. Select `gptbot` in `agents` to use the second example above.

After `until` passes, the waiver stops suppressing findings and produces a `waiver-expired`
warning. A waiver that suppresses nothing produces a `waiver-unused` note. Dates are inclusive
and use UTC: a waiver dated today still applies. Unknown target and agent references are rejected
when configuration loads.

## Readable reports

`check --format html` writes one self-contained, script-free file that anyone can open, email, or
attach to an issue — no terminal, no build step, and no remote assets:

```bash
npx ssrwire check --format html --output ssrwire.html
```

The report leads with a one-sentence verdict per target. Each finding then reads as what SSRWire
observed, why it matters, and what to do, followed by probe timings, streaming arrival order,
social-preview readiness, and a card showing how a shared link would be described.

Fix recipes adapt to the stack that answered. SSRWire reads `x-powered-by` and `x-nextjs-cache`
from the response, falls back to the `package.json` or `composer.json` of the working directory,
and accepts an explicit choice:

```bash
npx ssrwire check --format html --framework nuxt --output ssrwire.html
npx ssrwire check --format html --framework none --output ssrwire.html
```

`--framework` accepts `auto` (the default), `none`, or one of `nextjs`, `nuxt`, `astro`,
`sveltekit`, `remix`, `laravel`, `wordpress`, and `php`. Detection never changes which findings a
run produces; it only selects the example snippet that accompanies a fix, and an unrecognized
stack simply leaves the recipe stack-neutral.

The preview card prints the Open Graph and Twitter Card values captured from the response and shows
the image URL as text. SSRWire does not fetch or render the image, so the report stays a single
offline file with no requests of its own.

Terminal output includes a result for each target and a "What to do" list ordered by severity.

## What it observes

For each target, agent, and configured sample, SSRWire captures:

- response status, final URL, redirect chain, and an allowlisted response-header snapshot that
  includes `X-Robots-Tag`, cache, and framework headers;
- time to response headers, first response-body bytes, and completed body;
- total bytes delivered to the stream parser and a body fingerprint;
- how the body arrived, in client-observed chunks: chunk count, streamed span, longest gap
  between chunks, and total idle time;
- the robots.txt verdict for that profile and origin, when robots.txt could be read;
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
| `X-Robots-Tag` that removes the page from search results for a profile | Error |
| `X-Robots-Tag` that restricts a profile while keeping the page indexed | Warning |
| Permissive `X-Robots-Tag` that a meta robots tag overrides | Information |
| robots.txt that disallows the profile's crawler | Error |
| robots.txt disallows the crawler while meta robots still permits indexing | Warning |
| robots.txt could not be read, so crawler access is undefined | Information |
| A response body that ignores `Accept-Encoding: identity` | Information |
| A waiver that has expired, or one that matched no finding | Warning / Information |
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

`facebook` and the AI crawlers below are also built in. A repeated CLI `--agent`
list replaces the configured/default list for that run:

```bash
npx ssrwire https://example.com/ --agent googlebot --agent facebook
npx ssrwire https://example.com/ --agent browser --agent gptbot --agent claudebot
```

AI and answer-engine crawlers can be selected by key or alias:

| Key | Alias examples | Intended view | Requires metadata in `<head>` |
|---|---|---:|---:|
| `gptbot` | `gpt`, `openai` | OpenAI GPTBot training crawler | No |
| `oai-searchbot` | `searchbot` | OpenAI search index crawler | No |
| `chatgpt-user` | `chatgpt` | ChatGPT on-demand fetch for a user request | No |
| `claudebot` | `claude`, `anthropic` | Anthropic ClaudeBot | No |
| `perplexitybot` | `perplexity` | PerplexityBot | No |

These profiles read the whole document without executing JavaScript, so their
default policy does not require head-only delivery. Each user-agent string
carries the published product token — the part user-agent branching on a target
actually matches — while the surrounding browser tokens and version numbers
change over time.

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

## robots.txt

Each run reads `robots.txt` once per target origin using SSRWire's own user agent, without custom
headers, then matches the rules against each selected profile. The evidence describes the
requested URL, before page redirects. SSRWire still fetches disallowed pages so you can inspect
their HTML. It does not enforce robots.txt or `crawl-delay` as a request scheduler.

Matching follows the usual longest-rule-wins behaviour, where `Allow` wins an equally specific tie,
`*` spans any characters, and a trailing `$` anchors to the end of the path. A group whose user
agent token appears in the profile's user agent string beats the `*` group. Equally specific
groups are combined. See the [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html).

Findings are reported per target and agent:

- `robots-txt-disallowed` (error) — robots.txt asks the crawler not to fetch this URL;
- `robots-txt-conflict` (warning) — robots.txt blocks the crawler while meta robots still permits
  indexing, so the page looks indexable in source but is unreachable;
- `robots-txt-unavailable` (information) — robots.txt answered with a server error or could not be
  read, so crawler access is undefined rather than assumed.

A 4xx response is treated as "no robots.txt" and allows everything under this audit policy.
SSRWire matches user agent tokens as substrings of the profile's user agent string and does not
perform crawler IP or reverse-DNS verification, so treat the verdict as the published policy rather
than as proof of what a specific crawler will do.

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
  - id: home
    url: https://example.com/
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

  - id: not-found
    url: https://example.com/not-found/
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
concurrency: 4

ignore:
  - code: missing-description
    target: home
    reason: tracked in SEO-1487
    until: 2026-12-31
```

A target can also be a plain URL string when defaults are sufficient:

```yaml
targets:
  - https://example.com/
  - https://example.com/pricing/
```

Use the object form with a stable `id` when reports from different origins will
be compared. IDs are 1–64 ASCII letters, digits, dots, underscores, or hyphens,
and must start with a letter or digit.

Defaults:

- expected status: `200`;
- title, description, canonical, H1, and main text: required;
- Open Graph and Twitter Card contracts: disabled;
- agents: `browser`, `googlebot`, `bingbot`, and `twitterbot`;
- timeout: 15 seconds per probe;
- response limit: 10 MiB;
- redirect limit: 10;
- samples per target and agent: 1, with an allowed range of 1–10;
- parallel probes: 4, with an allowed range of 1–16.

Unknown configuration keys are rejected. URLs must be absolute HTTP or HTTPS
URLs and cannot contain embedded credentials. Declaring one URL twice with
different expectations or target IDs is rejected instead of silently keeping
the first contract.

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
`Content-Type`; parameters such as `charset=utf-8` are allowed. SSRWire decodes
the body using a leading byte-order mark first, then a supported charset from
that parameter, then an in-document encoding declaration found within the first
1024 bytes, and otherwise UTF-8. SSRWire does not sniff headerless,
JSON, text, or binary responses for HTML-looking fragments.

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

The page request count is `targets × agents × repeat`, plus redirect hops. Add one robots.txt
request per target origin and any sitemap discovery requests. Configured
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

## CI and test suites

Beyond `terminal`, `json`, `sarif`, and `html`, `check` can write a `junit` report for CI systems
that consume test results, `markdown` for a pull-request comment, or `github` for annotations in
the workflow run:

```bash
npx ssrwire check --format junit --output reports/ssrwire.xml
npx ssrwire check --format markdown --output reports/ssrwire.md
npx ssrwire check --format github
```

JUnit has a test case per probe and an extra case for target-wide findings when needed. A case
with errors uses `<error>`; one with warnings only uses `<failure>`. Informational findings stay
in suite output. This mapping is independent of `--fail-on`, so a CI test-report consumer may fail
on warnings even when the CLI exits `0`. GitHub output emits one `::error`, `::warning`, or
`::notice` line per finding. `compare` supports `markdown` and `github` too, where regressions
become annotations.

For deployments, the comparison engine is also available as an assertion:

```ts
import { readFile } from "node:fs/promises";
import { expectNoRegressions, loadConfig, parseAuditReportText, runAudit } from "ssrwire";

const config = await loadConfig();
const baseline = parseAuditReportText(await readFile("ssrwire.baseline.json", "utf8"));
const candidate = await runAudit(config);

expectNoRegressions(baseline, candidate);
```

`expectNoRegressions()` throws a `RegressionError` with up to five regression details and the full
comparison on its `comparison` property. It works with any test runner.

## CLI reference

```text
ssrwire [urls...] [options]
ssrwire check [urls...] [options]
ssrwire compare <baseline.json> <candidate.json> [options]
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
| `--concurrency <count>` | Run 1–16 probes in parallel (default 4) |
| `--sitemap <source>` | Discover targets from a sitemap URL or local file |
| `--sitemap-include <glob>` | Keep only sitemap paths matching this glob; repeatable |
| `--sitemap-exclude <glob>` | Drop sitemap paths matching this glob; repeatable |
| `--sitemap-limit <count>` | Maximum page URLs taken from the sitemap (default 100) |
| `--baseline <path>` | Compare this run against a stored JSON baseline |
| `--update-baseline` | Write this run to the baseline path instead of comparing |
| `-f, --format <format>` | `terminal`, `json`, `sarif`, `html`, `junit`, `markdown`, or `github` |
| `-o, --output <path>` | Write the report to a file |
| `--fail-on <level>` | `error`, `warning`, or `never` |
| `--framework <name>` | Fix recipes for `auto`, `none`, or a framework name |
| `--no-color` | Disable terminal color |

Config-file targets and CLI URLs are combined, with exact duplicate URLs
removed.

Comparison options:

| Option | Purpose |
|---|---|
| `-f, --format <format>` | `terminal`, `json`, `html`, `markdown`, or `github` |
| `-o, --output <path>` | Write the comparison to a file |
| `--fail-on <level>` | `regression` or `never` |
| `--timing-regression-ms <ms>` | Absolute median slowdown floor; default `250` |
| `--timing-regression-percent <percent>` | Relative median slowdown floor; default `25` |
| `--no-color` | Disable terminal color |

## Reports and exit codes

- `terminal`: compact sample, social-readiness, aggregate-timing, and finding
  tables for local use.
- `json`: structured machine-readable evidence, including every probe and timing
  signal plus repeated-run stability summaries.
- `sarif`: findings suitable for GitHub Code Scanning and other SARIF 2.1.0
  consumers.
- `html`: a self-contained, script-free audit report with a verdict, plain-language
  findings, framework-specific fix recipes, timing evidence, and a social preview card, suitable
  for sharing outside the terminal.
- comparison `html`: a script-free deployment summary and per-agent wire
  waterfall suitable for a CI artifact.

Exit codes are stable:

- `0`: the run completed and passed the selected policy;
- `1`: the run completed but crossed the `--fail-on` threshold;
- `2`: configuration/setup failure or incomplete probe evidence.

For `compare`, exit `1` means at least one regression was introduced under the
default policy, while invalid or unreadable reports use exit `2`. Neutral
changes and fixed findings do not fail comparison.

`check --fail-on never` suppresses policy failures, but it never converts an
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

Trusted-branch runs keep the SARIF file as a downloadable artifact and upload findings to Code
Scanning for public repositories. Pull requests get terminal output. Private/internal
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

You can also render HTML reports and look up explanations in your own code:

```ts
import {
  detectProjectFramework,
  explainFinding,
  nextSteps,
  renderAuditHtml,
} from "ssrwire";

const framework = await detectProjectFramework(process.cwd());
const context = framework === undefined ? {} : { framework };
const html = renderAuditHtml(audit, {
  ...context,
});
const steps = nextSteps(audit.results[0]?.findings ?? [], context);
const [finding] = audit.results[0]?.findings ?? [];
const explanation = finding === undefined ? undefined : explainFinding(finding, context);
```

`explainFinding()` maps a finding code onto a title, impact, fix, and optional framework snippet.
Unknown codes fall back to the recorded message, so a custom check never renders an empty
explanation. Explanations are derived at render time and are not part of the persisted audit
contract.

Comparisons use the same primitives as the CLI:

```ts
import { readFile } from "node:fs/promises";
import {
  compareAudits,
  parseAuditReportText,
  renderComparisonHtml,
} from "ssrwire";

const [baselineJson, candidateJson] = await Promise.all([
  readFile("production.json", "utf8"),
  readFile("preview.json", "utf8"),
]);
const baseline = parseAuditReportText(baselineJson, "baseline audit report");
const candidate = parseAuditReportText(candidateJson, "candidate audit report");
const comparison = compareAudits(baseline, candidate);
const html = renderComparisonHtml(comparison);
```

The JSON report's top-level `version` is the SSRWire software version.
`schemaVersion` separately identifies the persisted report contract used by
offline comparison.

## Scope

SSRWire does not execute JavaScript, inspect a hydrated DOM, render social
previews, fetch social images, measure Core Web Vitals, follow page links, validate
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
