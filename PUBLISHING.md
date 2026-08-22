# Publish SSRWire from a local machine

This repository intentionally includes no npm publishing workflow. The first
publication should be made locally after the GitHub repository exists and its
CI passes. That avoids a release job failing because an npm token or trusted
publisher has not been configured yet.

## 1. Prepare and verify

From the extracted archive:

```bash
unzip ssrwire.zip # skip when already inside a source checkout
cd ssrwire
npm ci
npm run check
npm pack --dry-run
```

Install and authenticate GitHub CLI if needed:

```bash
brew install gh
gh auth login
gh auth status
```

## 2. Create the Git history

```bash
git init -b main
git add -- \
  .dockerignore .editorconfig .env.example .github .gitignore \
  CHANGELOG.md CONTRIBUTING.md Dockerfile LICENSE PUBLISHING.md README.md SECURITY.md \
  biome.json examples package.json package-lock.json scripts src test \
  tsconfig.build.json tsconfig.json vitest.config.ts
git commit -m "Initial SSRWire release"
```

## 3. Create and push the public repository

```bash
gh repo create lame13/ssrwire \
  --public \
  --source=. \
  --remote=origin \
  --push \
  --description "Inspect streamed SSR HTML, metadata timing, and crawler-specific delivery from the command line." \
  --homepage "https://nikom.work"
```

## 4. Add repository topics

```bash
gh repo edit lame13/ssrwire \
  --add-topic technical-seo \
  --add-topic ssr \
  --add-topic streaming-html \
  --add-topic nextjs \
  --add-topic nuxt \
  --add-topic astro \
  --add-topic crawler \
  --add-topic typescript \
  --add-topic cli \
  --add-topic seo-tools \
  --add-topic github-actions \
  --add-topic sarif
```

Enable the private vulnerability-reporting channel referenced by
`SECURITY.md` (this requires repository admin permission):

```bash
gh api --method PUT repos/lame13/ssrwire/private-vulnerability-reporting
```

Alternatively, enable **Private vulnerability reporting** in the repository's
Settings → Security settings before publishing the first release.

Recommended repository description:

> Inspect streamed SSR HTML, metadata timing, and crawler-specific delivery from the command line.

Wait for the repository's `CI` workflow to pass before publishing.

## 5. Publish version 0.1.0 to npm locally

Confirm that the npm account is correct and that the unscoped `ssrwire`
package name belongs to you or is available:

```bash
npm login
npm whoami
npm view ssrwire
```

`npm view` returning a 404 means the name is not currently published. Inspect
the tarball one final time, then make the first public publication without a
provenance request: local machines do not have the CI OIDC identity required
for npm provenance.

```bash
npm run check
npm pack --dry-run
NPM_CONFIG_PROVENANCE=false npm publish --access public
npm view ssrwire version dist-tags repository.url
```

Complete any interactive two-factor-authentication prompt from npm. Do not add
an `NPM_TOKEN` to this repository just to make the first release work.

After npm confirms `0.1.0`, create the matching source release:

```bash
git tag -a v0.1.0 -m "SSRWire v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --generate-notes --title "SSRWire v0.1.0"
```

## 6. Optional trusted publishing for later versions

Do this only after the package exists on npm and the manual release above is
verified. Trusted publishing uses short-lived OIDC credentials, needs no
`NPM_TOKEN`, and generates provenance automatically for public packages built
from public repositories. See npm's current
[trusted-publisher instructions](https://docs.npmjs.com/trusted-publishers/)
and [provenance requirements](https://docs.npmjs.com/generating-provenance-statements/)
before enabling it.

1. Add and review a future `.github/workflows/publish.yml` workflow. Use a
   GitHub-hosted runner, Node 24, npm 11.5.1 or newer, `id-token: write`, and
   plain `npm publish`. Do not add `--provenance`; trusted publishing does that
   automatically.
2. Commit and push that workflow without creating its release trigger yet.
3. Configure the exact repository and workflow filename in npm package
   settings, or with a current npm CLI:

```bash
npm install --global npm@latest
npm trust github ssrwire \
  --repo lame13/ssrwire \
  --file publish.yml \
  --allow-publish
```

4. Verify the trusted-publisher settings before creating the next release.

The minimum future workflow is:

```yaml
name: Publish npm package

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    if: github.repository == 'lame13/ssrwire'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          package-manager-cache: false
      - run: npm ci
      - run: npm run check
      - run: npm publish
```

Do not commit that workflow until the first local publication is complete and
you intend to configure the matching npm trusted publisher. The workflow
filename is part of npm's trust policy and must match exactly.
