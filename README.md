# Registry Stack adaptors for OpenFn

**Beta:** intended for supervised, self-hosted pilots. APIs and deployment
configuration may change before 1.0.

A self-hosted synthetic pilot connecting upstream OpenFn Lightning to Registry
Stack Base Registry Engine (BREG) and signed Evidence. It demonstrates registration,
reviewed correction, and an idempotent downstream update containing a verified
Boolean. All supplied people, holding names, identifiers and credentials are for
an isolated local pilot.

The maintained pilot uses:

- [Registry Evidence adaptor](packages/registry-evidence), using the `evidence`
  namespace of the published `@registrystack/client@0.27.0`.
- [Registry BREG adaptor](packages/registry-breg), using the same package's `breg`
  namespace for metadata-selected writes, exact lookups and lifecycle actions.
- Upstream Lightning 2.18.2 and websocket worker 1.29.0, packaged with Node
  24.19.0 on glibc and local adaptors. No OpenFn source patch is required.
- Separate BREG and Lightning PostgreSQL databases, Mint, Evidence, an
  authenticated event bridge and a small SQLite-backed destination.

[Image identities](deployment/images.lock.json), the npm lockfile, and bootstrap
[tool checksums](deployment/tools.sha256) pin the delivered dependencies.

## What the three workflows do

| Workflow | Authoritative result | Response and boundary |
| --- | --- | --- |
| Registration | Creates one Farm using a stable submission key. | The authenticated synchronous webhook returns its UUID. An exact retry returns the same record; changed content with the same key conflicts. |
| Correction | Creates and submits a name-correction request. | Returns its request UUID. A separate reviewer approves, then explicitly applies it. Submission and approval leave the Farm unchanged. |
| Committed Farm event | Verifies HMAC delivery, requests signed registration Evidence, then updates the destination. | Asynchronous. Only the verified `registered: true`, record reference and revision reach the destination. |

BREG owns records, permissions, review, revisions, ETags and the transactional
outbox. OpenFn orchestrates these contracts. The Evidence source performs an
exact authorized Farm lookup and returns only `localIdentifier`; Evidence signs
one registration Boolean. The assertion makes no claim about eligibility,
ownership, activity or land rights. An unresolved holding produces unavailable
Evidence, never an invented `false` assertion.

The bridge validates the signed event before forwarding its minimized input to
OpenFn using a separate committed-event key. Registration and correction clients
receive only the intake key and cannot call that event endpoint. The destination
deduplicates by stable source, event ID and effect and
refuses conflicting replays. Revision checks prevent old deliveries from
regressing current state. Outbox delivery remains at least once.

## Requirements and first setup

Use Docker Engine with Compose v2, or a compatible desktop Docker runtime,
Python 3, and a POSIX shell. The build needs access to the pinned upstream images
and Registry Stack release downloads. Host Node is needed for adaptor tests,
but setup performs its Node and Registry CLI work in containers.

The released Lightning and worker images are `linux/amd64`; Apple Silicon uses
Docker emulation. Native arm64 adaptor loading does not establish arm64 worker
support. See the [container packaging notes](deployment/README.md) for the glibc
worker packaging and architecture limits. Allow enough Docker disk and memory
for two databases and the upstream application builds.

From this repository:

```sh
./deployment/pilot.sh setup
./deployment/pilot.sh status
python3 pilot/smoke.py
```

Setup builds the pinned images, runs the real native adaptor worker check,
generates private inputs and Evidence fixtures, initializes the isolated BREG
package, applies upstream Lightning migrations, and provisions the pilot
operator and credentials. Webhooks stay disabled until authentication is
attached and checked. A failed step stops setup and identifies the step without
printing raw service output. Setup is not a statement that the full acceptance
journey passed; the smoke must finish with `"status": "passed"`.

