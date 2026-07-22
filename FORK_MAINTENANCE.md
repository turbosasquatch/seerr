# Fork Maintenance Checklist

Follow [AGENTS.md](AGENTS.md) as the authoritative policy.

1. Start `release/vX.Y.Z-score-mdb.1` directly from `upstream/vX.Y.Z`, never from `develop`.
2. Replay the three required commits in the documented order, identified by their exact subjects.
3. Confirm there are exactly three commits above the upstream tag and that `.github/workflows/ci.yml` is unchanged.
4. Pass the API specification regression test, relevant unit tests, lint, client and server typechecks, and the production build.
5. Obtain the independent read-only Sol High review before Sol High publishes the release branch.
6. Confirm the immutable image workflow succeeds before deploying its exact `vX.Y.Z-score-mdb.N` tag. Do not publish or deploy mutable aliases.
7. Keep each published `release/*` branch immutable. Fix a release with the next `.N` branch from the same upstream tag; begin new upstream versions at `.1`.
8. Back up configuration and retain the previous immutable image before authorized deployment.
9. Complete live post-deployment API and UI verification. On deployment or verification failure, roll back to the retained previous immutable image using the configuration backup.
