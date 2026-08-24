# Publish SSRWire 0.2.0 from a local machine

This repository intentionally includes no npm publishing workflow. Publish from
a foreground local terminal only after the GitHub `CI` workflow passes. Do not
configure an `NPM_TOKEN`, trusted publisher, OIDC identity, or automated npm
release job.

The `main` branch is protected. Land every release change through a pull
request, and do not use an administrator bypass or a direct push to `main`.

## 1. Update the existing repository

Work from a clean clone of the existing public repository. Copy the 0.2.0
source files into that clone while preserving its `.git` directory.

```bash
cd ssrwire
git switch main
git pull --ff-only origin main
git status --short
git switch -c release/0.2.0
```

`git status --short` must be empty before creating the release branch and
applying the release files.

## 2. Verify the release locally

```bash
nvm use 24
node --version
npm --version
npm ci
npm run check
npm pack --dry-run
node dist/bin.js --version
```

The final command must print `0.2.0`. Inspect the dry-run file list. It must not
contain `.env`, `.github`, `node_modules`, `test`, ZIP files, or tarballs.

Review the release diff and version references:

```bash
git diff --check
git diff --stat
git diff -- package.json package-lock.json CHANGELOG.md README.md PUBLISHING.md
rg '0\.1\.0' README.md examples package.json package-lock.json src test
```

The final search should return nothing. Historical entries in `CHANGELOG.md`
are excluded intentionally.

## 3. Commit, push the release branch, and open a pull request

```bash
gh auth status -h github.com || gh auth login -h github.com --web
git add --all
git diff --cached --check
git diff --cached --stat
git commit -m "feat: release SSRWire 0.2.0"
git push --set-upstream origin release/0.2.0
gh pr create --base main --head release/0.2.0 --fill
PR_NUMBER="$(gh pr view release/0.2.0 --json number --jq .number)"
test -n "$PR_NUMBER"
gh pr checks "$PR_NUMBER" --watch --fail-fast
```

Do not merge while any Node, package-smoke, or Docker job is failing. Satisfy
all review and branch-protection requirements, then merge with GitHub's allowed
strategy. Running `gh pr merge "$PR_NUMBER"` without a strategy flag lets the
CLI prompt for one of the repository's permitted methods. Do not select an
administrator bypass.

```bash
gh pr merge "$PR_NUMBER"
```

After GitHub reports the pull request as merged, update local `main` and wait
for the CI run on the exact merged commit:

```bash
git switch main
git pull --ff-only origin main
git status --short
gh pr view "$PR_NUMBER" --json state,mergedAt,mergeCommit
COMMIT_SHA="$(git rev-parse HEAD)"
RUN_ID="$(gh run list --workflow CI --branch main --commit "$COMMIT_SHA" \
  --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
```

`git status --short` must be empty. Do not publish until the merged-commit CI
run succeeds.

## 4. Verify npm state

```bash
npm view ssrwire version dist-tags homepage keywords repository.url --json
npm config get registry
npm config get provenance
```

The published version and `latest` tag must still be `0.1.0`. If npm already
reports `0.2.0`, stop: never reuse a version that npm accepted.

In the npm package settings, select **Require two-factor authentication and
disallow tokens**. npm documents this as the strongest package publishing
setting:

- <https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/>
- <https://docs.npmjs.com/about-two-factor-authentication/>

## 5. Publish interactively

Remove inherited automation credentials before starting the interactive
session:

```bash
unset NODE_AUTH_TOKEN NPM_TOKEN NPM_CONFIG_OTP npm_config_otp
npm login --auth-type=web --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org
npm view ssrwire version dist-tags homepage keywords repository.url --json
npm logout --registry=https://registry.npmjs.org
```

Complete npm's browser, passkey, or two-factor-authentication challenge when
prompted. Do not use a token with bypass 2FA, put an OTP in a command argument,
or add an npm credential to the repository or GitHub Actions. The package-level
"disallow tokens" setting ensures that publication remains interactive.

If npm's publish-time scanning delays package visibility, wait. Do not publish
`0.2.0` again or change the tag to work around propagation.

## 6. Tag the exact published commit

```bash
node scripts/clean.mjs
rm -rf node_modules/.vite
git status --short
git tag -a v0.2.0 -m "SSRWire v0.2.0"
git push origin v0.2.0
gh release create v0.2.0 --generate-notes --title "SSRWire v0.2.0"
```

`git status --short` must print nothing before tagging.
