#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
quiet=false
if [ "$#" -eq 1 ] && [ "$1" = '--quiet' ]; then
  quiet=true
elif [ "$#" -ne 0 ]; then
  printf '%s\n' 'Usage: deployment/build-images.sh [--quiet]' >&2
  exit 2
fi
build_step() {
  label="$1"
  shift
  printf '%s\n' "$label"
  if [ "$quiet" = true ]; then
    if ! "$@" >/dev/null 2>&1; then
      printf '%s\n' "$label failed. Raw runtime output was suppressed to protect credentials." >&2
      exit 1
    fi
  else
    "$@"
  fi
}
build_step 'Build the pinned worker image.' docker build --platform linux/amd64 --target worker --build-arg "PILOT_UID=$(id -u)" --build-arg "PILOT_GID=$(id -g)" -f deployment/Worker.Dockerfile -t registry-openfn-worker:pilot-045 .
build_step 'Check compiled worker jobs.' docker run --rm --platform linux/amd64 --entrypoint node registry-openfn-worker:pilot-045 --experimental-vm-modules /opt/registry-adaptors/check-worker.mjs
build_step 'Check worker engine startup.' docker run --rm --platform linux/amd64 --network none --entrypoint node registry-openfn-worker:pilot-045 /opt/registry-adaptors/check-engine.mjs
build_step 'Build the pinned Lightning image.' docker build --platform linux/amd64 -f deployment/Lightning.Dockerfile -t registry-openfn-lightning:pilot-045 .
build_step 'Build the pilot services image.' docker build --platform linux/amd64 -f deployment/Services.Dockerfile -t registry-openfn-services:pilot-045 .
build_step 'Build the pinned PostgreSQL image.' docker build --platform linux/amd64 -f deployment/Postgres.Dockerfile -t registry-openfn-postgres:pilot-045 .
build_step 'Check PostgreSQL private input ownership.' sh deployment/check-postgres.sh
build_step 'Build the pinned Registry Stack tools image.' docker build --platform linux/amd64 -f deployment/Tools.Dockerfile -t registry-openfn-tools:pilot-045 .
