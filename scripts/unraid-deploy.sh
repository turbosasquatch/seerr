#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/unraid-deploy.sh \
    --host SSH_TARGET \
    --container NAME \
    --template /boot/config/plugins/dockerMan/templates-user/my-NAME.xml \
    --image ghcr.io/OWNER/PACKAGE:vX.Y.Z-score-mdb.N \
    --expected-commit COMMIT_SHA \
    [--port 5055] [--execute]

The default is a dry run. --execute is required before this script opens SSH,
pulls an image, edits the Unraid XML template, or recreates the container.

The script backs up only the XML template. It intentionally does not back up
appdata and never performs an automatic rollback.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

print_shell_word() {
  printf '%q' "$1"
}

host=''
container=''
template=''
image=''
expected_commit=''
port='5055'
execute=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      [[ $# -ge 2 ]] || die '--host requires a value.'
      host=$2
      shift 2
      ;;
    --container)
      [[ $# -ge 2 ]] || die '--container requires a value.'
      container=$2
      shift 2
      ;;
    --template)
      [[ $# -ge 2 ]] || die '--template requires a value.'
      template=$2
      shift 2
      ;;
    --image)
      [[ $# -ge 2 ]] || die '--image requires a value.'
      image=$2
      shift 2
      ;;
    --expected-commit)
      [[ $# -ge 2 ]] || die '--expected-commit requires a value.'
      expected_commit=$2
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || die '--port requires a value.'
      port=$2
      shift 2
      ;;
    --execute)
      execute=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n $host ]] || die '--host is required.'
[[ -n $container ]] || die '--container is required.'
[[ -n $template ]] || die '--template is required.'
[[ -n $image ]] || die '--image is required.'
[[ -n $expected_commit ]] || die '--expected-commit is required.'

[[ $host =~ ^[A-Za-z0-9._@:-]+$ ]] || die 'SSH target contains unsupported characters.'
[[ $container =~ ^[A-Za-z0-9_.-]+$ ]] || die 'Container name contains unsupported characters.'
[[ $template =~ ^/boot/config/plugins/dockerMan/templates-user/[A-Za-z0-9_.-]+\.xml$ ]] ||
  die 'Template must be an XML file in the Unraid templates-user directory.'
[[ $image =~ ^ghcr\.io/[a-z0-9._-]+/[a-z0-9._-]+:(v[0-9]+\.[0-9]+\.[0-9]+)-score-mdb\.[1-9][0-9]*$ ]] ||
  die 'Image must use an immutable ghcr.io vX.Y.Z-score-mdb.N tag.'
expected_version=${BASH_REMATCH[1]#v}
[[ $expected_commit =~ ^[0-9a-f]{7,40}$ ]] || die 'Expected commit must be a 7-40 character lowercase Git SHA.'
[[ $port =~ ^[0-9]+$ && $port -ge 1 && $port -le 65535 ]] || die 'Port must be between 1 and 65535.'

if [[ $execute == false ]]; then
  printf 'DRY RUN: no SSH connection was opened and nothing was changed.\n'
  printf 'Target: '
  print_shell_word "$host"
  printf '\nContainer: '
  print_shell_word "$container"
  printf '\nTemplate: '
  print_shell_word "$template"
  printf '\nImage: '
  print_shell_word "$image"
  printf '\nExpected version/commit: %s / %s\n' "$expected_version" "$expected_commit"
  printf 'Re-run with --execute after confirming the immutable image and rollback image exist.\n'
  exit 0
fi

command -v ssh >/dev/null 2>&1 || die 'ssh is required.'

ssh "$host" /bin/bash -s -- \
  "$container" "$template" "$image" "$expected_version" "$expected_commit" "$port" <<'REMOTE_SCRIPT'
set -Eeuo pipefail

container=$1
template=$2
image=$3
expected_version=$4
expected_commit=$5
port=$6
update_script='/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/update_container'
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
log_file="/tmp/${container}-fork-release-${timestamp}.log"

exec > >(tee -a "$log_file") 2>&1

die() {
  printf 'ERROR: %s\n' "$*" >&2
  printf 'Deployment stopped without rollback. Inspect %s and the retained container.\n' "$log_file" >&2
  exit 1
}

for command_name in docker curl grep sed cp cmp mktemp mv tee seq sleep; do
  command -v "$command_name" >/dev/null 2>&1 || die "Required command not found: $command_name"
done
[[ -x /usr/bin/php ]] || die '/usr/bin/php is required by Unraid Docker Manager.'
[[ -f $update_script ]] || die "Unraid Docker Manager update script not found: $update_script"
[[ -f $template ]] || die "Template not found: $template"
docker inspect "$container" >/dev/null 2>&1 || die "Container not found: $container"

repository_count=$(grep -cE '<Repository>[^<]*</Repository>' "$template" || true)
[[ $repository_count -eq 1 ]] || die "Expected exactly one Repository element in $template; found $repository_count"

old_image=$(docker inspect --format '{{.Config.Image}}' "$container")
old_restart=$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$container")
old_network=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")
old_ports=$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$container")
old_binds=$(docker inspect --format '{{json .HostConfig.Binds}}' "$container")
old_labels=$(docker inspect --format '{{json .Config.Labels}}' "$container")
old_env=$(docker inspect --format '{{json .Config.Env}}' "$container" | /usr/bin/php -r '
  $values = json_decode(stream_get_contents(STDIN), true) ?: [];
  $values = array_values(array_filter($values, fn($value) => !str_starts_with($value, "COMMIT_TAG=")));
  sort($values);
  echo json_encode($values);
')

[[ $old_restart == 'always' ]] || die "Expected restart policy always; found: $old_restart"
[[ $old_network == 'bridge' ]] || die "Expected bridge networking; found: $old_network"
printf '%s' "$old_binds" | grep -Fq ':/app/config' || die 'Container does not have the required /app/config bind mount.'

printf 'Current image: %s\n' "$old_image"
printf 'Pulling immutable image: %s\n' "$image"
docker pull "$image"

backup="${template}.fork-release-${timestamp}.bak"
cp -p "$template" "$backup"
temp_template=$(mktemp "${template}.tmp.XXXXXX")
sed "s|<Repository>[^<]*</Repository>|<Repository>${image}</Repository>|" "$template" >"$temp_template"
cmp -s "$template" "$temp_template" && die 'Template Repository value did not change; refusing to recreate the container.'
mv "$temp_template" "$template"
printf 'Template backup: %s\n' "$backup"

/usr/bin/php -q "$update_script" "$container"

for attempt in $(seq 1 30); do
  if [[ $(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true) == 'true' ]] &&
    curl -fsS "http://127.0.0.1:${port}/api/v1/status?checkUpdateAvailable=false" >/dev/null 2>&1; then
    break
  fi
  [[ $attempt -lt 30 ]] || die 'Container did not become healthy within 30 seconds.'
  sleep 1
done

new_image=$(docker inspect --format '{{.Config.Image}}' "$container")
new_restart=$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$container")
new_network=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")
new_ports=$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$container")
new_binds=$(docker inspect --format '{{json .HostConfig.Binds}}' "$container")
new_labels=$(docker inspect --format '{{json .Config.Labels}}' "$container")
new_env=$(docker inspect --format '{{json .Config.Env}}' "$container" | /usr/bin/php -r '
  $values = json_decode(stream_get_contents(STDIN), true) ?: [];
  $values = array_values(array_filter($values, fn($value) => !str_starts_with($value, "COMMIT_TAG=")));
  sort($values);
  echo json_encode($values);
')

[[ $new_image == "$image" ]] || die "Container uses $new_image instead of $image"
[[ $new_restart == "$old_restart" ]] || die "Restart policy changed: $old_restart -> $new_restart"
[[ $new_network == "$old_network" ]] || die "Network mode changed: $old_network -> $new_network"
[[ $new_ports == "$old_ports" ]] || die 'Port bindings changed during recreation.'
[[ $new_binds == "$old_binds" ]] || die 'Bind mounts changed during recreation.'
[[ $new_labels == "$old_labels" ]] || die 'Container labels changed during recreation.'
[[ $new_env == "$old_env" ]] || die 'Configured environment changed during recreation.'

status_json=$(curl -fsS "http://127.0.0.1:${port}/api/v1/status?checkUpdateAvailable=false")
api_version=$(printf '%s' "$status_json" | /usr/bin/php -r '$d=json_decode(stream_get_contents(STDIN), true); echo $d["version"] ?? "";')
api_commit=$(printf '%s' "$status_json" | /usr/bin/php -r '$d=json_decode(stream_get_contents(STDIN), true); echo $d["commitTag"] ?? "";')
restart_required=$(printf '%s' "$status_json" | /usr/bin/php -r '$d=json_decode(stream_get_contents(STDIN), true); echo !empty($d["restartRequired"]) ? "true" : "false";')

[[ $api_version == "$expected_version" ]] || die "API reports version $api_version; expected $expected_version"
[[ $api_commit == "$expected_commit" ]] || die "API reports commit $api_commit; expected $expected_commit"
[[ $restart_required == 'false' ]] || die 'API reports restartRequired=true.'

docker logs --since 5m --tail 200 "$container"
if docker logs --since 5m --tail 200 "$container" 2>&1 |
  grep -Eiq 'fatal|unhandled.*exception|migration.*(failed|error)'; then
  die 'Startup logs contain a fatal, unhandled, or migration error.'
fi

printf 'Deployment verified: %s is running %s at commit %s.\n' "$container" "$api_version" "$api_commit"
printf 'Rollback image retained by policy: verify it manually before deleting any old image.\n'
printf 'Complete authenticated UI checks for MDBList discovery/filtering and TMDb scores before cleanup.\n'
REMOTE_SCRIPT
