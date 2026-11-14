#!/usr/bin/env bash
# A stable project name prevents commands from selecting another Compose stack.
set -euo pipefail
base_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
env_file="$base_dir/.env-0.45"
if [ ! -f "$env_file" ]; then
  (
    umask 077
    printf 'PILOT_UID=%s\nPILOT_GID=%s\n' "$(id -u)" "$(id -g)" >"$env_file"
  )
fi
configured_uid=$(sed -n 's/^PILOT_UID=\([0-9][0-9]*\)$/\1/p' "$env_file")
configured_gid=$(sed -n 's/^PILOT_GID=\([0-9][0-9]*\)$/\1/p' "$env_file")
if [ "$configured_uid" != "$(id -u)" ] || [ "$configured_gid" != "$(id -g)" ]; then
  printf '%s\n' 'deployment/.env-0.45 must contain this operator UID and GID. Review ownership before moving an existing runtime to another operator; do not widen secret permissions.' >&2
  exit 1
fi
exec docker compose --project-name registry-openfn-pilot-045 --env-file "$env_file" --file "$base_dir/compose.yaml" "$@"
