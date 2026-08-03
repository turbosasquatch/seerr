#!/usr/bin/env bash

set -Eeuo pipefail

readonly CANONICAL_BRANCH='custom/main'
readonly DEFAULT_IMAGE_REPOSITORY='ghcr.io/turbosasquatch/seerr'

usage() {
  cat <<'EOF'
Usage:
  scripts/fork-release.sh start vX.Y.Z N [--apply] [--image-repository IMAGE]
  scripts/fork-release.sh validate vX.Y.Z N
  scripts/fork-release.sh finalize vX.Y.Z N [--apply] [--image-repository IMAGE]
  scripts/fork-release.sh inventory

Commands:
  start       Fetch and verify both remotes, then preview creation of sync/vX.Y.Z.
              With --apply, create the sync branch and merge upstream/main once.
  validate    Run the complete local release gate on the expected sync or fix
              branch and record the validated commit under .git/.
  finalize    Re-check every guard and preview a fast-forward of custom/main plus
              local creation of release/vX.Y.Z-score-mdb.N. With --apply, perform
              only those local branch operations.
  inventory   Fetch/prune remote-tracking refs and report retention candidates.

This script never pushes, creates Git tags, deletes branches, publishes images,
changes repository settings, or deploys a container.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_clean_worktree() {
  git diff --quiet || die 'Tracked working-tree changes must be committed or stashed.'
  git diff --cached --quiet || die 'Staged changes must be committed or stashed.'
  [[ -z $(git ls-files --others --exclude-standard) ]] ||
    die 'Untracked files must be committed, ignored, or removed.'
}

current_branch() {
  git symbolic-ref --quiet --short HEAD || die 'Detached HEAD is not supported.'
}

fetch_remotes() {
  note 'Fetching and pruning origin (without importing tags)...'
  git fetch origin --prune --no-tags
  note 'Fetching upstream/main (without importing tags)...'
  git fetch upstream main --prune --no-tags
}

remote_ref_sha() {
  local remote=$1
  local ref=$2
  local output
  local status

  if output=$(git ls-remote --exit-code "$remote" "$ref" 2>&1); then
    printf '%s\n' "$output" | awk 'NR == 1 { print $1 }'
    return 0
  else
    status=$?
  fi

  [[ $status -eq 2 ]] && return 2
  die "Unable to query $remote $ref: $output"
}

remote_tag_commit() {
  local tag=$1
  local sha

  if sha=$(remote_ref_sha upstream "refs/tags/${tag}^{}"); then
    printf '%s\n' "$sha"
    return 0
  fi

  remote_ref_sha upstream "refs/tags/$tag" ||
    die "Official upstream tag does not exist: $tag"
}

verify_official_release() {
  local version=$1
  local upstream_sha
  local tag_sha

  upstream_sha=$(git rev-parse refs/remotes/upstream/main)
  tag_sha=$(remote_tag_commit "$version")
  [[ $upstream_sha == "$tag_sha" ]] ||
    die "upstream/main ($upstream_sha) is not exactly official tag $version ($tag_sha)."
}

verify_canonical_alignment() {
  local local_sha
  local remote_sha

  git show-ref --verify --quiet "refs/heads/$CANONICAL_BRANCH" ||
    die "Missing local $CANONICAL_BRANCH. Bootstrap and publish it before using this workflow."
  git show-ref --verify --quiet "refs/remotes/origin/$CANONICAL_BRANCH" ||
    die "Missing origin/$CANONICAL_BRANCH. Bootstrap and publish it before using this workflow."

  local_sha=$(git rev-parse "refs/heads/$CANONICAL_BRANCH")
  remote_sha=$(git rev-parse "refs/remotes/origin/$CANONICAL_BRANCH")
  [[ $local_sha == "$remote_sha" ]] ||
    die "$CANONICAL_BRANCH ($local_sha) does not match origin/$CANONICAL_BRANCH ($remote_sha)."
}

refuse_remote_ref() {
  local remote=$1
  local ref=$2
  local label=$3
  local sha

  if sha=$(remote_ref_sha "$remote" "$ref"); then
    die "$label already exists at $sha. Published names are immutable."
  fi
}

refuse_release_collisions() {
  local release_branch=$1
  local release_tag=$2

  git show-ref --verify --quiet "refs/heads/$release_branch" &&
    die "Local release branch already exists: $release_branch"
  git show-ref --verify --quiet "refs/tags/$release_tag" &&
    die "Local release tag already exists: $release_tag"
  refuse_remote_ref origin "refs/heads/$release_branch" "Remote release branch $release_branch"
  refuse_remote_ref origin "refs/tags/$release_tag" "Remote release tag $release_tag"
}

refuse_existing_image() {
  local image=$1
  local image_path=${image#ghcr.io/}
  local repository=${image_path%:*}
  local image_tag=${image_path##*:}
  local registry_token=${GHCR_TOKEN:-}
  local http_status

  require_command curl
  if [[ -z $registry_token ]]; then
    require_command node
    registry_token=$(
      curl -fsSL --get --data-urlencode "scope=repository:${repository}:pull" \
        'https://ghcr.io/token' |
        node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).token"
    ) || die "Could not obtain an anonymous GHCR token for $repository."
  fi
  [[ -n $registry_token ]] || die "GHCR returned an empty token for $repository."

  http_status=$(
    curl -sS -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer $registry_token" \
      -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
      "https://ghcr.io/v2/${repository}/manifests/${image_tag}"
  ) || die "Could not query GHCR for $image."

  case "$http_status" in
    200) die "Container tag already exists and is immutable: $image" ;;
    404) return 0 ;;
    401 | 403)
      die "GHCR denied the image collision check for $image. Export a read-capable GHCR_TOKEN and retry."
      ;;
    *) die "Could not prove that $image is unused; GHCR returned HTTP $http_status." ;;
  esac
}

