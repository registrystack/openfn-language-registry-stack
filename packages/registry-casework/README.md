# Registry Casework Requester adaptor

This OpenFn adaptor wraps the Requester review API in the published
Registry Stack Node client 0.38.0. It creates or recovers review requests,
reads request state and correlated results, adds requester-visible notes, pages
requester-visible history and result feeds, and cancels an accepted request.
It also preserves the maintained source-inbox and task-grant inspection surface
for workflows that use a separately authorized source profile.

It exports no claim, release, decision, task-assertion, staff, supervisor,
administrator, or accountability operation. Casework binds every request to
the authenticated producer and configured Casework profile. Workflow data
cannot choose a token or Casework profile.

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
scopes } }`. Configure exactly one credential source. The adaptor validates the
operation before asking the native provider for a token.

`requestTimeoutMilliseconds`, `connectTimeoutMilliseconds`,
`maximumResponseBytes`, `userAgent`, and `trustedRootCertificates` pass to the
maintained client. Put Casework settings under `configuration.casework`; unknown
fields in that namespace fail before client construction. Other configuration
namespaces remain available to other adaptors. The 0.38 client uses the shorter
`maxResponseBytes` spelling internally, which this adaptor maps at its boundary.
The token and profile never enter operation output. OpenFn
keeps configuration available during a composed job and removes it from final
job output.

## Requester operations

- `createOrRecoverReviewRequest` requires the complete native `request`, an
  independently computed `expectedSubmissionDigest`, and the caller's stable
  `idempotencyKey`. The adaptor does not derive a subject, convert display data
  into review context, or calculate a digest.
- `getReviewRequest` requires `requestId`.
- `getReviewResult` requires the complete accepted binding returned by create.
- `listReviewResults` accepts optional `cursor` and `limit`. Feed entries are
  completion signals. Retrieve the result using the matching accepted binding.
- `addReviewNote` requires `requestId`, a stable `idempotencyKey`, and `note`.
  The adaptor pins the note audience to `requester`.
- `listReviewHistory` requires `requestId`; `cursor` and `limit` are optional.
- `cancelReviewRequest` requires the complete accepted binding, a stable
  `idempotencyKey`, and the exact native `cancellation` object containing the
  same subject binding and a reason.

Create and cancel each make one maintained-client call. The adaptor never
generates an idempotency key, retries a mutation, replaces a digest, or rebuilds
an accepted binding.

## Source inbox and task-grant operations

- `listCaseworkWorkItems` requires `sourceProfile` and an exact native `query`.
- `getCaseworkWorkItem`, `previewCaseworkTaskTemplates`, and
  `listCaseworkTaskGrants` require `sourceProfile` and `itemId`.
- `approveCaseworkTaskGrant` also requires the held `expectedRevision`, a
  caller-owned `idempotencyKey`, `templateId`, and `templateVersion`.
- `revokeCaseworkTaskGrant` requires `sourceProfile`, `itemId`, and `grantId`.
- `caseworkTaskGrantStatus` requires `grantId`.

The adaptor passes source authority, revisions, and keys to the native client
unchanged. It never issues a task assertion into workflow state.

A normal response has `{ branch: "succeeded", value, traceId? }`. Result lookup
instead preserves the native state as `available`, `pending`,
`concealed_or_unknown`, or `expired`; only `available` carries a result value.
Typed failures contain bounded diagnostics. Response detail, SDK messages,
credentials, configuration, and caller inputs are not copied into the result.

## Request body

The create request follows the native 0.38.0 contract. For submitted context:

```json
{
  "kind": "decision",
  "subject": {
    "source": "payments",
    "type": "batch",
    "id": "batch-0042",
    "version": "7",
    "digest": "sha256:<64 lowercase hex characters>"
  },
  "requesterReference": "batch-0042",
  "context": {
    "strategy": "submitted",
    "snapshot": {
      "summary": "Review batch 42"
    }
  }
}
```

The service returns an accepted binding containing `requestId`, the immutable
subject, the pinned policy, and `submissionDigest`. Persist that object intact
for result lookup, cancellation, and recovery.

## Cursor expiry

A typed `cursor.expired` response returns `branch: "cursor_expired"` without a
retry. Restart without a cursor and deduplicate against persisted `eventId`
values. Poll inside the configured retention period.

## Example

```js
import { execute } from "@openfn/language-common";
import {
  createOrRecoverReviewRequest,
  listReviewResults,
} from "@openfn/language-registry-casework";

execute(
  createOrRecoverReviewRequest((state) => ({
    request: state.data.reviewRequest,
    expectedSubmissionDigest: state.data.submissionDigest,
    idempotencyKey: state.data.createKey,
    as: "accepted",
  })),
  listReviewResults({ limit: 25, as: "completedReviews" }),
);
```

## Verification

The package check exercises fake bindings and the installed 0.38.0 native
client against a loopback HTTP service:

```sh
npm run check --workspace @openfn/language-registry-casework
```

For a deployed service, pass configuration plus the complete request,
submission digest, cancellation, and three caller-owned idempotency keys on
standard input. The smoke script prints only a success summary:

```sh
node packages/registry-casework/scripts/live-smoke.mjs < smoke-input.json
```
