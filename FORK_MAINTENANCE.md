# Fork Maintenance

Use this when syncing `turbosasquatch/seerr` with `seerr-team/seerr` and rebuilding the Docker image for Unraid.

## Sync the Fork

```bash
git fetch origin
git fetch upstream
git checkout develop
git merge --ff-only upstream/develop
git push origin develop
```

If you have a feature branch with local changes, rebase it after `develop` is updated:

```bash
git checkout <branch-name>
git rebase develop
git push --force-with-lease origin <branch-name>
```

## Rebuild the Image

The `Seerr CI` workflow publishes the `develop` image to GitHub Container Registry:

```bash
gh workflow run ci.yml --ref develop -R turbosasquatch/seerr
gh run list --workflow ci.yml --branch develop -R turbosasquatch/seerr --limit 1
gh run watch <run-id> -R turbosasquatch/seerr --exit-status
```

Use this image in Unraid:

```text
ghcr.io/turbosasquatch/seerr:develop
```

The workflow also publishes Docker Hub tags when `DOCKER_USERNAME` and `DOCKER_TOKEN` repository secrets are configured. Without those secrets, Docker Hub is skipped and GHCR still publishes.

## Quick Checks

Before updating Unraid, confirm:

```bash
git status --short --branch
git rev-list --left-right --count upstream/develop...origin/develop
```

The rev-list command should print `0	0` after the fork and source are aligned.
