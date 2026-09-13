# OpenFn Registry Evidence Adaptor

OpenFn helpers for requesting and verifying minimized, signed Registry Stack
Evidence assertions with Registry Stack's own relying-party client.

When this repository is used as `OPENFN_ADAPTORS_REPO`, this package is loaded
as:

```text
@openfn/language-registry-evidence@local
```

## Client packaging

This package pins `@registrystack/client` to **0.32.0** and uses its `evidence`
namespace. Supported native targets are macOS arm64, Linux amd64 glibc, and
Linux arm64 glibc. Alpine/musl is unsupported. Use a glibc OpenFn worker image.

The upstream client is a Node-API native binding around the Rust Evidence
client and verifier. It is not a WebAssembly build. It owns request preparation,
fresh nonce generation, HTTP transport, response bounds, pinned-key trust,
revocation, signature verification, time checks, and policy comparison. This
adaptor only resolves OpenFn inputs, maps typed client failures to workflow
branches, redacts selectors and credentials, and shapes the verified result.

## Configure

Use `configuration.evidence` with the SDK's current configuration:

```json
{
  "evidence": {
    "baseUrl": "https://evidence.example.gov",
    "trustedJwks": { "keys": [] },
    "revokedKeyIds": [],
    "token": { "static": "<requester access token>" }
  }
}
```

Populate `trustedJwks.keys` with reviewed signing keys before use. For a
private-key-JWT client-credentials exchange, replace `token` with:

```json
{
  "privateKeyJwt": {
    "tokenEndpoint": "https://issuer.example.gov/token",
    "clientId": "openfn-pilot",
    "clientKey": { "kty": "EC", "crv": "P-256", "kid": "<registered kid>", "x": "<x>", "y": "<y>", "d": "<private component>" }
  }
}
```

Store private material in the OpenFn credential, never job source or state.data.
The native SDK validates the key, performs the exchange, and owns token caching.
Optional SDK timeout, response-bound, and private-CA fields pass through intact.
Exactly one token source is allowed. Existing flat credentials
(`evidence_base_url`, `token`, `evidence_verification_jwks`,
`evidence_revoked_key_ids`, plus optional `evidence_trusted_root_certificates`
and `evidence_max_response_bytes`) remain a legacy shorthand. Do not combine
flat fields with `evidence`.

The JWKS and revocation list are relying-party trust configuration. Verification
does not fetch keys from the Evidence service and never follows a key URL from
a response.

## Request one assertion

```js
execute(
  requestEvidence({
    requirement: "urn:example:requirement:adult-status:v1",
    purpose: "benefit-eligibility",
    audience: "urn:example:agency:benefits",
    evidenceType: "urn:example:evidence-type:adult-status:v1",
    issuedBy: "urn:example:authority:population-registry",
    providedBy: "urn:example:data-service:evidence",
    configurationRevision: "sha256:<reviewed bundle revision>",
    expectedAssuranceProfile: "production",
    subjects: [
      {
        role: "subject",
        selectorProfile: "civil-record-v1",
        selectorValues: { record_reference: { valueFrom: "person_id" } },
      },
    ],
    expectedOutputs: [
      { concept: "urn:example:concept:adult-status", form: "boolean" },
    ],
    maximumAssertionLifetimeSeconds: 300,
    clockSkewSeconds: 30,
    subjectExpectations: {
      pinned: [
        { role: "subject", binding: "urn:evidence:subject:v1_<known binding>" },
      ],
    },
  }),
);
```

Use `subjectExpectations: "acceptFirstUse"` only for first contact. It verifies
every expectation except prior subject identity, returns
`pinned_subject_expectations`, and requires the workflow to persist and pin
those bindings on later requests. Only pinned expectations prove that a later
assertion concerns the previously accepted subject.

Selector values referenced with `{ valueFrom: "..." }` are removed from returned
data, including failed operations. For function-resolved inputs, name protected
data paths explicitly in `redactDataPaths`. Configuration remains available to
subsequent operations inside the same OpenFn job. The runtime removes it at the
job output boundary on success and failure. Direct callers must apply an
equivalent boundary before persisting a returned state; do not override the
runtime's default configuration removal. Native clients and prepared requests
remain local variables, never workflow data.

On success, `state.data.evidence` contains the verified `assertion`, the exact
flattened `jws` bytes for retention, the support correlation `trace_id`, the accepted
subject bindings, and explicit successful verification flags. Use
`selectSupportedValue(assertion, concept)` to select one value by its governed
concept identifier.

## Progressive request and continuity receipts

For the SDK's progressive API, mount a reviewed
`registry.evidence-client-profile/v1` JSON profile into the worker and configure:

```json
{ "evidence": { "profilePath": "/run/evidence/client.json" } }
```

The profile owns service expectations, verification policy, metadata trust,
contracts, and a private-key reference. Alternatively supply `privateKeyJwk`
alongside `profilePath` from the OpenFn credential. Profile mode uses the native
`EvidenceClient.fromProfile` API and cannot be combined with explicit SDK config.

```js
execute(requestEvidence({
  requirement: "adult-status",
  selectors: { record_reference: { valueFrom: "person_id" } },
  // Omit bindingReceipt only on first contact.
  bindingReceipt: state => state.data.previous_receipt,
}));
```

A verified result includes `subject_continuity: { status, receipt }` with status
`firstUse` or `matched`. Persist the opaque receipt and pass it on the next call.
The native SDK validates receipt scope and subject continuity. Profile mode
accepts `requirement`, `selectors` or role-mapped `subjects`, and `bindingReceipt`;
full explicit policy fields belong to the explicit API above. The reviewed
profile closes definition-specific expectations before sending. Both modes
request signed JWS only, retain its exact bytes, and publish no native handles.
Progressive success also returns `retained_verification` as base64 of the native
verification snapshot; persist it with the signed bytes when audit retention
is required. A profile can use `authorization: { exchange: ... }` instead of
`privateKeyJwk`. The native client's remote exchange source binds the Casework
grant assertion and exchanges it without placing a short-lived assertion in
workflow data.

## Failure branches

Typed API and transport failures return one of these workflow branches without
reflecting response details or selector data:

- `invalid_request`
- `authentication_failed`
- `not_authorized`
- `response_format_not_acceptable`
- `evidence_not_available`
- `retryable_infrastructure`
- `failed`

Configuration, nonce, signature, trust, contract, policy, and time failures
throw `EvidenceCallerError` and publish no assertion. There is no unsigned
fallback and no hidden retries. Each operation sends at most one Evidence request.
A signed supported value of `false` is successful evidence;
`evidence_not_available` carries no assertion and must never be coerced to false.

## Verification

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

Node.js 22.12.0 or newer is required by the upstream native binding.