validation_marker() {
  local release_id=$1
  local marker_dir
  marker_dir=$(git rev-parse --git-path fork-release-validation)
  printf '%s/%s\n' "$marker_dir" "$release_id"
}

validate_release_arguments() {
  [[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    die "Version must match vX.Y.Z; got: $version"
  [[ $revision =~ ^[1-9][0-9]*$ ]] ||
    die "Revision must be an integer >= 1 with no leading zero; got: $revision"

  sync_branch="sync/$version"
  release_id="${version}-score-mdb.${revision}"
  if [[ $revision == '1' ]]; then
    source_branch=$sync_branch
  else
    source_branch="fix/$release_id"
  fi
  release_branch="release/$release_id"
  release_tag="fork-$release_id"
  image="${image_repository}:$release_id"
}

inventory() {
  require_clean_worktree
  fetch_remotes

  note 'Protected branches (never delete):'
  note "  $CANONICAL_BRANCH"
  note '  the current release branch'
  note '  the immediately previous rollback release branch'
  note ''
  note 'Local release branches:'
  git for-each-ref --sort=-refname --format='  %(refname:short)' refs/heads/release/ || true
  note 'Remote release branches:'
  git for-each-ref --sort=-refname --format='  %(refname:short)' refs/remotes/origin/release/ || true
  note 'Merged local sync branches eligible for review and deletion:'
  git branch --merged "$CANONICAL_BRANCH" --list 'sync/*' --format='  %(refname:short)' || true
  note 'Merged origin sync branches eligible for review and deletion:'
  git branch --remotes --merged "$CANONICAL_BRANCH" --list 'origin/sync/*' --format='  %(refname:short)' || true
  note 'Legacy fork branches to review after feature-parity confirmation:'
  git for-each-ref --sort=refname --format='  %(refname:short)' \
    refs/heads/codex/ refs/heads/custom/ refs/remotes/origin/codex/ refs/remotes/origin/custom/ |
    awk '$1 != "custom/main" && $1 != "origin/custom/main"' || true
  note ''
  note 'Inventory only: this command intentionally deleted nothing.'
}

require_command git
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die 'Run this inside the Seerr repository.'
cd "$repo_root"

command_name=${1:-}
[[ -n $command_name ]] || {
  usage
  exit 1
}
shift

if [[ $command_name == '-h' || $command_name == '--help' ]]; then
  usage
  exit 0
fi

if [[ $command_name == 'inventory' ]]; then
  [[ $# -eq 0 ]] || die 'inventory takes no arguments.'
  inventory
  exit 0
fi

case "$command_name" in
  start | validate | finalize) ;;
  *)
    usage
    die "Unknown command: $command_name"
    ;;
esac

[[ $# -ge 2 ]] || {
  usage
  die "$command_name requires a version and revision."
}

version=$1
revision=$2
shift 2
apply=false
image_repository=$DEFAULT_IMAGE_REPOSITORY

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      apply=true
      shift
      ;;
    --image-repository)
      [[ $# -ge 2 ]] || die '--image-repository requires a value.'
      image_repository=$2
      shift 2
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ $image_repository =~ ^ghcr\.io/[a-z0-9._-]+/[a-z0-9._-]+$ ]] ||
  die "Image repository must be a lowercase ghcr.io owner/package path; got: $image_repository"
validate_release_arguments

require_clean_worktree

case "$command_name" in
  start)
    [[ $(current_branch) == "$CANONICAL_BRANCH" ]] ||
      die "start must run from $CANONICAL_BRANCH."
    [[ $revision == '1' ]] ||
      die 'Upstream-version syncs start at revision 1. Merge same-version corrections into custom/main and use finalize from a validated correction branch.'
    fetch_remotes
    verify_canonical_alignment
    verify_official_release "$version"
    git show-ref --verify --quiet "refs/heads/$sync_branch" &&
      die "Local sync branch already exists: $sync_branch"
    refuse_remote_ref origin "refs/heads/$sync_branch" "Remote sync branch $sync_branch"
    refuse_release_collisions "$release_branch" "$release_tag"
    refuse_existing_image "$image"

    if [[ $apply == false ]]; then
      note "DRY RUN: would create $sync_branch from $CANONICAL_BRANCH and merge upstream/main once."
      note "Re-run with --apply to perform those local operations. Nothing was pushed."
      exit 0
    fi

    git switch --create "$sync_branch" "$CANONICAL_BRANCH"
    if ! git merge --no-ff --no-edit refs/remotes/upstream/main; then
      note 'The upstream merge stopped for manual conflict resolution.'
      note 'Resolve every conflict by retaining upstream behavior plus fork behavior, commit the merge, then run validate.'
      exit 1
    fi
    note "Created $sync_branch. Run validate after reviewing the merge."
    ;;

  validate)
    [[ $(current_branch) == "$source_branch" ]] ||
      die "validate must run from $source_branch."
    fetch_remotes
    if [[ $revision == '1' ]]; then
      verify_official_release "$version"
    fi
    tag_sha=$(remote_tag_commit "$version")
    git merge-base --is-ancestor "$tag_sha" HEAD ||
      die "$source_branch does not contain official upstream tag $version."

    require_command node
    package_version=$(node -p "require('./package.json').version")
    [[ $package_version == "${version#v}" ]] ||
      die "package.json version is $package_version; expected ${version#v}."

    require_command pnpm
    CI=true pnpm install --frozen-lockfile
    pnpm typecheck
    pnpm lint
    pnpm format:check
    CI=true pnpm test
    pnpm build

    validated_sha=$(git rev-parse HEAD)
    marker=$(validation_marker "$release_id")
    mkdir -p "$(dirname "$marker")"
    printf '%s\n' "$validated_sha" >"$marker"
    note "Validated $validated_sha for $release_id."
    ;;

  finalize)
    active_branch=$(current_branch)
    [[ $active_branch == "$source_branch" ]] ||
      die "finalize must run from validated branch $source_branch."

    marker=$(validation_marker "$release_id")
    [[ -f $marker ]] || die "No successful validation marker found for $release_id."
    validated_sha=$(<"$marker")
    [[ $(git rev-parse HEAD) == "$validated_sha" ]] ||
      die 'HEAD changed after validation; run validate again.'

    fetch_remotes
    verify_canonical_alignment
    if [[ $revision == '1' ]]; then
      verify_official_release "$version"
    fi
    tag_sha=$(remote_tag_commit "$version")
    git merge-base --is-ancestor "$tag_sha" HEAD ||
      die "Validated branch does not contain official upstream tag $version."
    require_command node
    package_version=$(node -p "require('./package.json').version")
    [[ $package_version == "${version#v}" ]] ||
      die "package.json version is $package_version; expected ${version#v}."
    git merge-base --is-ancestor "$CANONICAL_BRANCH" HEAD ||
      die "Validated branch cannot fast-forward $CANONICAL_BRANCH."
    refuse_release_collisions "$release_branch" "$release_tag"
    refuse_existing_image "$image"

    if [[ $apply == false ]]; then
      note "DRY RUN: would fast-forward $CANONICAL_BRANCH to $validated_sha and create local $release_branch there."
      note 'Re-run with --apply to perform those local operations. Nothing will be pushed or tagged.'
      exit 0
    fi

    git switch "$CANONICAL_BRANCH"
    git merge --ff-only "$validated_sha"
    git branch "$release_branch" "$validated_sha"
    note "Created local $release_branch at validated commit $validated_sha."
    note 'No branch or tag was pushed, no image was published, and the sync/correction branch was retained for post-deployment cleanup.'
    ;;
esac
