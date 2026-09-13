# BREG event bridge

This service verifies BREG CloudEvents before either committing a local CLI
workflow to a durable inbox or submitting a work order to a fixed OpenFn webhook. It uses Node.js 22.23.2 built-ins and has no package
dependencies. Start with `node services/event-bridge/src/server.js` from the
repository root.

`POST /events/breg` is the only ingress route. The method, path without query,
content type, all signed headers, and bounded exact body bytes are covered by
the BREG `breg-webhook-signature-v1` HMAC contract: unsigned 64-bit big-endian
byte lengths precede each field in the order defined in Registry Stack's
`reference/breg-api` signature section. Secret bytes are neither trimmed nor
decoded. Signatures are compared in constant time. Duplicate signed headers,
content encoding, wrong source/type/schema, stale delivery times, and invalid
payloads are refused before forwarding.

The receiver accepts exactly the common BREG payload members `entity`, `recordId`,
`revision`, `trigger`, `packageRevision`, and `values`. Entity, event schema,
trigger, and projected field names must match configuration. Record/event ids
must be canonical lowercase UUIDs, revision a positive safe integer, package
revision a SHA-256 binding, and projected values strings of at most 1024 UTF-8
bytes. Reviewed `request_lifecycle` events also carry closed request transition
metadata. Per-event `entity` and `valueFields` override the common defaults.
This is a bounded string projection receiver, not a general JSON Schema validator.

Configuration is required unless a default is listed:

| Variable | Meaning |
| --- | --- |
| `BREG_HMAC_KEY_FILE` | File containing exact HMAC key bytes, at least 32 bytes. |
| `BREG_EXPECTED_SOURCE` | Exact CloudEvent source for the registry instance. |
| `BREG_EXPECTED_ENTITY` | Exact payload entity, `farm` for this pilot. |
| `BREG_EXPECTED_EVENTS_FILE` | JSON object mapping each exact type to `{ "schema": "exact-dataschema", "trigger": "created" }`; `patched` and `request_lifecycle` are also supported. Optional per-event `entity` and `valueFields` override defaults; CLI mode requires `effect`. |
| `BREG_ALLOWED_VALUE_FIELDS_FILE` | JSON array of exact projected string fields, `["local-identifier"]` for this pilot. |
| `OPENFN_DELIVERY_MODE` | Default `webhook`; use `cli` for durable local execution. |
| `OPENFN_INBOX_PATH` | Required in CLI mode. Persistent SQLite file in a private directory. |
| `OPENFN_WEBHOOK_URL` | Webhook mode only. Fixed URL, with no credentials, query or fragment. |
| `OPENFN_API_KEY_FILE` | Webhook mode only. Exact printable API key for `x-api-key`; no trailing newline. |
| `ALLOW_HTTP` | Default false. Set exactly `true` only for an explicitly trusted internal HTTP deployment. HTTPS otherwise required. |
| `PORT` | Default 8081. |
| `MAX_BODY_BYTES` | Default 65536; maximum 1048576. |
| `MAX_DELIVERY_SKEW_SECONDS` | Default 300; maximum 3600. Applies to delivery time, not original event time. |
| `OPENFN_TIMEOUT_MS` | Default 3000; maximum 30000. Set below BREG's configured attempt timeout. |

The authenticated OpenFn webhook receives this JSON envelope:

```json
{
  "event": {
    "specversion": "1.0",
    "id": "22222222-2222-4222-8222-222222222222",
    "source": "urn:registrystack:registry:agricultural-holdings:instance:agriculture-openfn-pilot",
    "type": "farm-created-v1",
    "time": "2026-09-09T00:00:00Z",
    "dataschema": "exact configured schema binding"
  },
  "delivery": {
    "generation": 1,
    "attempt": 1,
    "time": "2026-09-09T00:00:01Z",
    "idempotencyKey": "sha256:<64 lowercase hex characters>"
  },
  "data": {
    "entity": "farm",
    "recordId": "11111111-1111-4111-8111-111111111111",
    "revision": 1,
    "trigger": "created",
    "packageRevision": "sha256:<64 lowercase hex characters>",
    "values": { "local-identifier": "SYNTHETIC-FARM-001" }
  }
}
```

In webhook mode, a 2xx OpenFn response must contain a UUID `work_order_id` and no `error` field.
Lightning 2.18.2 does not return a `run_id` for asynchronous acceptance.
Only after this check does the bridge return `202 {"status":"accepted"}` to BREG. This
acknowledges work-order acceptance, not workflow completion. Upstream rejection,
malformed/generic success responses, redirects, transport failures, or oversized
responses produce 502; deadline expiry produces 504. There are no internal
retries, redirect following, or persistent bridge inbox in webhook mode.

