#!/bin/sh
# Check bind readability as the runtime UIDs without exposing file contents.
set -eu
cd "$(dirname "$0")/.."
runtime_root="$(pwd)/pilot/agriculture/.runtime"
node_image='node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b'
check_tree() {
  service_name="$1"
  runtime_uid="$2"
  subtree="$3"
  if ! docker run --rm --platform linux/amd64 --user "$runtime_uid" \
    --mount "type=bind,src=$runtime_root/$subtree,dst=/check,readonly" \
    "$node_image" node -e 'const fs=require("fs"); function visit(p){fs.accessSync(p,fs.constants.R_OK); const s=fs.statSync(p); if(s.isDirectory()){fs.accessSync(p,fs.constants.X_OK); for(const n of fs.readdirSync(p))visit(p+"/"+n);}} try{visit("/check")}catch{process.exit(1)}'; then
    printf '%s\n' "Permission check failed for $service_name (UID $runtime_uid, $subtree)." >&2
    printf '%s\n' 'Run setup as the operator who owns these generated files and use deployment/compose.sh to match container UID/GID. If transferring an existing pilot, explicitly transfer private file ownership. Do not make secrets public. See deployment/README.md.' >&2
    exit 1
  fi
}
runtime_uid="$(id -u):$(id -g)"
check_tree mint "$runtime_uid" mint
check_tree breg "$runtime_uid" breg
check_tree evidence "$runtime_uid" evidence
check_tree worker "$runtime_uid" evidence-client
check_tree bridge "$runtime_uid" bridge
check_tree destination "$runtime_uid" destination
check_tree lightning "$runtime_uid" openfn/secrets
printf '%s\n' 'All service-specific secret bind mounts are readable by their runtime UIDs.'
