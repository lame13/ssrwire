# Publish SSRWire from a local machine

This repository intentionally includes no npm publishing workflow. Publish from
a foreground local terminal only after the GitHub `CI` workflow passes. Do not
configure an `NPM_TOKEN`, trusted publisher, OIDC identity, or automated npm
release job.

The `main` branch is protected. Land every release change through a pull
request, and do not use an administrator bypass or a direct push to `main`.

Replace `<VERSION>` with the version being released (for example `0.4.2`) and
`<PREVIOUS_VERSION>` with the version npm currently reports as `latest` before
running any command in this document. `CHANGELOG.md` is updated as part of the
release commit.

## 1. Bump every version reference

The package version lives in more than one place. Update all of them:

| File | What to change |
|---|---|
| `package.json` | the top-level `version` |
| `package-lock.json` | the top-level `version` and `packages[""].version` |
| `scripts/package-check.mjs` | the `expectedVersion` constant |
| `examples/github-actions.yml` | both `npx --yes ssrwire@<VERSION>` pins |
| `README.md` | release-pinned examples; preserve historical compatibility versions |
| `test/` | fixture versions and reporter assertions that embed the version |
| `CHANGELOG.md` | the new `## [<VERSION>]` entry and the compare links |

Then confirm no reference to the previous release is left behind. Historical
`CHANGELOG.md` entries are excluded intentionally:

```bash
rg "SSRWire <PREVIOUS_VERSION>|ssrwire@<PREVIOUS_VERSION>|expectedVersion = \"<PREVIOUS_VERSION>\"" \
  README.md examples scripts src test
```

## 2. Update the existing repository

Work from a clean clone of the existing public repository. Copy the release
source files into that clone while preserving its `.git` directory.

```bash
cd ssrwire
git switch main
git pull --ff-only origin main
git status --short
git switch -c release/<VERSION>
```

`git status --short` must be empty before creating the release branch and
applying the release files.

## 3. Verify the release locally

```bash
nvm use 24
node --version
npm --version
npm ci
npm run check
npm pack --dry-run
node dist/bin.js --version
```

The final command must print `<VERSION>`. Inspect the dry-run file list. It must
not contain `.env`, `.github`, `node_modules`, `test`, ZIP files, or tarballs.

Review the release diff and version references:

```bash
git diff --check
git diff --stat
git diff -- package.json package-lock.json CHANGELOG.md README.md PUBLISHING.md
```

## 4. Commit, push the release branch, and open a pull request

```bash
gh auth status -h github.com || gh auth login -h github.com --web
git add --all
git diff --cached --check
git diff --cached --stat
git commit -m "chore: release SSRWire <VERSION>"
git push --set-upstream origin release/<VERSION>
gh pr create --base main --head release/<VERSION> --fill
PR_NUMBER="$(gh pr view release/<VERSION> --json number --jq .number)"
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

## 5. Verify npm state

```bash
npm view ssrwire version dist-tags homepage keywords repository.url --json
npm config get registry
npm config get provenance
```

The published version and `latest` tag must still be `<PREVIOUS_VERSION>`. If
npm already reports `<VERSION>`, stop: never reuse a version that npm accepted.

In the npm package settings, select **Require two-factor authentication and
disallow tokens**. npm documents this as the strongest package publishing
setting:

- <https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/>
- <https://docs.npmjs.com/about-two-factor-authentication/>

## 6. Publish interactively

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
`<VERSION>` again or change the tag to work around propagation.

## 7. Tag the exact published commit

```bash
node scripts/clean.mjs
rm -rf node_modules/.vite
git status --short
git tag -a v<VERSION> -m "SSRWire v<VERSION>"
git push origin v<VERSION>
gh release create v<VERSION> --generate-notes --title "SSRWire v<VERSION>"
```

`git status --short` must print nothing before tagging.
