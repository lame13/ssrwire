# Contributing to SSRWire

Bug reports and focused pull requests are welcome. SSRWire stays useful by
remaining small, deterministic, and honest about what an HTTP client can
observe.

## Development setup

Requirements:

- Node.js 22.12.0 or newer
- npm 10 or newer

```bash
git clone https://github.com/lame13/ssrwire.git
cd ssrwire
npm ci
npm run check
```

Use `npm run dev -- --help` while developing the CLI. Run `npm run format`
before opening a pull request, then run `npm run check` again.

## Pull requests

Keep each change narrow. Include tests for behavior changes, especially for:

- response chunk boundaries and elements split across chunks;
- redirects, timeouts, aborted bodies, and size limits;
- malformed, duplicated, late, or body-located metadata;
- user-agent differences and comparison findings;
- repeated-sample ordering, aggregation, and instability classification;
- redaction of configured header values;
- terminal, JSON, SARIF, and exit-code behavior.

Do not make timing tests depend on exact millisecond values. Shared runners and
local machines have unavoidable scheduling variance. Test ordering,
presence/absence, bounds with generous margins, and deterministic byte
positions instead.

## Scope

SSRWire is an HTTP stream observer and bounded consistency sampler, not a
browser, crawler, packet capture, load generator, performance benchmark, or
framework plugin. New features should preserve that boundary. In particular,
avoid conclusions that claim to reveal the server's original flush calls:
proxies, compression, TLS, HTTP stacks, and client buffering can coalesce data
before SSRWire sees it.

By contributing, you agree that your contribution is licensed under the MIT
License.
