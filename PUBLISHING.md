# Publish SSRWire

Releases go through a pull request to protected `main`. npm publication is manual, from a local
terminal after GitHub CI passes. Keep publishing credentials out of GitHub Actions.

Replace `<VERSION>` below with the release version, such as `0.6.0`.

## Prepare the release

Start a release branch from current `main`, then make the release changes:

```bash
git switch main
git pull --ff-only origin main
git switch -c release/<VERSION>
```

Update the version in `package.json`, both root entries in `package-lock.json`,
`scripts/package-check.mjs`, and the pins in `examples/github-actions.yml`. Add a dated entry and
compare link to `CHANGELOG.md`. Keep historical versions in compatibility examples and old report
fixtures.

Use Node.js 22.12.0 or newer (CI also tests Node 24):

```bash
npm ci
npm run check
npm pack --dry-run
node dist/bin.js --version
git diff --check
git diff --stat
```

Inspect the tarball file list and confirm the CLI prints the release version. Stage only the
release files, review the staged diff, and commit:

```bash
git diff --cached --check
git diff --cached --stat
git commit -m "chore: release SSRWire <VERSION>"
```

Create an annotated tag on that commit. Put the release's changelog entry in the annotation so
GitHub can use it as the release notes:

```bash
git tag -a v<VERSION> --cleanup=verbatim
```

If the release commit and tag have already been prepared, continue below without recreating them.

## Publish the branch and merge the pull request

Check that the release branch still contains the latest `main` before pushing:

```bash
git fetch origin
git merge-base --is-ancestor origin/main HEAD
```

If the second command fails, merge `origin/main` into the release branch, run `npm ci` and
`npm run check` again, and move the unpublished local tag to the verified commit. Preserve its
release notes. Do not move a tag that has already been pushed.

```bash
git push --set-upstream origin release/<VERSION>
gh pr create --base main --head release/<VERSION> --fill
```

GitHub may take a moment to register the checks. "No checks reported" is not a pass; wait and
retry. Require both Node jobs, both package-smoke jobs, and Docker to pass. The `&&` below prevents
the merge command from running when the check command fails:

```bash
gh pr checks release/<VERSION> --watch --fail-fast &&
  gh pr merge release/<VERSION> --merge
```

After the merge succeeds, update local `main` and confirm it contains the tagged release:

```bash
git switch main
git pull --ff-only origin main
git merge-base --is-ancestor v<VERSION> HEAD
git diff --exit-code v<VERSION> HEAD
```

The last two commands confirm that `main` contains the tagged commit and has the same files. If
review changed the release files, verify the new files and update the unpublished local tag before
continuing. Never move a published tag.

Wait for CI on the merged commit:

```bash
RELEASE_COMMIT="$(git rev-parse HEAD)"
gh run list --workflow CI --branch main --commit "$RELEASE_COMMIT"
gh run watch <RUN_ID> --exit-status
```

Use the run ID from the listing. If it has not appeared yet, wait for GitHub to start it.

## Publish to npm

Publish the exact tagged source from a clean working tree:

```bash
git status --short
git switch --detach v<VERSION>
npm ci
npm run check
npm pack --dry-run
npm view ssrwire version dist-tags --json
npm view ssrwire@<VERSION> version
```

The working tree must be clean. The final lookup should report that the version is not published;
if it exists, do not publish it again. A network error does not establish that a version is free.

In npm package settings, use **Require two-factor authentication and disallow tokens**. Start an
interactive session:

```bash
unset NODE_AUTH_TOKEN NPM_TOKEN NPM_CONFIG_OTP npm_config_otp
npm login --auth-type=web --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org
npm view ssrwire@<VERSION> version dist.integrity --json
npm logout --registry=https://registry.npmjs.org
```

Complete npm's browser or two-factor authentication prompt. Do not put an OTP in a command or add
an npm token to the repository. If visibility is delayed after a successful publish, wait rather
than publishing again.

See [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/) and
[npm's package 2FA settings](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/).

## Publish the GitHub tag and release

```bash
git push origin v<VERSION>
gh release create v<VERSION> --verify-tag --notes-from-tag --title "SSRWire v<VERSION>"
git switch main
```

`--notes-from-tag` uses the reviewed annotation. See the
[GitHub CLI release reference](https://cli.github.com/manual/gh_release_create).
