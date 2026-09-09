#!/bin/sh
# Isolated synthetic pilot lifecycle. It never selects another Compose project.
set -eu
base_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$base_dir/.." && pwd)
runtime_dir="$repo_dir/pilot/agriculture/.runtime"
node_image='node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b'
operator_uid="$(id -u):$(id -g)"
cd "$repo_dir"

compose() { "$base_dir/compose.sh" "$@"; }
step() {
  label="$1"
  shift
  printf '%s\n' "$label"
  # Upstream startup failures can include worker JWT URLs. Do not emit or retain
  # raw subprocess output from lifecycle actions; each failed step is identified.
  if ! "$@" >/dev/null 2>&1; then
    printf '%s\n' "$label failed. Raw runtime output was suppressed to protect credentials." >&2
    exit 1
  fi
}
node_command() {
  command_name="$1"
  docker run --rm --platform linux/amd64 --user "$operator_uid" \
    --network registry-openfn-pilot_default \
    --env OPENFN_URL=http://lightning:4000 \
    --mount "type=bind,src=$repo_dir,dst=/workspace,readonly" \
    --mount "type=bind,src=$runtime_dir,dst=/workspace/pilot/agriculture/.runtime" \
    --workdir /workspace "$node_image" \
    node pilot/lightning/provision.mjs "$command_name"
}
wait_for() {
  compose run --rm --no-deps tools python3 /workspace/deployment/wait-http.py "$1" "$2" "${3:-90}"
}
require_prepared() {
  if [ ! -f "$runtime_dir/prepared.json" ]; then
    printf '%s\n' 'No completed pilot configuration. Run deployment/pilot.sh setup first.' >&2
    exit 1
  fi
}
start_services() {
  require_prepared
  step 'Validate Compose configuration.' compose config --quiet
  step 'Prepare persistent pilot volume ownership.' compose up --no-deps --abort-on-container-exit --exit-code-from volume-init volume-init
  step 'Start isolated databases and Mint.' compose up -d --wait --wait-timeout 90 lightning-db breg-db mint
  step 'Wait for Mint.' wait_for http://127.0.0.1:8091/ready Mint
  step 'Apply upstream Lightning database migrations.' compose run --rm --no-deps lightning /app/bin/lightning eval 'Lightning.Release.migrate()'
  step 'Verify or initialize the exact BREG package.' compose run --rm --no-deps tools python3 /opt/pilot/agriculture/initialize.py
  step 'Start BREG, Evidence and Lightning.' compose up -d breg evidence lightning
  step 'Wait for BREG.' wait_for http://127.0.0.1:8090/ready BREG
  step 'Wait for Evidence.' wait_for http://127.0.0.1:8080/ready Evidence
  step 'Wait for Lightning.' wait_for http://lightning:4000/health_check Lightning 120
  step 'Prepare the pilot operator through upstream contexts.' compose exec -T lightning /app/bin/lightning rpc 'Code.eval_file("/opt/pilot/lightning/admin.exs"); :ok'
  step 'Provision disabled workflows and credentials through the API.' node_command provision
  step 'Attach webhook authentication through upstream contexts.' compose exec -T lightning /app/bin/lightning rpc 'Code.eval_file("/opt/pilot/lightning/admin.exs"); :ok'
  step 'Verify webhook protection before enabling triggers.' node_command enable
  step 'Start worker, verified event bridge and destination.' compose up -d worker bridge destination
  step 'Wait for the worker.' wait_for http://127.0.0.1:2222/livez Worker
  step 'Wait for the event bridge.' wait_for http://127.0.0.1:8081/healthz Bridge
  step 'Wait for the destination.' wait_for http://destination:8082/healthz Destination
  printf '%s\n' 'Pilot ready at http://localhost:4000. Run the pilot smoke journey to verify its full behavior.'
}

case "${1:-}" in
  setup)
    step 'Build pinned images and run native worker gates.' "$base_dir/build-images.sh"
    if [ ! -e "$runtime_dir" ]; then
      staging_dir="$base_dir/.runtime/preparation"
      if [ -e "$staging_dir" ]; then
        printf '%s\n' 'A previous preparation staging directory exists. Inspect it before retrying; it was preserved.' >&2
        exit 1
      fi
      (umask 077; mkdir -p "$base_dir/.runtime"; mkdir "$staging_dir")
      step 'Generate private synthetic runtime inputs and run Evidence fixtures offline.' \
        docker run --rm --platform linux/amd64 --network none --user "$operator_uid" \
        --mount "type=bind,src=$repo_dir,dst=/workspace,readonly" \
        --mount "type=bind,src=$staging_dir,dst=/output" \
        registry-openfn-tools:pilot python3 /workspace/pilot/agriculture/prepare.py \
        --bin-dir /usr/local/bin --output /output/runtime
      mv "$staging_dir/runtime" "$runtime_dir"
      rmdir "$staging_dir"
    fi
    require_prepared
    # Prepare only private local files, before any Docker network is needed.
    step 'Prepare private OpenFn credentials.' \
      docker run --rm --platform linux/amd64 --network none --user "$operator_uid" \
      --mount "type=bind,src=$repo_dir,dst=/workspace,readonly" \
      --mount "type=bind,src=$runtime_dir,dst=/workspace/pilot/agriculture/.runtime" \
      --workdir /workspace "$node_image" node pilot/lightning/provision.mjs prepare
    step 'Check runtime secret ownership.' "$base_dir/check-permissions.sh"
    start_services
    ;;
  start) start_services ;;
  stop)
    require_prepared
    compose stop
    printf '%s\n' 'Pilot stopped. Databases, history and private configuration are retained.'
    ;;
  status)
    require_prepared
    compose ps
    ;;
  reset)
    if [ "${2:-}" != '--confirm-delete-synthetic-data' ] || [ "$#" -ne 2 ]; then
      printf '%s\n' 'Reset permanently deletes this pilot databases, history and private keys. To authorize it, use: deployment/pilot.sh reset --confirm-delete-synthetic-data' >&2
      exit 2
    fi
    require_prepared
    # Validate the marker before deleting only this fixed pilot directory.
    docker run --rm --platform linux/amd64 --network none --user "$operator_uid" \
      --mount "type=bind,src=$runtime_dir,dst=/runtime,readonly" "$node_image" \
      node -e 'const p=require("/runtime/prepared.json");if(p.schema!=="synthetic-agriculture-pilot/v1"||p.version!=="0.27.0")process.exit(1)'
    step 'Delete explicitly authorized synthetic pilot containers and volumes.' compose down --volumes
    # The path is fixed above, not supplied by an argument or an environment var.
    rm -rf -- "$runtime_dir"
    printf '%s\n' 'Synthetic pilot state deleted. Run setup for a new isolated pilot.'
    ;;
  *)
    printf '%s\n' 'Usage: deployment/pilot.sh setup|start|stop|status|reset --confirm-delete-synthetic-data' >&2
    exit 2
    ;;
esac
