#!/bin/sh
# A stable project name prevents commands from selecting another Compose stack.
set -eu
base_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ ! -f "$base_dir/.env" ]; then
  (umask 077; printf 'PILOT_UID=%s\nPILOT_GID=%s\n' "$(id -u)" "$(id -g)" > "$base_dir/.env")
fi
configured_uid=$(sed -n 's/^PILOT_UID=\([0-9][0-9]*\)$/\1/p' "$base_dir/.env")
configured_gid=$(sed -n 's/^PILOT_GID=\([0-9][0-9]*\)$/\1/p' "$base_dir/.env")
if [ "$configured_uid" != "$(id -u)" ] || [ "$configured_gid" != "$(id -g)" ]; then
  printf '%s\n' 'deployment/.env must contain this operator UID and GID. Review ownership before moving an existing runtime to another operator; do not widen secret permissions.' >&2
  exit 1
fi
exec docker compose --project-name registry-openfn-pilot --env-file "$base_dir/.env" --file "$base_dir/compose.yaml" "$@"
