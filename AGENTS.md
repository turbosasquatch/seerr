# Fork Release Instructions

This file is authoritative for maintenance of `turbosasquatch/seerr`.

## Branch topology

- `custom/main` is the only maintained fork branch. It contains official upstream
  `main` plus the MDBList, TMDb-score, immutable-image, and maintenance changes.
- Integrate a new official version on `sync/vX.Y.Z`, created from
  `custom/main`. Merge `upstream/main` exactly once; never merge a prior
  `release/*` branch or either fork `develop` branch.
- After all release gates pass, fast-forward `custom/main` to the validated sync
  commit and create `release/vX.Y.Z-score-mdb.1` at that exact commit.
- Create same-version corrections on `fix/vX.Y.Z-score-mdb.N` from
  `custom/main`. Validate the fix, fast-forward it back into `custom/main`, and
  create `.N` at the same commit. Never amend, rebase, reuse, or force-push a
  published release branch.
- Use `scripts/fork-release.sh` for start, validation, finalization, and retention
  inventory. Its validation marker is required before local release creation.

## Coupled conflict invariants

- Preserve both `main.mdblistApiKey` and every upstream main setting, including
  `main.versionCheck`, in the settings model, API, and UI.
- Preserve the complete upstream OpenAPI document and the MDBList discovery
  schema and route.
- Preserve upstream migrations and discovery behavior while retaining MDBList
  lists, filters, pagination, custom sliders, and TMDb poster scores.
- Keep `.github/workflows/ci.yml` identical to the official upstream tag. Fork
  images publish only through the separate immutable release workflow.

## Required gates

Before any push or publication, run the frozen install, typechecks, lint,
formatting check, unit tests, and production build. Also review the API contract,
settings coexistence, MDBList pagination/filtering, missing-score behavior,
release history, and rollback inputs.

Publishing and deployment are separate, explicit operations. Do not let a local
maintenance command push, tag, delete branches, publish, change GitHub settings,
or deploy implicitly. Deploy only immutable GHCR tags with
`scripts/unraid-deploy.sh`; its default is a no-SSH dry run.

## Retention

After the new container is verified, retain `custom/main`, the current release
branch, and the immediately previous rollback release branch. Preserve older
release provenance with annotated Git tags before deleting their branches.
Review merged sync branches, obsolete feature branches, stale remote-tracking
refs, and failed or untagged GHCR manifests during every release. Cleanup is
review-first and must never remove the active or rollback release.
