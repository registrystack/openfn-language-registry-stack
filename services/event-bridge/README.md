# BREG event bridge

This pilot service verifies BREG CloudEvents before submitting a work order to a
fixed OpenFn webhook. It uses Node.js 22.23.2 built-ins and has no package
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

The pilot accepts exactly the common BREG payload members `entity`, `recordId`,
`revision`, `trigger`, `packageRevision`, and `values`. Entity, event schema,
trigger, and projected field names must match configuration. Record/event ids
must be canonical lowercase UUIDs, revision a positive safe integer, package
revision a SHA-256 binding, and projected values strings of at most 1024 UTF-8
bytes. This deliberately implements the pilot's string projection; it is not
a general JSON Schema validator or lifecycle-event receiver.

Configuration is required unless a default is listed:

| Variable | Meaning |
| --- | --- |
| `BREG_HMAC_KEY_FILE` | File containing exact HMAC key bytes, at least 32 bytes. |
| `BREG_EXPECTED_SOURCE` | Exact CloudEvent source for the registry instance. |
| `BREG_EXPECTED_ENTITY` | Exact payload entity, `farm` for this pilot. |
| `BREG_EXPECTED_EVENTS_FILE` | JSON object mapping each exact type to `{ "schema": "exact-dataschema", "trigger": "created" }`; `patched` is also supported. |
| `BREG_ALLOWED_VALUE_FIELDS_FILE` | JSON array of exact projected string fields, `["local-identifier"]` for this pilot. |
| `OPENFN_WEBHOOK_URL` | Fixed webhook URL, with no credentials, query or fragment. |
| `OPENFN_API_KEY_FILE` | Exact printable API key for `x-api-key`; no trailing newline. |
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

A 2xx OpenFn response must contain a UUID `work_order_id` and no `error` field.
Lightning 2.18.2 does not return a `run_id` for asynchronous acceptance.
Only after this check does the bridge return `202 {"status":"accepted"}` to BREG. This
acknowledges work-order acceptance, not workflow completion. Upstream rejection,
malformed/generic success responses, redirects, transport failures, or oversized
responses produce 502; deadline expiry produces 504. There are no internal
retries, redirect following, or persistent bridge inbox.

If acceptance occurs but the response is lost, BREG can submit another work
order. The workflow and destination must tolerate this, including replay under
a new generation. Destination deduplication uses `(source, eventId, effect)`,
never the generation-specific delivery idempotency key. OpenFn's direct webhook
must remain API-key protected and accessible only to this trusted bridge and
administrators because it contains no independent BREG verifier.

`GET /healthz` returns a static readiness response. Request payloads, headers,
secrets, and upstream error bodies are never logged or reflected in failures.
Run focused checks with `npm --prefix services/event-bridge test`.
