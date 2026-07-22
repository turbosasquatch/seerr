# Fork Release Instructions

This file is authoritative for this fork's release process and agent routing.

## Agent routing

- The Sol Medium root chat orchestrates only: it assigns work, enforces gates, and reports evidence. It does not edit, test, commit, push, or deploy.
- Wave 1 uses three Terra lanes in isolated clones: MDBList discovery/filter/API-contract work, score-card work, and workflow/documentation work.
- Sol High owns integration and release publication after every pre-publication gate passes.
- Luna runner owns deterministic local tests and CI monitoring only; it does not edit, commit, push, or deploy.
- An independent Sol High agent performs the read-only release review.
- A separate Sol Medium agent owns authorized SSH deployment.
- Terra performs read-only post-deployment API and UI verification.
- Route a failure first to the owning Wave 1 lane, then to Sol High for integration or compatibility work. Escalate to Sol Extra High after repeated structural failure; do not add lower-model agents to compensate.

## Fork maintenance

- Base every deployed release on the official upstream release tag, never `develop`.
- Each release branch contains exactly these three custom commits, in this order:
  1. `feat: add MDBList discovery, filtering, and API contract`
  2. `feat: show TMDb score on poster cards`
  3. `ci: add immutable custom-image release workflow`
- Create `release/vX.Y.Z-score-mdb.1` directly from `upstream/vX.Y.Z` and identify patches by their exact subjects, not permanent SHAs.
- Never merge `develop` into a deployed release branch. Never amend, rebase, delete, alter, or force-push a published `release/*` branch.
- Correct a published release with `.2`, `.3`, and later revisions from the same official tag. Start a new upstream version at `.1`.
- Before publishing, verify the branch is exactly three commits ahead of its upstream tag and `.github/workflows/ci.yml` has no diff from that tag.
- Deploy only immutable GHCR tags. Retain the previous image and a configuration backup for rollback.

## Required release gates

Sol High may publish only after all of these local gates pass:

1. The API specification regression test.
2. Relevant unit tests.
3. Lint.
4. Client and server typechecks.
5. The production build.
6. Independent read-only Sol High review of history, patch boundaries, upstream CI cleanliness, API coverage, and rollback safety.

After publication, Luna must confirm the immutable image workflow succeeds before deployment. After authorized deployment, Terra must complete live API and UI verification. If deployment or live verification fails, the Sol Medium deployment agent must restore the retained previous immutable image using the configuration backup.
