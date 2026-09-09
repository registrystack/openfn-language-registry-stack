# Pilot container packaging

This directory packages upstream Lightning 2.18.2 and websocket worker 1.29.0
with the local Evidence and BREG adaptors. Upstream and
Registry Stack image identities are recorded in `images.lock.json`.

Run `./deployment/build-images.sh` from the repository after its package lock is
current. It builds the worker first and compiles the exact four generated
Lightning job bodies with upstream adaptor export preloading and automatic
imports. The BREG and Evidence jobs must reach their own input validation, and
the destination job executes against a controlled loopback responder. The check
also proves credentials remain available between operations and disappear at
the normal job boundary.
The released engine's real child-process handshake is checked separately under
the image's configured UID and GID, with no network access.
It then builds Lightning, the event services, PostgreSQL TLS setup, and the
checksum-verified Registry Stack 0.27.0 bootstrap tools.
The PostgreSQL check initializes an isolated database from synthetic files owned
by UID1001 with mode 0600, proving that its runtime user can read the staged SQL
without relaxing the operator's file permissions. It mounts no pilot data.
Bootstrap packages come from the signed Debian snapshot dated August 24, 2026,
matching the pinned PostgreSQL base image.

The worker release is Alpine. The worker Dockerfile copies its compiled
application unchanged into pinned Node 24.19.0 Bookworm, installs the upstream
frozen dependency lock for glibc, and installs the adaptor repository's locked
production dependencies. It does not rebuild or patch OpenFn source. The local
adaptor root contains `registry-evidence`, `registry-breg`, `common`, and `http`.
No dependency installation is performed when the worker starts.

The released Lightning and worker images provide **linux/amd64 only**. This
pilot therefore pins that platform, including on Apple Silicon under Docker
emulation. The arm64 adaptor layer independently passed both Evidence and BREG native
constructor checks on Node 24.19.0/glibc 2.36. Reproduce with
`docker build --platform linux/arm64 --target adaptors -f deployment/Worker.Dockerfile .`.
An arm64 native-worker claim requires an upstream arm64 image and a
separate real-worker acceptance run. The Node and Registry Stack clients alone
being available for arm64 does not establish that claim.

`compose.yaml` belongs to the synthetic agriculture pilot. Generate its ignored
runtime configuration using the pilot's setup workflow before using Compose.
It contains persistent independent Lightning and BREG databases. Mint owns a
shared network namespace for BREG, Evidence, worker, bridge and bootstrap tools,
so Registry Stack's explicit development HTTP policy uses loopback. Only the
Lightning UI (4000), BREG event bridge (4001) and BREG reviewer API (4002) are
published, all on host loopback.

Configuration mounts are scoped to each service. In particular the worker only
receives its Evidence client profile, and Lightning receives its own bootstrap
secrets. The bootstrap tools alone receive all generated Registry Stack inputs.
The wrapper copies the database's private key and initial SQL with postgres
ownership and mode 0600 before invoking the unchanged upstream entrypoint. The
initial SQL applies only when PostgreSQL initializes a new named volume.

Follow the pilot runbook for migrations, first operator setup, provisioning,
and acceptance. Build checks establish packaging and native execution; they do
not by themselves establish the full workflow or event-delivery journey.

Use `./deployment/pilot.sh setup` for the complete bootstrap, then `start`,
`stop`, or `status`. Setup preserves an existing completed runtime and verifies
its retained package; it does not clear a failed preparation or reset records.
A failed step stops startup, and raw runtime diagnostics are suppressed because
upstream errors can contain short-lived worker-token URLs. Database migrations
use the upstream release API before starting Lightning. Workflows are provisioned
disabled, webhook authentication is attached, then authentication is checked
before enabling triggers. Readiness waits are bounded.

`./deployment/compose.sh` is the supported Compose entrypoint. It creates ignored
`deployment/.env` containing the current operator UID and GID and uses that same
identity for OpenFn, Registry Stack, bootstrap and event-service containers.
The worker image also bakes a matching passwd/group entry when needed because
upstream starts its engine children with an empty environment. Rebuild images
with `build-images.sh` when transferring the pilot to a different operator.
Generated private files remain owned by that operator with restrictive modes.
The separate PostgreSQL entrypoint still drops to the image's postgres user.
`volume-init` adjusts ownership only inside the pilot's named audit, destination
and worker-cache volumes. It preserves metadata when ownership and permissions
already match, so resumed starts do not invalidate active audit writers.
No other host paths or volumes are touched.

Run `./deployment/check-permissions.sh` after preparing or transferring a pilot.
It checks each service's private bind mount under the selected UID without
printing contents. Moving a pilot to another operator requires an explicit
ownership transfer of retained private files and updating `deployment/.env`;
the wrapper refuses to silently use another operator's settings. Do not make
private keys world-readable. Local image checks use a non-default UID/GID on
macOS/OrbStack. The focused GitHub Actions gate runs fresh setup, the complete
workflow journey, retained restart and failure recovery on Ubuntu 24.04.

External Sentry reporting is explicitly disabled for worker and Lightning, and
Lightning usage tracking is disabled. The worker uses its dedicated writable
cache rather than writing to the packaged application.

Reset is deliberately separate and destructive. Only
`./deployment/pilot.sh reset --confirm-delete-synthetic-data` removes the fixed
`registry-openfn-pilot` project volumes and its marked synthetic `.runtime`
directory. No reset is performed by setup, start or stop. Run the normal pilot
smoke journey after setup to establish full workflow behavior.
