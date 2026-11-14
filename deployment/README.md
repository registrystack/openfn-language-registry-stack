# Pilot container packaging

This directory deploys matching Registry Stack **0.45.0** clients, tools,
runtimes and authored packages. ThunderID provides identity, Casework owns
review decisions, and BREG owns authoritative records and explicit application.
Evidence uses a persistent OpenBao Transit key through an official Agent Unix
proxy. Upstream Lightning 2.18.2 and websocket worker 1.29.0 remain unchanged.
Image identities and tool checksums are recorded in `images.lock.json` and
`tools.sha256`.

The current deployment is a fresh synthetic pilot. Its fixed Compose project is
`registry-openfn-pilot-045`, and its private configuration is under
`pilot/agriculture/.runtime-0.45`. The previous `registry-openfn-pilot-038`
project and `pilot/agriculture/.runtime-0.38` directory are not reused, migrated,
or removed. The still older `registry-openfn-pilot` project and
`pilot/agriculture/.runtime` directory are also retained separately. A
retained-record upgrade needs the product's staged migration procedure; running
current tools against either older database is not that procedure.

Run `./deployment/pilot.sh setup` for first setup, then `start`, `stop`, or
`status`. Setup builds pinned images, prepares fresh owner-only inputs, checks
and activates the BREG and Casework packages, initializes the signer, packages
Evidence against its exact public key, and applies the upstream Lightning
migrations. Workflows are provisioned disabled, webhook authentication is
attached and tested, then triggers are enabled. Each failed stage identifies
itself while suppressing raw runtime output, which can contain credentials.
Readiness waits are bounded. Setup alone does not prove acceptance: finish with
`python3 pilot/smoke.py`.

`./deployment/build-images.sh` builds the worker and checks the exact generated
Lightning job bodies with the released compiler and runtime. The destination
body executes against a synthetic loopback server. The checks exercise native
client loading, automatic adaptor imports, and configuration removal at the job
boundary. A separate network-disabled container verifies the released engine's
child-process handshake under the configured operator UID/GID. No dependency
installation happens when the worker starts.

The upstream worker release is Alpine. Its compiled application is copied
unchanged into pinned Node 24.19.0 Bookworm and its released dependency lock is
installed for glibc. The current adaptor dependency graph is installed at image
build time. There is no OpenFn source patch. The released Lightning and worker
images provide **linux/amd64 only**; Apple Silicon therefore uses emulation.
An arm64 client or constructor check does not establish arm64 worker support.

ThunderID owns the shared network namespace used by BREG, Casework, Evidence,
the worker, bridge and bootstrap tools. A pinned NGINX gateway provides HTTPS
for the issuer, Evidence source access and Evidence API using a private pilot
CA. Client trust is bound to that CA; the token issuer is the actual HTTPS
origin. Remaining explicit development HTTP uses loopback inside that
namespace. Pilot TLS and database certificates expire after 365 days; an
operated deployment needs a renewal procedure that preserves its data and keys.
Host publications also bind only
to loopback: Lightning UI **4010**, bridge **4011**, BREG **4012**, and Casework
**4013**. The gateway forwards those development service ports to the native
loopback listeners inside the shared namespace. Independent Lightning, BREG and Casework PostgreSQL databases retain
their own data. PostgreSQL configuration stages owner-only SQL and TLS keys with
the database runtime's ownership before invoking the unchanged entrypoint. A
network-disabled disposable database check verifies that handoff without
mounting pilot data.

OpenBao has a persistent backend and owner-only initialization material. A
restart unseals the existing backend; it does not initialize a replacement or
create another signing key. The Agent uses its separate AppRole and a scoped
read/sign policy for the Evidence key. The policy requires an explicit key
version but does not restrict its numeric value. The released signer pins and
verifies version one; startup refuses rotated or multi-version keys. Do not
rotate this pilot key while services are running: after privileged rotation,
the raw Agent socket could sign another version. Evidence receives only
the workload-local socket and governed public key, without a provider token or
private signing key. This is a supervised local demonstration, not a production
secret-custody or automatic-unseal deployment.

Configuration mounts are scoped to each service. The worker receives its
Evidence client configuration, Lightning its bootstrap secrets, and Evidence its own
runtime, secrets, audit storage and signing socket. Bootstrap tools are an
operator surface with privileged package, database and reviewer material. Do
not expose their mounts or the Docker daemon. The reviewer is an explicit
synthetic teaching identity; an operated deployment needs real human sessions
and independently governed permissions.

`./deployment/compose.sh` is the supported Compose entrypoint. It fixes the
project name and operator UID/GID using an ignored environment file. Generated
files remain owned by that operator with restrictive modes. The worker image
contains a matching passwd/group entry because upstream engine children start
with an empty environment. When transferring a pilot to another operator,
transfer private-file ownership explicitly and rebuild images. Do not widen
secret permissions. `./deployment/check-permissions.sh` checks service mount
readability without printing contents.

The pilot uses the dedicated Docker subnet `10.254.45.0/24`, so it can start
when Docker's default address pools are exhausted. Evidence reaches its source
and token endpoint through the private `issuer` service address, bound to the
pilot CA and a destination allowance for the selected `/24` only. If the
default subnet conflicts with another network, set `PILOT_SUBNET` to an unused
`/24` inside `10.254.0.0/16` before first setup and retain that setting when
starting the same pilot. Startup rejects a subnet that differs from the one
bound into the prepared Evidence target.

External Sentry reporting and Lightning usage tracking are disabled. Lightning
retains dataclips and workflow history according to its pilot retention setting;
minimized job output does not erase original webhook inputs. Registry, Casework
and Evidence audits, local review snapshots and destination effects have their
own retention. Never publish raw logs or private runtime folders.

Stop and restart retain data, keys and packages. Reset is separate and
permanently deletes only the current 0.45 synthetic project and marked runtime:
`./deployment/pilot.sh reset --confirm-delete-synthetic-data`. Neither setup,
start, stop nor smoke resets data. A partially activated package or failed
preparation is retained for inspection; follow the owning product recovery
procedure rather than clearing an interlock.

The Linux CI gate runs a fresh setup, the registration/correction/Evidence
journey, retained restart, exact replay and bounded failure-recovery scenarios.
Build and offline fixture checks establish different boundaries and do not
replace that live acceptance proof.

The local Evidence client uses explicit native SDK configuration with the pinned
Transit public key, exact package revision and verification policy, and private-key
JWT authentication. The local HTTPS endpoint uses explicit trust configuration
for the private pilot CA. Source authorization and signed-response verification
use the released SDK under this configuration.
