# @openfn/language-registry-breg

OpenFn operations over the native `breg` namespace in the exact published
`@registrystack/client@0.45.0`. The adaptor uses
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
    "attemptTimeoutMilliseconds": 30000,
    "maximumResponseBytes": 4194304
  }
}
```

The authored `breg` namespace is closed, so retired spellings such as
`maxResponseBytes` and `requestTimeoutMilliseconds`, and other unknown fields,
are refused by the configuration contract.

Alternatively use `authorization: { privateKeyJwt: { tokenEndpoint, clientId,
clientKey, audience } }`, where `clientKey` is a private JWK with `kty`, `kid`,
and `alg`. The client also accepts `authorization: { exchange: ... }` for an
immutable context and reviewed first-party or remote assertion source; the
native provider performs the exchange and bounds its lifetime. Token and
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
Record envelope at `value`, and lists return a collection. These remain different contracts. Successful metadata discovery
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
| `getRecordSchema` | `recordTypeIdentifier`, optional `accessProfile`. |
| `getRecord` | `route`, `recordIdentifier`. |
| `lookupRecord` | `route`, `selector`; `values` for request selectors, omitted for verified-claim selectors. Exact lookup, no list scan fallback. |
| `listRecords` | `route`; optional `top`, `filter`, `orderby`, `count`. One page only. |
| `continueList` | Exact SDK `continuation` from the previous page. |
| `createRecord` | `operationIdentifier`, `accessProfile`, `data`, `idempotencyKey`. |
| `patchRecord` | `operationIdentifier`, `accessProfile`, `recordIdentifier`, `etag`, `operations`, `idempotencyKey`. |
| `startProposal` | `actionIdentifier`, `accessProfile`, `inputs`, `idempotencyKey`. Selects a declared Action and starts its native Proposal. |
| `getProposal` | `proposalIdentifier`, `accessProfile`. Reads through the selected Proposal Get authority. |
| `submitProposal` | `proposalIdentifier`, `accessProfile`, `expectedInputs`, `idempotencyKey`. Rereads the Proposal, requires exact input equality, and submits an available Draft through its native link and condition. |

Reads and lookup accept `select`, `accessProfile`, and `format` (`json` or
`json-ld`). Lists also accept these. Creates and patches accept
`format`. Use the authored record-type route, operation ID and field API names exactly
as published in metadata. Patch members use `{ op: 'replace', field: 'legalName',
value: '...' }`, not raw HTTP JSON Pointer paths. The native client constructs
and validates the HTTP patch document.

Writes fetch caller-filtered metadata inside the operation and select an opaque
binding for the exact operation and profile. No function accepts a write URL,
serialized binding, or arbitrary action URL as authority. Action and
Proposal metadata remains descriptive outside the native client.

Use the direct read's exact strong ETag for patching. Proposal operations return
inert JSON, without an SDK handle or transition links. `submitProposal` returns
`already_submitted` when the matching Proposal was already submitted, applied,
or rejected; it sends no second transition. A changed input returns `conflict`.
Review and Apply remain separate authorities. See the [read and patch
job](./jobs/read-and-patch.js) and the [pilot correction
workflow](../../pilot/lightning/project.mjs) for synthetic examples.

## Failures and recovery

Operations return `branch` values `invalid_request`, `auth_failed`, `denied`,
`not_found`, `conflict`, `retryable_infrastructure`, `protocol_failed`, or `failed`.
Proposal submission can also return `already_submitted` for an inert exact replay.
Failures include a safe `problem` with `code`, `retryable`, and optional HTTP
`status`. Typed native `code`, `refusalCode`, `reasonCode`, `traceId`, `transportKind`, and
`tokenKind` may be present at the result level. Exception messages, response
problem prose, credentials and record values are excluded from failure results.
Check the branch before consuming a value or starting a dependent mutation.

Neither the adaptor nor native SDK retries or follows redirects. Pagination is
explicit and bounded by server metadata. A temporary failure can leave a mutation
outcome unknown: replay the exact request with the same key and preconditions,
never invent a new key. Keep a durable source-event correlation. Discard held metadata, ETags, continuations,
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
opaque handles stay local. Tests cover native lookup/read/write HTTP
contracts, continuation, precondition refusal, failure redaction and runtime
credential removal. Private-key JWT configuration and token transport failure
are exercised; a successful live OAuth exchange and real PostgreSQL governance
are integration checks outside these mock tests.
