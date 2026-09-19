# Registry Casework adaptor

This OpenFn adaptor wraps the maintained Registry Stack Casework Node client.
Requester operations create or recover unified review requests, read request
state, retrieve a correlated result, add requester or reviewer notes, read
history, cancel a request, and poll the requester's result feed. It does not use
the removed hosted-item endpoints.

Source-task operations continue to read the source inbox and current item,
inspect grant templates and grants, and explicitly approve or revoke a grant.
They do not claim, release, or decide a human work item or issue a task assertion
into workflow state. Casework derives identity and profile authority from the
credential and configured profiles. Workflow data cannot choose a token or
Casework profile.

## Client packaging

This package pins `@registrystack/client` to **0.32.0** and uses its `casework`
namespace. The adaptor's unit boundary tests exercise the coordinated unified
contract. Native HTTP tests become active when the installed client package
contains that contract; an older published 0.32.0 package is reported as an
explicit skip rather than falling back to hosted endpoints.

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
scopes } }`. Configure exactly one credential source. Task-grant approval
requires actor authorization and is never inferred from a service credential.

`requestTimeoutMilliseconds`, `connectTimeoutMilliseconds`,
`maxResponseBytes`, `userAgent`, and `trustedRootCertificates` pass to the
maintained client. Credentials and profiles never enter operation output.

## Requester operations

- `createCaseworkRequest` requires the closed `request`, its independently
  computed `expectedSubmissionDigest`, and a stable `idempotencyKey`. Preserve
  the returned accepted binding for later result lookup and recovery.
- `getCaseworkRequest` requires `requestId`.
- `getCaseworkResult` requires the complete accepted binding returned by create.
  It distinguishes `pending`, `concealed_or_unknown`, and `expired` from a
  successful available result.
- `addCaseworkNote` requires `requestId`, audience `requester` or `reviewers`,
  `note`, and a stable `idempotencyKey`.
- `listCaseworkHistory` requires `requestId`; `cursor` and `limit` are optional.
- `cancelCaseworkRequest` requires `requestId`, its exact frozen `subject`, a
  `reason`, and a stable `idempotencyKey`.
- `pollCaseworkResults` accepts optional `cursor` and `limit`. Feed entries are
  completion signals, not result payloads. Use the matching persisted accepted
  binding with `getCaseworkResult` to retrieve and verify the result.

Each operation makes one maintained-client call. A normal success has
`{ branch: "succeeded", value, traceId? }`. Typed failures contain only bounded
diagnostics. Response detail, SDK messages, credentials, configuration, and
caller inputs are not copied into workflow data. The adaptor does not retry
mutations or replace caller idempotency keys.

## Cursor expiry

A typed `cursor.expired` response returns `branch: "cursor_expired"` with an
explicit recovery instruction to restart without a cursor and deduplicate using
persisted `eventId` values. Poll within the configured result-feed retention
period.

## Example

```js
import { execute } from "@openfn/language-common";
import {
  createCaseworkRequest,
  pollCaseworkResults,
} from "@openfn/language-registry-casework";

execute(
  createCaseworkRequest((state) => ({
    request: state.data.caseworkRequest,
    expectedSubmissionDigest: state.data.caseworkSubmissionDigest,
    idempotencyKey: state.data.createKey,
    as: "createdCasework",
  })),
  pollCaseworkResults({ limit: 25, as: "completedReviews" }),
);
```

## Verification

```sh
npm run check --workspace @openfn/language-registry-casework
```

The two-adaptor CLI fixture under `test/multi-adaptor-job.js` runs with local
Evidence and Casework adaptor aliases. It imports `execute` from Evidence's
reexport of OpenFn common, so a third common adaptor alias is unnecessary.
