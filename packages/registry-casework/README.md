# Registry Casework adaptor

This OpenFn adaptor wraps the maintained Registry Stack Casework Node client.
Requester operations create and read the caller's own hosted items, add and
read notes, cancel an item, and poll the caller's terminal feed.

Task operations read the source inbox and current item, inspect grant templates
and grants, and explicitly approve or revoke a grant. They do not claim,
release, or decide a human work item or issue a task assertion into workflow
state. Casework enforces ownership and authorization from the token identity,
configured profile, and source profile. Workflow data cannot choose a token or
Casework profile.

## Client packaging

This package pins `@registrystack/client` to **0.32.0** and uses its `casework`
namespace. The pinned client cannot yet carry `resultConstraints` on create or
`result` on terminal items: its request and response types are closed.
Constraints-in and result-out go live with the coordinated client release and
pin bump; until then a caller passing `resultConstraints` receives the client's
own `invalid_request` before any HTTP request is made. This adaptor has not
been published.

## Configuration

Store the credential in OpenFn configuration:

```json
{
  "casework": {
    "baseUrl": "https://casework.example.test/tenant",
    "token": "<requester bearer token>",
    "profile": "requester"
  }
}
```

For a refreshing service credential, replace `token` with
`authorization: { privateKeyJwt: { tokenEndpoint, clientId, clientKey, resource,
scopes } }`. The adaptor uses the native Registry client token provider to
obtain a bearer token for each operation. Configure exactly one source.
Task-grant approval requires actor authorization and is never inferred from
a service credential.

`requestTimeoutMilliseconds`, `connectTimeoutMilliseconds`,
`maxResponseBytes`, `userAgent`, and `trustedRootCertificates` pass to the
maintained client. The token and profile never enter operation output. OpenFn
keeps configuration available during a composed job and removes it from final
job output.

## Operations

- `createCaseworkItem` requires `kind`, `requesterReference`, `display`, and an
  explicit `idempotencyKey`. An optional `resultConstraints` object narrows the
  kind's result schema for the item: it is keyed by the schema's top-level field
  names, forwarded verbatim, and validated server-side against the kind's
  declared schema. The server, not the adaptor, rejects unknown fields or
  values outside the schema.
- `getCaseworkItem` requires `itemId`.
- `addCaseworkNote` requires `itemId`, `expectedRevision`, `note`, and an
  explicit `idempotencyKey`.
- `listCaseworkNotes` requires `itemId`; `cursor` and `limit` are optional.
- `cancelCaseworkItem` requires `itemId`, `expectedRevision`, `reason`, and an
  explicit `idempotencyKey`.
- `pollCaseworkResults` accepts an optional `cursor` and `limit`. A completed
  item may carry a structured `result` decided by the person; it is absent when
  the kind declares no result schema or the person submitted none, and the poll
  stays valid either way.
- `listCaseworkWorkItems` requires `sourceProfile` and an exact `query` with
  `view`; `getCaseworkWorkItem`, `previewCaseworkTaskTemplates`, and
  `listCaseworkTaskGrants` require `sourceProfile` and `itemId`.
- `approveCaseworkTaskGrant` additionally requires `expectedRevision`,
  `templateId`, `templateVersion`, and a stable `idempotencyKey`.
  `revokeCaseworkTaskGrant` requires `grantId`; `caseworkTaskGrantStatus`
  accepts `grantId` without a source profile.

Each operation makes one maintained-client call and writes a result under its
default key or the bounded `as` name. A success has
`{ branch: "succeeded", value, traceId? }`. Typed failures contain only bounded
diagnostics. Response detail, SDK messages, credentials, configuration, and
caller inputs are not copied into the result.

Idempotency conflicts are returned as `branch: "conflict"`; the adaptor never
generates a replacement key or retries silently. Keep each key with the logical
create, note, or cancellation until its outcome is resolved.

## Cursor expiry

A typed `cursor.expired` response returns `branch: "cursor_expired"` without a
retry. The result identifies the explicit recovery:

```json
{
  "recovery": {
    "action": "restart_without_cursor",
    "deduplicateBy": "eventId"
  }
}
```

Restart the terminal poll without `cursor`, then deduplicate against persisted
`eventId` values. Notes use `noteId` instead. Poll within the configured
terminal retention period; an expired item is no longer available.

## Example

```js
import { execute } from "@openfn/language-common";
import { createCaseworkItem, pollCaseworkResults } from "@openfn/language-registry-casework";

execute(
  createCaseworkItem((state) => ({
    kind: state.data.caseworkKind,
    requesterReference: state.data.requestReference,
    display: state.data.caseworkDisplay,
    resultConstraints: state.data.resultConstraints,
    idempotencyKey: state.data.createKey,
    as: "createdCasework",
  })),
  pollCaseworkResults({ limit: 25, as: "terminalResults" }),
);
```

With a kind that declares a `batchStatus` result, the constraints could be
`{ batchStatus: { oneOf: [{ const: "valid" }, { const: "partial" }] } }`, and a
completed terminal item then reads
`terminalResults.value.items[0].result` as e.g.
`{ batchStatus: "partial" }`.

## Verification

The package check uses fake bindings and the real native client over a local
HTTP fixture:

```sh
npm run check --workspace @openfn/language-registry-casework
```

The two-adaptor CLI fixture under `test/multi-adaptor-job.js` runs with repeated
`-a @openfn/language-registry-evidence@local=/absolute/path/to/registry-evidence`
and `-a @openfn/language-registry-casework@local=/absolute/path/to/registry-casework`.
It imports `execute` from Evidence's reexport of OpenFn common, so a third
common adaptor alias is unnecessary.
