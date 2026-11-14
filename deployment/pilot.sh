#!/usr/bin/env bash
# Isolated synthetic 0.45 pilot lifecycle. It never selects retained older projects.
set -euo pipefail
base_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH='' cd -- "$base_dir/.." && pwd)
runtime_dir="$repo_dir/pilot/agriculture/.runtime-0.45"
node_image='node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b'
thunderid_image='ghcr.io/thunder-id/thunderid:1.0.1@sha256:d3c0613ff447a551fd440768a15bdfb6668948e80809cbb50f82d6752f22ab3e'
operator_uid="$(id -u):$(id -g)"
pilot_subnet="${PILOT_SUBNET:-10.254.45.0/24}"
cd "$repo_dir"

compose() { "$base_dir/compose.sh" "$@"; }
step() {
  label="$1"
  shift
  printf '%s\n' "$label"
  # Upstream failures may include bearer tokens, assertions or bootstrap
  # credentials. Identify the failed boundary without relaying raw output.
  if ! "$@" >/dev/null 2>&1; then
    printf '%s\n' "$label failed. Raw runtime output was suppressed to protect credentials." >&2
    exit 1
  fi
}
tools() {
  compose run --rm --no-deps tools "$@"
}
node_command() {
  command_name="$1"
  docker run --rm --platform linux/amd64 --user "$operator_uid" \
    --network registry-openfn-pilot-045_default \
    --env OPENFN_URL=http://lightning:4000 \
    --mount "type=bind,src=$repo_dir,dst=/workspace,readonly" \
    --mount "type=bind,src=$runtime_dir,dst=/workspace/pilot/agriculture/.runtime-0.45" \
    --workdir /workspace "$node_image" \
    node pilot/lightning/provision.mjs "$command_name"
}
wait_for() {
  ca_file="${4:-}"
  if [ -n "$ca_file" ]; then
    tools python3 /workspace/deployment/wait-http.py "$1" "$2" "${3:-90}" "$ca_file"
  else
    tools python3 /workspace/deployment/wait-http.py "$1" "$2" "${3:-90}"
  fi
}
require_prepared() {
  if [ ! -f "$runtime_dir/prepared.json" ]; then
    printf '%s\n' 'No completed 0.45 pilot configuration. Run deployment/pilot.sh setup first.' >&2
    exit 1
  fi
  python3 -c '
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
try:
    marker = json.loads(path.read_text())
except Exception:
    raise SystemExit("The 0.45 prepared marker is unreadable.")
if marker.get("schema") != "synthetic-agriculture-pilot/v1" or marker.get("version") != "0.45.0":
    raise SystemExit("The selected runtime is not the isolated 0.45 agriculture pilot.")
if marker.get("pilotSubnet") != sys.argv[2]:
    raise SystemExit("The selected pilot subnet differs from the prepared Evidence source allowance.")
' "$runtime_dir/prepared.json" "$pilot_subnet"
}
issuer_one_shot() {
  password_file="$1"
  shift
  (
    ADMIN_PASSWORD=$(cat "$password_file")
    export ADMIN_PASSWORD
    docker run --rm --platform linux/amd64 --user "$operator_uid" --env ADMIN_PASSWORD \
      --workdir /opt/thunderid \
      --mount "type=bind,src=$runtime_dir/issuer/database,dst=/opt/thunderid/database" \
      --mount "type=bind,src=$runtime_dir/issuer/certs,dst=/opt/thunderid/config/certs" \
      --mount "type=bind,src=$runtime_dir/issuer/secrets,dst=/opt/thunderid/config/secrets" \
      --mount "type=bind,src=$runtime_dir/issuer/deployment.yaml,dst=/opt/thunderid/deployment.yaml" \
      "$@"
  )
}
prepare_issuer_state() {
  issuer_root="$runtime_dir/issuer"
  if [ ! -f "$issuer_root/.setup-complete" ]; then
    if [ -n "$(find "$issuer_root/database" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      printf '%s\n' 'ThunderID database state exists without its setup marker; inspect the retained fresh-pilot state before retrying.' >&2
      exit 1
    fi
    step 'Seed the pinned ThunderID database schema.' \
      docker run --rm --platform linux/amd64 --user "$operator_uid" \
      --mount "type=bind,src=$issuer_root/database,dst=/seed" --entrypoint sh \
      "$thunderid_image" -c 'cp -r /opt/thunderid/database/. /seed/'
    step 'Run the one-time stock ThunderID setup.' \
      issuer_one_shot "$issuer_root/secrets/admin-password" "$thunderid_image" ./setup.sh
    (
      umask 077
      : >"$issuer_root/.setup-complete"
    )
  fi
  step 'Apply the additive ThunderID agent schema and machine clients.' \
    issuer_one_shot "$issuer_root/secrets/bootstrap-password" \
    --mount "type=bind,src=$issuer_root/registry-schema,dst=/mounted/registry-schema" \
    --mount "type=bind,src=$issuer_root/resources,dst=/opt/thunderid/config/resources" \
    --entrypoint ./thunderid "$thunderid_image" bootstrap --defaults /mounted/registry-schema
}
prepare_openbao_state() {
  openbao_root="$runtime_dir/openbao"
  step 'Start the isolated persistent OpenBao provider.' compose up -d openbao
  step 'Wait for the sealed or uninitialized OpenBao API.' \
    wait_for 'http://127.0.0.1:8200/v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200' OpenBao 90
  if [ ! -f "$openbao_root/root-token" ]; then
    if [ -e "$openbao_root/init.json.tmp" ] || [ -e "$openbao_root/unseal-key" ]; then
      printf '%s\n' 'Preserved OpenBao initialization artifacts exist without a complete root token; inspect recovery state before retrying.' >&2
      exit 1
    fi
    step 'Initialize the isolated OpenBao provider once.' \
      compose exec -T openbao sh -ec 'umask 077; bao operator init -key-shares=1 -key-threshold=1 -format=json > /run/openbao-secrets/init.json.tmp'
    step 'Record the OpenBao unseal share and bootstrap token privately.' \
      tools python3 /workspace/deployment/openbao-state.py record-init /workspace/pilot/agriculture/.runtime-0.45/openbao
  fi
  step 'Unseal only this pilot OpenBao provider.' \
    tools python3 /workspace/deployment/openbao-state.py unseal \
    /workspace/pilot/agriculture/.runtime-0.45/openbao
  step 'Wait for the unsealed OpenBao API.' wait_for http://127.0.0.1:8200/v1/sys/health OpenBao 90
  step 'Create or verify the scoped non-exportable Evidence Transit key.' \
    compose exec -T openbao sh /openbao/bootstrap.sh
  step 'Bind the exact Transit version-one public key into Evidence authoring.' \
    tools python3 /workspace/deployment/openbao-state.py record-public /workspace/pilot/agriculture/.runtime-0.45
  step 'Start the official OpenBao Agent Unix-socket proxy.' compose up -d evidence-transit
  step 'Wait for the private Evidence Transit socket.' \
    tools python3 -c 'import os,stat,time; p="/run/registry-evidence/transit-proxy.sock"; end=time.time()+60
while time.time()<end:
 try:
  if stat.S_ISSOCK(os.stat(p).st_mode): raise SystemExit(0)
 except FileNotFoundError: pass
 time.sleep(1)
raise SystemExit(1)'
}
start_services() {
  require_prepared
  step 'Validate Compose configuration.' compose config --quiet
  step 'Prepare persistent 0.45 pilot volume ownership.' \
    compose up --no-deps --abort-on-container-exit --exit-code-from volume-init volume-init
  step 'Start the isolated 0.45 databases.' compose up -d --wait --wait-timeout 90 lightning-db breg-db casework-db
  prepare_issuer_state
  step 'Start stock ThunderID and the fixed TLS gateway.' compose up -d issuer tls-gateway
  step 'Wait for the HTTPS ThunderID issuer.' \
    wait_for https://127.0.0.1:8443/.well-known/openid-configuration ThunderID 120 /workspace/pilot/agriculture/.runtime-0.45/tls/ca.pem
  prepare_openbao_state
  step 'Apply upstream Lightning database migrations.' \
    compose run --rm --no-deps lightning /app/bin/lightning eval 'Lightning.Release.migrate()'
  step 'Rehearse and activate the BREG and Casework 0.45 packages.' \
    tools python3 /opt/pilot/agriculture/initialize.py core
  step 'Start BREG, Casework and Lightning.' compose up -d breg casework lightning
  step 'Wait for BREG.' wait_for http://127.0.0.1:8090/ready BREG
  step 'Wait for Casework.' wait_for http://127.0.0.1:8092/health Casework
  step 'Provision the Casework review team, served queue and reviewer membership.' \
    tools python3 /opt/pilot/agriculture/initialize.py directory
  step 'Wait for Casework directory readiness.' wait_for http://127.0.0.1:8092/ready Casework
  # Doctor proves the exclusive audit writer lock before the service takes it.
  step 'Stop Evidence before verifying its exclusive audit writer.' compose stop evidence
  step 'Compile and verify the Evidence package against the live Transit key.' \
    tools python3 /opt/pilot/agriculture/initialize.py evidence
  step 'Start Evidence.' compose up -d evidence
  step 'Wait for Evidence.' wait_for http://127.0.0.1:8080/ready Evidence
  step 'Wait for the HTTPS Evidence endpoint.' \
    wait_for https://127.0.0.1:8445/ready Evidence 90 /workspace/pilot/agriculture/.runtime-0.45/tls/ca.pem
  step 'Wait for Lightning.' wait_for http://lightning:4000/health_check Lightning 120
  step 'Prepare the pilot operator through upstream contexts.' \
    compose exec -T lightning /app/bin/lightning rpc 'Code.eval_file("/opt/pilot/lightning/admin.exs"); :ok'
  step 'Provision disabled workflows and credentials through the API.' node_command provision
  step 'Attach webhook authentication through upstream contexts.' \
    compose exec -T lightning /app/bin/lightning rpc 'Code.eval_file("/opt/pilot/lightning/admin.exs"); :ok'
  step 'Verify webhook protection before enabling triggers.' node_command enable
  step 'Start worker, verified event bridge and destination.' compose up -d worker bridge destination
  step 'Wait for the worker.' wait_for http://127.0.0.1:2222/livez Worker
  step 'Wait for the event bridge.' wait_for http://127.0.0.1:8081/healthz Bridge
  step 'Wait for the destination.' wait_for http://destination:8082/healthz Destination
  printf '%s\n' 'Pilot ready at http://localhost:4010. Run the pilot smoke journey to verify its full behavior.'
}

case "${1:-}" in
setup)
  "$base_dir/build-images.sh" --quiet
  if [ ! -e "$runtime_dir" ]; then
    staging_dir="$base_dir/.runtime/preparation-0.45"
    if [ -e "$staging_dir" ]; then
      printf '%s\n' 'The 0.45 preparation staging directory exists. Inspect it before retrying; it was preserved.' >&2
      exit 1
    fi
    (
      umask 077
      mkdir -p "$base_dir/.runtime"
      mkdir "$staging_dir"
    )
    step 'Generate private synthetic 0.45 inputs and offline fixtures.' \
      docker run --rm --platform linux/amd64 --network none --user "$operator_uid" \
      --mount "type=bind,src=$repo_dir,dst=/workspace,readonly" \
      --mount "type=bind,src=$staging_dir,dst=/output" \
      registry-openfn-tools:pilot-045 python3 /workspace/pilot/agriculture/prepare.py \
      --bin-dir /usr/local/bin --output /output/runtime --pilot-subnet "$pilot_subnet"
    mv "$staging_dir/runtime" "$runtime_dir"
    rmdir "$staging_dir"
  fi
  require_prepared
  step 'Prepare private OpenFn credentials.' \
    docker run --rm --platform linux/amd64 --network none --user "$operator_uid" \
    --mount "type=bind,src=$repo_dir,dst=/workspace,readonly" \
    --mount "type=bind,src=$runtime_dir,dst=/workspace/pilot/agriculture/.runtime-0.45" \
    --workdir /workspace "$node_image" node pilot/lightning/provision.mjs prepare
  step 'Check runtime secret ownership.' "$base_dir/check-permissions.sh"
  start_services
  ;;
start) start_services ;;
stop)
  require_prepared
  compose stop
  printf '%s\n' 'The 0.45 pilot stopped. Its isolated databases, keys and history are retained.'
  ;;
status)
  require_prepared
  compose ps
  ;;
reset)
  if [ "${2:-}" != '--confirm-delete-synthetic-data' ] || [ "$#" -ne 2 ]; then
    printf '%s\n' 'Reset permanently deletes only the 0.45 pilot databases, history and private keys. To authorize it, use: deployment/pilot.sh reset --confirm-delete-synthetic-data' >&2
    exit 2
  fi
  require_prepared
  step 'Delete explicitly authorized isolated 0.45 containers and volumes.' compose down --volumes
  rm -r -- "$runtime_dir"
  printf '%s\n' 'The isolated 0.45 synthetic pilot state was deleted. Retained older pilots were not selected.'
  ;;
*)
  printf '%s\n' 'Usage: deployment/pilot.sh setup|start|stop|status|reset --confirm-delete-synthetic-data' >&2
  exit 2
  ;;
esac
