# @openfn/language-registry-breg

OpenFn operations over the native `breg` namespace in the exact published
`@registrystack/client@0.32.0`. The adaptor uses
`@openfn/language-common@3.3.4` and reexports its composition helpers.
It does not implement Registry authorization or an alternative HTTP client.

## Configuration and OpenFn state

Put the native SDK configuration in `state.configuration.breg`, or directly in
`state.configuration` for a standalone BREG job:

```json
{
  "breg": {
    "baseUrl": "https://registry.example.invalid/",
    "authorization": { "static": "REPLACE_WITH_BEARER_TOKEN" },
    "requestTimeoutMilliseconds": 30000,
    "maxResponseBytes": 4194304
  }
}
```

Alternatively use `authorization: { privateKeyJwt: { tokenEndpoint, clientId,
clientKey, audience } }`, where `clientKey` is a private JWK with `kty`, `kid`,
and `alg`. The current client also accepts `authorization: { exchange: ... }`
for an immutable context and reviewed first-party or remote assertion source;
the native provider performs the exchange and bounds its lifetime. Token and
Registry TLS trust roots and timeouts are independent.
The [configuration schema](./configuration-schema.json) lists the fields;
the native SDK validates supported algorithms, bounds and URLs. Keep keys and
tokens in OpenFn credentials, never event data or expressions.

Every operation returns a state function. Pass an options object, a function
returning options, or state functions as individual option values. Nested data
is plain JSON; use a function on `data`, `values`, or `operations` to build it.
Results appear at `state.data[as]`, defaulting to `state.data.breg`:

```js
{ branch: 'succeeded', value, etag, location, continuation, traceId }
```

Optional fields appear only when the SDK returned them. A read returns a Registry
Record envelope at `value`, lists return a collection, and lifecycle actions
return receipts. These remain different contracts. Successful metadata discovery
returns descriptive JSON, never opaque SDK authority handles.

Configuration remains present between operations so `execute`, `each`, and
successive requests can authenticate. The OpenFn runtime removes configuration
from final output by default, as exercised in the compiled-job test. Direct
JavaScript callers must remove it before logging or persisting the final state.
Record inputs and outputs remain in `data`; minimize and remove them explicitly
when the next step no longer needs them. The adaptor does not log requests.

## Operations

| Operation | Required inputs and behavior |
| --- | --- |
| `discoverRegistry` | Optional `accessProfile`; caller-filtered metadata. |
| `getEntitySchema` | `entityIdentifier`, optional `accessProfile`. |
| `getRecord` | `route`, `recordIdentifier`. |
| `lookupRecord` | `route`, `selector`; `values` for request selectors, omitted for verified-claim selectors. Exact lookup, no list scan fallback. |
| `listRecords` | `route`; optional `top`, `filter`, `orderby`, `count`. One page only. |
| `continueList` | Exact SDK `continuation` from the previous page. |
| `createRecord` | `operationIdentifier`, `accessProfile`, `data`, `idempotencyKey`. |
| `patchRecord` | `operationIdentifier`, `accessProfile`, `recordIdentifier`, `etag`, `operations`, `idempotencyKey`. |
| `createChangeRequest` | Same as create; use the configured change-request entity's create operation to create a draft. |
| `executeLifecycleAction` | `entityIdentifier`, `route`, `recordIdentifier`, `accessProfile`, `operation`, action `ifMatch`, `idempotencyKey`; `stage` for staged review. |

Reads and lookup accept `select`, `accessProfile`, and `format` (`json` or
`json-ld`). Lists also accept these. Creates, patches and lifecycle actions accept
`format`. Use the authored entity route, operation ID and field API names exactly
as published in metadata. Patch members use `{ op: 'replace', field: 'legalName',
value: '...' }`, not raw HTTP JSON Pointer paths. The native client constructs
and validates the HTTP patch document.

Writes fetch caller-filtered metadata inside the operation and select an opaque
binding for the exact operation and profile. No function accepts a write URL,
serialized binding, or arbitrary action URL as authority. Immediate-action
metadata remains descriptive; this adaptor does not execute it.

Use the direct read's exact strong ETag for patching. Lifecycle `ifMatch` is the
separate action-specific value in `value.data.request.actions`, never the record
ETag. The lifecycle helper refetches the contract and record, promotes actions
through the native client, and requires exactly one matching operation/stage and
the caller's held `ifMatch`. A changed proposal fails before any action POST.
Supported operation names are `submit_request`, `approve_request`,
`reject_request`, `request_revision`, `revise_request`, `cancel_request`, and
`apply_request`, subject to the current metadata, actor, stage and record state.

Create a governed correction with `createChangeRequest`, read the created request
with `getRecord` to obtain its current actions, then explicitly call
`executeLifecycleAction` with `operation: 'submit_request'`. Give each mutation
its own durable idempotency key derived from the source event and operation.
Creating a draft does not approve or submit it. Review and application remain
separate actor-authorized actions. See the [create and submit job](./jobs/create-and-submit.js)
and [read and patch job](./jobs/read-and-patch.js) for synthetic templates.

## Failures and recovery

Operations return `branch` values `invalid_request`, `auth_failed`, `denied`,
`not_found`, `conflict`, `retryable_infrastructure`, `protocol_failed`, or `failed`.
Failures include a safe `problem` with `code`, `retryable`, and optional HTTP
`status`. Typed native `code`, `planRefusal`, `traceId`, `transportKind`, and
`tokenKind` may be present at the result level. Exception messages, response
problem prose, credentials and record values are excluded from failure results.
Check the branch before consuming a value or starting a dependent mutation.

Neither the adaptor nor native SDK retries or follows redirects. Pagination is
explicit and bounded by server metadata. A temporary failure can leave a mutation
outcome unknown: replay the exact request with the same key and preconditions,
never invent a new key. Keep a durable source-event correlation. The lifecycle
helper refetches current state, so an already-completed action may no longer be
advertised; it then returns `denied`. Reconcile the request's current state and
source correlation before treating this as already submitted. Do not infer
success just from a missing action. Discard held metadata, ETags, continuations,
records and drafts when identity/profile changes; review drafts after registry
revision changes.

## Verification

```sh
npm test --workspace @openfn/language-registry-breg
npm run check --workspace @openfn/language-registry-breg
npm run pack:dry-run --workspace @openfn/language-registry-breg
```

The tests use the published native package against ephemeral synthetic HTTP
servers and compile/run a real OpenFn read-and-patch job. A small CommonJS bridge
copies bounded, plain JSON across the OpenFn VM boundary into the SDK realm;
opaque handles stay local. Tests cover native lookup/read/write/lifecycle HTTP
contracts, continuation, precondition refusal, failure redaction and runtime
credential removal. Private-key JWT configuration and token transport failure
are exercised; a successful live Mint exchange and real PostgreSQL governance
are integration checks outside these mock tests.
