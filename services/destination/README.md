# Synthetic destination

This pilot destination persists the minimized `registered` result in SQLite.
It uses Node.js 22.23.2 built-ins, including experimental `node:sqlite`, with no
package dependencies. Start with `node services/destination/src/server.js` from
the repository root.

Set `DESTINATION_API_KEY_FILE` to a file containing a printable secret of at
least 32 bytes, with no trailing newline. Set `DESTINATION_DB_PATH` to an
absolute database path on a persistent writable volume. `PORT` defaults to
8082. The process creates the parent directory with mode 0700 and uses umask
0077. Mount existing volumes with ownership suitable for the runtime user.
Keep the SQLite file and WAL sidecars together; restarting the service must
reuse this volume. There is no reset or delete endpoint.

`POST /updates` requires `Content-Type: application/json` and
`x-destination-key: <secret>`. Its body is bounded to 16384 bytes and accepts
exactly these fields:

```json
{
  "source": "urn:registrystack:registry:agricultural-holdings:instance:agriculture-openfn-pilot",
  "eventId": "22222222-2222-4222-8222-222222222222",
  "effect": "record-sync",
  "recordId": "11111111-1111-4111-8111-111111111111",
  "revision": 1,
  "values": { "registered": true }
}
```

No local identifier, owner name, raw Evidence response, token, delivery
generation, or signed assertion belongs in this minimized update. `registered`
is a boolean; the workflow is responsible for deriving it from its verified
Evidence result. The destination trusts its authenticated workflow caller and
does not independently verify Evidence signatures.

SQLite's primary key is `(source, eventId, effect)`. The effect ledger and
record update share one `BEGIN IMMEDIATE` transaction, with WAL journaling and
`synchronous=FULL`. A changed payload under the same effect key returns 409.
Records are keyed by `(source, recordId, effect)` and advance only to a higher
revision. Lower revisions and equal revisions with equal values are recorded
as stale; conflicting values at the same revision return 409.

Successful responses use HTTP 200 and `{ "status": "applied", "revision": 1 }`.
The status is `duplicate` for an already recorded identical event, or `stale`
when its revision cannot advance the record. A duplicate response reports the
event's original revision; stale responses report the current record revision.
Do not infer a second effect from a successful retry. Losing a response after
commit and then retrying, including after restart, returns a duplicate while
preserving one effect. Unavailable storage returns 503 and no success is
released before commit.

`GET /status` requires the same secret header and returns only
`acceptedEvents`, `appliedEffects`, `staleEvents`, `records`, and sorted numeric
`revisions`. It omits source values, identifiers, and payloads. `GET /healthz`
returns a static response after the database opens successfully. The service
does not log secrets or request payloads.

This store makes its own synthetic record update atomic. To replace it with a
real external effect, that destination must provide its own atomic
deduplication contract; placing an HTTP send next to this SQLite transaction
would not make the remote effect exactly once. Retain the ledger for the
required event replay horizon and back up its volume using SQLite-aware
operations. Run checks with `npm --prefix services/destination test`.
