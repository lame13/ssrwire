# Changelog

All notable changes to SSRWire are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-09-01

### Added

- Offline `ssrwire compare` for two redacted JSON audits, with stable target IDs
  for matching the same route across production and preview origins.
- Regression, fixed, and neutral-change classification for policy findings,
  completion, HTTP delivery, metadata values and locations, agent coverage, and
  redirect evidence.
- Dual-floor median timing comparisons with configurable absolute and relative
  thresholds.
- Terminal and deterministic JSON comparison reports plus a self-contained,
  script-free HTML wire waterfall.
- Public comparison, report-validation, and comparison-reporter APIs.

### Changed

- JSON audits now include an explicit `schemaVersion: 1` persisted-report
  contract independent of the SSRWire package version.
- Target objects accept an optional unique `id`; exact URL matching remains the
  fallback when an ID is absent.

## [0.3.0] - 2026-08-28

### Added

- Streamed capture for core Open Graph and Twitter Card metadata with arrival
  time, observed byte position, document location, bounded repeated values, and
  report redaction.
- Opt-in `require.openGraph` and `require.twitterCard` target contracts with
  missing-field, invalid-URL, duplicate/conflict, and head/body delivery
  findings.
- A terminal social-preview readiness table and public social metadata signal
  types in JSON and the programmatic API.

### Changed

- Enabled social contracts now participate in required-signal timing,
  cross-agent comparison, and repeated-sample stability analysis.
- Twitter Card readiness prefers native Twitter metadata and falls back to the
  corresponding Open Graph title, description, and image.
- Multiple `og:image` values are retained in document order without being
  treated as conflicting scalar metadata.

## [0.2.0] - 2026-08-24

### Added

- Bounded `repeat` configuration and `--repeat` CLI sampling for 1–10 requests
  per target-agent pair.
- Per-agent minimum, median, nearest-rank p95, maximum, and spread summaries for
  response-header, first-byte, required-signal, and completion timings.
- Response and streamed-HTML stability findings across repeated samples.
- Sample attribution in terminal and JSON reports.

### Changed

- Added an npm package badge to the README.
- Samples for one target-agent pair run sequentially while independent pairs
  retain bounded concurrency.
- Repeated policy findings are coalesced with occurrence and sample evidence.
- Exact body-fingerprint variation alone is informational; timing variation
  alone remains evidence rather than a policy failure.

## [0.1.0] - 2026-08-22

### Added

- Stream-observation probes for browser and crawler user-agent profiles.
- Timing and byte-position evidence for SEO metadata, H1, main text, and JSON-LD.
- Redirect, status, response-header, truncation, timeout, and network-failure evidence.
- Cross-agent delivery comparisons with configurable expectations.
- Terminal, JSON, and SARIF reports with CI-safe exit codes.
- YAML configuration, one-off URL checks, Docker support, and GitHub Actions examples.

[Unreleased]: https://github.com/lame13/ssrwire/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/lame13/ssrwire/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lame13/ssrwire/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lame13/ssrwire/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lame13/ssrwire/releases/tag/v0.1.0
