# Security policy

## Supported versions

Security fixes are applied to the latest released version.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose
credentials, bypass SSRWire's header protections, or cause unsafe file or
network behavior. Use GitHub's private vulnerability reporting for
`lame13/ssrwire` instead:

<https://github.com/lame13/ssrwire/security/advisories/new>

Include the affected version, reproduction steps, expected impact, and any
suggested mitigation. Remove real tokens, cookies, and private URLs from the
report. You should receive an initial response within seven days.

## Operational safety

SSRWire sends real HTTP requests to every configured target for every selected
agent profile. Run it only against systems you are authorized to test. Treat
custom headers as secrets, prefer environment-variable interpolation, and do
not commit populated `.env` files or generated reports containing private
URLs.
