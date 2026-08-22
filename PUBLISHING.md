# Publish SSRWire from a local machine

This repository intentionally includes no npm publishing workflow. Every npm
release is published from a local interactive terminal after GitHub CI passes.
Do not configure an `NPM_TOKEN`, trusted publisher, OIDC identity, or automated
release workflow for npm publication.

## 1. Prepare and verify

From the extracted archive:

```bash
unzip ssrwire.zip # skip when already inside a source checkout
cd ssrwire
nvm use 24
node --version
npm --version
npm ci
npm run check
npm pack --dry-run
```

Install and authenticate GitHub CLI if needed:

```bash
brew install gh
gh auth login -h github.com --web
gh auth status -h github.com
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
  --add-topic seo \
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

Verify the release from a clean checkout before starting npm's short-lived
authenticated session:

```bash
npm ci
npm run check
npm pack --dry-run
npm view ssrwire
```

For the first release, `npm view` returning a 404 means the name is not
currently published. Start authentication only after verification so the
session remains fresh for publication:

```bash
npm login --auth-type=web --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org
npm view ssrwire version dist-tags homepage keywords repository.url --json
npm logout --registry=https://registry.npmjs.org
```

Run login and publish in a foreground interactive terminal. Complete npm's
browser, passkey, or two-factor-authentication challenge when prompted. Never
put an OTP in a command argument, and do not add an `NPM_TOKEN` to this
repository.

If the package is not immediately visible after `npm publish` succeeds, wait
for npm's publish-time scanning to finish instead of publishing the same
version again.

After npm confirms `0.1.0`, create the matching source release:

```bash
node scripts/clean.mjs
rm -rf node_modules/.vite
git status --short
git tag -a v0.1.0 -m "SSRWire v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --generate-notes --title "SSRWire v0.1.0"
```

`git status --short` must print nothing before tagging the release.
