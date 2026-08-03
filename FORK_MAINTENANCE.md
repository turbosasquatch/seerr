# Fork Maintenance and Unraid Release Runbook

This runbook keeps `turbosasquatch/seerr` current with official Seerr releases
without accumulating merge chains or mutable container tags. `custom/main` is
the canonical fork branch. Fork `main` and `develop` are legacy references, not
sync bases.

## One-time v3.4.1 bootstrap

The local bootstrap is based on official tag `v3.4.1` (`69f73a6f`) and contains
the consolidated MDBList, TMDb-score, immutable-image, and maintenance changes.
Before publication, run every local gate in this document. Then explicitly push
`custom/main`, make it the GitHub default branch, and protect it from force
pushes and deletion. Those GitHub operations are deliberately not automated by
the repository scripts.

Create `release/v3.4.1-score-mdb.1` only from the exact validated
`custom/main` commit. Never reuse its branch, Git tag, or image tag.

## Repeatable upstream release sync

The script requires a clean tree, fetches and prunes `origin` and
`upstream/main`, verifies local `custom/main` equals `origin/custom/main`,
requires `upstream/main` to equal the named official release tag, and fails
closed if the sync branch, release branch, annotated tag, or GHCR tag is already
in use.

Public GHCR packages are checked anonymously. If the package is private, export
a read-capable `GHCR_TOKEN` for the collision check; the token is never written
to the repository.

Preview the sync first, then explicitly apply the local branch operations:

```bash
scripts/fork-release.sh start vX.Y.Z 1
scripts/fork-release.sh start vX.Y.Z 1 --apply
```

The applied command creates `sync/vX.Y.Z` from `custom/main` and merges
`upstream/main` exactly once. It never pushes. If Git stops on conflicts,
preserve both sides of the fork contract:

- Keep `mdblistApiKey` and all upstream settings, especially `versionCheck`.
- Keep the complete upstream `seerr-api.yml` plus the MDBList schemas and
  `/discover/mdblist` route.
- Keep upstream migrations, authentication, discovery, and settings behavior.
- Keep MDBList lists, filters, pagination, custom sliders, and TMDb scores.
- Keep upstream `.github/workflows/ci.yml` unchanged; update only the separate
  fork image workflow when action pins move.

Resolve, review, and commit the merge. Then run the complete gate:

```bash
scripts/fork-release.sh validate vX.Y.Z 1
```

Validation runs, in order:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

The successful commit is recorded under `.git/fork-release-validation/`.
Changing `HEAD` invalidates finalization. Preview and explicitly apply the local
fast-forward and release-branch creation:

```bash
scripts/fork-release.sh finalize vX.Y.Z 1
scripts/fork-release.sh finalize vX.Y.Z 1 --apply
```

Finalization fast-forwards `custom/main` to the validated commit and creates
`release/vX.Y.Z-score-mdb.1` at that same commit. It does not push, tag,
publish, delete the sync branch, or deploy.

## Same-version corrections

Never amend or reuse a published `.1`. Start the next correction from the
published `custom/main` and increment only the final revision:

```bash
git switch custom/main
git pull --ff-only origin custom/main
git switch --create fix/vX.Y.Z-score-mdb.2
# implement and commit the focused correction
scripts/fork-release.sh validate vX.Y.Z 2
scripts/fork-release.sh finalize vX.Y.Z 2
scripts/fork-release.sh finalize vX.Y.Z 2 --apply
```

This fast-forwards the correction back into `custom/main` before creating the
`.2` release branch. Use `.3` and later the same way. A new official Seerr
version always restarts at `.1` through the upstream sync flow.

## Publication gates

Before pushing, verify the intended release commit and upstream CI isolation:

```bash
git status --short --branch
git merge-base --is-ancestor vX.Y.Z release/vX.Y.Z-score-mdb.N
git diff --exit-code vX.Y.Z -- .github/workflows/ci.yml
git log --oneline --decorate vX.Y.Z..release/vX.Y.Z-score-mdb.N
```

Push `custom/main` and the release branch only after review. The release workflow
publishes both immutable tags:

```text
ghcr.io/turbosasquatch/seerr:vX.Y.Z-score-mdb.N
ghcr.io/turbosasquatch/seerr:vX.Y.Z-score-mdb.N-<full-commit-sha>
```

Monitor the workflow and verify both image tags resolve to the release commit.
Only after successful publication create and push the annotated tag
`fork-vX.Y.Z-score-mdb.N`. Never overwrite a branch, Git tag, or image tag; fix
a published defect with the next `.N`.

## Unraid rollout

Confirm the new immutable image and the previous rollback image exist. The
deployment helper accepts all environment-specific values and stores no host,
address, or credential in the repository. It defaults to a dry run and does not
open SSH:

```bash
scripts/unraid-deploy.sh \
  --host root@unraid-host \
  --container seerr-container \
  --template /boot/config/plugins/dockerMan/templates-user/my-seerr-container.xml \
  --image ghcr.io/turbosasquatch/seerr:vX.Y.Z-score-mdb.N \
  --expected-commit "$(git rev-parse release/vX.Y.Z-score-mdb.N)"
```

After checking the printed target, add `--execute`. The remote phase:

1. Requires the existing container, Unraid template, bridge network,
   `/app/config` bind, and `always` restart policy.
2. Records ports, mounts, environment, labels, network, and restart policy.
3. Pulls the immutable image and copies the XML template to a timestamped backup.
4. Replaces only the XML `Repository` value and invokes Unraid Docker Manager's
   `update_container` command with the existing container name.
5. Confirms the container is running, runtime configuration is unchanged, port
   `5055` responds, and `/api/v1/status` reports the expected version, commit,
   and `restartRequired=false`.
6. Prints recent logs and fails on fatal, unhandled, or migration errors.

If verification fails, the script stops without automatic rollback and leaves
the container, timestamped XML backup, and `/tmp/<container>-fork-release-*.log`
for inspection. Complete authenticated UI checks for MDBList discovery,
filtering, pagination, custom sliders, and TMDb scores before cleanup.

No appdata/database backup is taken. Upstream migrations may make database
rollback unsafe. Restoring the previous immutable image and template therefore
requires explicit approval and an informed rollback decision.

## Cleanup and retention

Run the read-only retention inventory after the new deployment passes all API
and UI checks:

```bash
scripts/fork-release.sh inventory
```

Review candidates before any deletion. Keep:

- `custom/main`.
- The current release branch and immutable image.
- The immediately previous release branch and rollback image.
- An annotated `fork-vX.Y.Z-score-mdb.N` tag for every removed release branch.

After confirming feature parity, the first cleanup may remove obsolete
`codex/mdblist-discover-sliders` and `custom/v3.3.0-score-mdb` branches. Each
later release may remove its merged `sync/*` branch and release branches older
than the retained pair, but only after their annotated tags and images are
verified. Also prune stale remote-tracking refs, failed or untagged GHCR
manifests, and disposable build caches. Repository scripts intentionally print
inventory rather than pushing or deleting anything.