Open [Lightning](http://localhost:4000). The generated login is in
`pilot/agriculture/.runtime/openfn/secrets/operator.json`; open that private file
locally to read the email and password. Do not paste its contents into tickets,
job expressions or logs. There is no shared default password. The same private
folder contains the operator API token, separate intake and committed-event keys,
credential associations and
`project.json`, which records the actual project and trigger UUIDs.

The smoke creates a fresh synthetic identity once and stores it in owner-only
`pilot/agriculture/.runtime/smoke-state.json`. It exercises registration,
unchanged and conflicting retries, correction submission, separate reviewer
approval/application, event-driven Evidence and destination effects. Repeating
it reuses its original keys and records. It does not clear data or make a new
registration on every run. Direct native HTTP checks are also available in the
[agriculture guide](pilot/agriculture/README.md).

## Forms and manual review

The generated project has registration and correction webhook endpoints at
`http://localhost:4000/i/TRIGGER_UUID`. Read their UUIDs from private
`project.json`, and send the intake `webhook-api-key` in `x-api-key`. Keep that key
in the form integration's credential store. Never give form clients the separate
`committed-api-key`; it belongs to the authenticated event bridge. Do not place
either key in the URL.
Registration and correction wait for completion; successful responses include
the final state under `data.data`, while workflow failure uses HTTP 422. The
committed-event trigger acknowledges asynchronously.

[Synthetic registration input](pilot/agriculture/inputs/registration.json) and
[correction input](pilot/agriculture/inputs/correction.json) show the payloads.
Set the correction's `recordId` to the registered Farm UUID. Keep `submissionId`
stable for the same logical request; use a new one for a deliberately different
request. A correction retry must match all original fields, including its
supporting reference. Workflow outputs return the Farm or request UUID and do
not return the submitted name.

Approval and application use the separate reviewer credential in the tools
service. OpenFn never receives this private key. Substitute the correction
request UUID, inspect the displayed synthetic proposal, then decide:

```sh
./deployment/compose.sh run --rm --no-deps tools \
  python3 /opt/pilot/agriculture/review.py inspect REQUEST_UUID
./deployment/compose.sh run --rm --no-deps tools \
  python3 /opt/pilot/agriculture/review.py approve REQUEST_UUID
# The Farm is still unchanged. Inspect the approved request before application.
./deployment/compose.sh run --rm --no-deps tools \
  python3 /opt/pilot/agriculture/review.py inspect REQUEST_UUID
./deployment/compose.sh run --rm --no-deps tools \
  python3 /opt/pilot/agriculture/review.py apply REQUEST_UUID
```

The reviewer helper binds the action to its exact inspected proposal version,
effect digest and lifecycle ETag. A stale snapshot is refused. A record ETag is
not a lifecycle ETag. The smoke invokes these explicit steps only for the
synthetic correction it created and verified.

## Stop, resume and restart recovery

```sh
./deployment/pilot.sh stop
./deployment/pilot.sh start
./deployment/check-permissions.sh
python3 pilot/smoke.py
# After the main smoke passes, exercise service restart with retained records.
python3 pilot/smoke.py --restart-recovery
```

Stop retains named volumes, Registry history and private configuration. Start
checks the retained package and reapplies the supported upstream startup path.
Restart recovery restarts existing application services and verifies the same
records, correction and destination effects. It does not recreate databases or
Mint's shared network namespace.

Always use `deployment/compose.sh` for lower-level commands. It fixes the Compose
project to `registry-openfn-pilot` and preserves the operator UID/GID in ignored
`deployment/.env`. If the pilot moves to another operator, transfer ownership
of its retained private files explicitly and update that file. Do not solve a
permission failure by making keys world-readable.

Reset is separate and permanently destroys this synthetic pilot's containers,
volumes, records, history and generated private keys:

```sh
./deployment/pilot.sh reset --confirm-delete-synthetic-data
```

Neither setup, start, stop nor smoke invokes reset. An incomplete preparation or
package activation is retained for inspection. Resolve the exact failed stage
using the owning BREG recovery procedure; do not clear a migration interlock or
remove a partially activated database to make readiness pass.

## Failure and replay recovery

| Symptom | Recovery |
| --- | --- |
| Timeout or failed registration/correction job | Inspect the failed work order in Lightning, restore the dependency, then retry the original input with its original submission ID. A timeout can follow a committed mutation. Do not generate a fresh key to hide an unknown outcome. |
| Idempotency or ETag conflict | Confirm whether the payload changed or the baseline is stale. Reuse the original payload for an exact replay. For a deliberate new correction, review current state and create a new submission; do not force a write with a stale ETag. |
| Already-submitted correction | The workflow rereads the request and verifies its original content before reporting `already_submitted`. A missing action alone is not proof of success. |
| Rejected correction | Read the review decision. A repeat of the original submission reports the existing request ID; inspect its current BREG state and decision. It does not resubmit it. Submit a revised proposal with a new submission ID after review, or use a currently advertised revise action through the BREG adaptor. The pilot form does not automatically revise or approve. |
| Authentication failure or expired credentials | Private-key JWT obtains fresh short-lived access tokens through Mint. Check Mint readiness, host clock, client registration and private-key permissions. Correct the OpenFn credential/profile when keys change. Do not paste a temporary access token into job source or rotate unrelated keys during an exact retry. |
| Evidence unavailable, denied or unverifiable | Leave the destination unchanged. Check the authorized exact source lookup, selected requirement, requester credentials and reviewed trust/profile configuration. Unavailable is not a signed negative. Retry the original failed committed-event work order only after the cause is resolved. |
| Failed committed-event workflow after webhook acknowledgement | Use Lightning's failed work order and original input for recovery. BREG's successful HTTP handoff does not imply that the asynchronous workflow succeeded. Destination deduplication makes an exact successful effect replay safe. |
| Pending or dead-letter BREG delivery | Restore bridge/OpenFn availability, inspect delivery status, then explicitly replay the eligible retained dead letter. Preserve event identity and use the listed generation. Do not edit the outbox or manufacture a new event ID. |

The scoped [recovery helper](pilot/recovery.py) inspects the retained smoke
record's committed-event work orders without printing inputs or credentials.
After repairing the failed dependency, retry its failed step with the same
work order and input:

```sh
python3 pilot/recovery.py --inspect-smoke
python3 pilot/recovery.py --retry-smoke
python3 pilot/smoke.py
```

If the smoke event's workflow succeeded but BREG still retains a dead letter
because its acknowledgement was lost, `python3 pilot/recovery.py --replay-smoke`
replays the eligible generation and verifies the destination effect stays unique.
The helper refuses to replay before the retained workflows have succeeded.

Only while the dedicated pilot is idle, exercise the failure acceptance scenarios:

```sh
python3 pilot/recovery.py --scenario all
```

This deliberately interrupts selected services and then restores them. It checks
BREG retry/dead-letter replay before OpenFn accepts a delivery, retry of a failed
destination step after acceptance, and retained queued work across application
restarts. Each scenario keeps a separate synthetic identity in private
`.runtime/recovery-state.json`; it removes no records or volumes. Select
`before-accept`, `after-accept`, or `pending-restart` instead of `all` for one case.

For value-free BREG delivery status and an explicit eligible replay:

```sh
./deployment/compose.sh run --rm --no-deps tools bregctl webhook list \
  --runtime-config /config/breg/runtime.json
./deployment/compose.sh run --rm --no-deps tools bregctl webhook replay \
  --runtime-config /config/breg/runtime.json \
  --event-id EVENT_UUID --delivery-id DELIVERY_ID --expected-generation GENERATION
```

This pilot retains undelivered payloads for one day. BREG removes payloads after
successful delivery; expired payloads cannot be replayed. A BREG operator replay
keeps the event ID but advances delivery generation. Destination effect identity
uses the stable event ID, so that change does not duplicate an applied effect.

## Private data and diagnostics

This is a loopback-only, supervised local deployment, not a production internet
configuration. Host ports 4000, 4001 and 4002 bind only to loopback. The tools
service has privileged package, database and reviewer material and is an
operator surface. Retain access controls on the Docker daemon and host files.

Lightning is configured to retain workflow history and dataclips for seven days.
That includes original webhook inputs and failed-job inputs even when successful
final output is minimized. Configuration is retained only between operations and
removed by the worker at the job output boundary. This removal does not erase
original event data or an input copied into another state property. Avoid logging
record values or copying credentials into `data`. Upstream worker diagnostics
can contain short-lived JWT URLs; lifecycle scripts suppress raw output for this
reason. Do not publish service logs, private runtime folders or support bundles.

Worker and Lightning external Sentry reporting and usage tracking are disabled.
Registry and Evidence audit volumes, local review snapshots, private smoke state,
and the destination database have their own retention; the seven-day Lightning
setting does not delete them. The destination stores the verified Boolean and
operational identities/revisions, not Farm names or signed assertions.

## Development and verification

Use Node 24.19.0 for the same runtime family as the worker:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run pack:dry-run
```

Tests exercise the published native clients against synthetic HTTP servers,
actual OpenFn compilation/runtime composition, failure redaction, replay and
lifecycle boundaries, bridge authentication and destination persistence. These
checks do not substitute for the container acceptance smoke. The focused
[Linux CI gate](.github/workflows/ci.yml) builds the pinned images, performs setup,
runs the workflow smoke, retained restart recovery and the three bounded failure
scenarios.

To load the adaptors in another compatible OpenFn installation, configure:

```sh
export LOCAL_ADAPTORS=true
export OPENFN_ADAPTORS_REPO=/absolute/path/to/openfn-language-registry-stack
```

Use `@openfn/language-registry-evidence@local` and
`@openfn/language-registry-breg@local`. The packaged worker also carries local
`common` and `http`; installation is complete at image build time. See the
individual adaptor READMEs for credential schemas, operation options, safe
failure branches and standalone composition rules.