If acceptance occurs but the response is lost, BREG can submit another work
order. The workflow and destination must tolerate this, including replay under
a new generation. Destination deduplication uses `(source, eventId, effect)`,
never the generation-specific delivery idempotency key. OpenFn's direct webhook
must remain API-key protected and accessible only to this trusted bridge and
administrators because it contains no independent BREG verifier.

`GET /healthz` returns a static readiness response. Request payloads, headers,
secrets, and upstream error bodies are never logged or reflected in failures.
Run focused checks with `npm --prefix services/event-bridge test`.

## Durable CLI mode

Set `OPENFN_DELIVERY_MODE=cli` and `OPENFN_INBOX_PATH` in the receiver. Omit
webhook URL/API-key settings. Each accepted event type has one stable logical
`effect`, such as `notify-applicant-v1`. Run one receiver per configured source;
receivers and workers may share a local inbox. The receiver validates HMAC and
payload, commits SQLite with WAL and FULL synchronous mode, and returns 202.
It never waits for a workflow. Full or unavailable storage produces a refusal
so BREG can retry; a stopped worker does not delay registry decisions.

The worker uses the same `OPENFN_INBOX_PATH` and a reviewed
`OPENFN_WORKFLOWS_FILE` mapping effects to jobs:

```json
{
  "notify-applicant-v1": {
    "job": "./jobs/notify.js",
    "adaptor": "@openfn/language-common=/absolute/path/to/installed/common",
    "configurationFile": "./private/notification.json"
  }
}
```

Job and configuration paths resolve relative to this file. Use an absolute
installed adaptor path as shown. `configurationFile` is optional. Pin the CLI
and adaptors at installation; execution disables automatic installation and
adaptor-name expansion. `OPENFN_BINARY` selects the installed CLI executable
(default `openfn`). `OPENFN_JOB_TIMEOUT_MS` defaults to 60000, maximum 1800000.
Use a local filesystem, not a network share, and preserve the inbox directory
across ordinary restarts. Protect configuration files and the whole state
volume; SQLite and per-attempt state files are owner-only.

```sh
npm --prefix services/event-bridge run worker -- run
npm --prefix services/event-bridge run worker -- status
npm --prefix services/event-bridge run worker -- replay <effect-id>
```

`once` executes at most one ready item. Status returns only opaque effect IDs,
state, attempt counts and generic failures. A workflow receives
`state.configuration`, the authenticated event envelope as `state.data`, and
`state.eventEffectId`. The latter is a stable SHA-256 identity over source,
event ID and effect. Retry generation and delivery attempt do not change it.
Reusing an identity with different event content is refused. Destination writes
must use this stable identity or a domain-stable report identity for idempotency.

The CLI runs outside the receiver, with a bounded lease, deadline and private
temporary working directory. Exit code zero alone does not establish success:
OpenFn CLI 1.40.1 reports workflow failures in `state.errors`. The worker requires
a valid bounded result with no errors before marking the item successful.
It discards stdout/stderr, removes temporary input/output, and drops the logical
event payload after success while retaining the receipt needed for deduplication.
SQLite/WAL backups may retain old pages; protect the full volume as event data.
Tokens, raw Evidence and credentials must never be event projections.

Failures retry after 1, 2, 4 and 8 seconds, then enter `dead` after five attempts.
An interrupted worker's expired lease also counts toward that bound. Fix the
underlying job, credentials or destination, inspect status, then replay the dead
item by its effect ID. Replay keeps the effect identity. Successful items cannot
be replayed by this command. Preserve receipts for the whole source replay
window; deleting the inbox also deletes destination deduplication history.

SIGINT/SIGTERM lets the current job finish within its deadline and stops the
worker. Allow the supervisor at least the configured job timeout before force
termination. After a forced kill, stop its remaining CLI child process group before
restarting it, wait for the lease to expire, and remove only its abandoned
`attempt-*` directories. A destination may already have accepted an effect
before the worker records success. Delivery is therefore at least once; email
can be duplicated after such a crash. Destinations that support idempotency
should enforce it independently. Dead-letter recovery cannot undo an email.

## Verify the local handoff

Run `npm --prefix services/event-bridge run check` and
`npm --prefix services/event-bridge test`. The explicit CLI journey additionally
requires installed OpenFn CLI 1.40.1 and common adaptor 3.3.4:

```sh
OPENFN_BINARY=/absolute/path/to/openfn \
OPENFN_COMMON_PATH=/absolute/path/to/installed/common \
  npm --prefix services/event-bridge run test:cli
```

This exercises real CLI success, restart/replay, a zero-exit workflow error,
retry and transient-state cleanup. It installs nothing during execution.
See the maintained [OpenFn CLI usage](https://docs.openfn.org/documentation/cli-usage)
for installation and adaptor arguments.
