# Changelog

All notable changes to SSRWire are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/lame13/ssrwire/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/lame13/ssrwire/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lame13/ssrwire/releases/tag/v0.1.0
