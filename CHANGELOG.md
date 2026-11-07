# Changelog

## Unreleased

### Added

- The event bridge accepts `BREG_BIND_HOST=127.0.0.1` for host-local receivers.
  Its existing `0.0.0.0` default remains unchanged.
- `@openfn/language-registry-casework` wraps the native Casework client for
  requester review requests and results, source inboxes and task grants.

### Changed

- The Evidence, BREG and Casework adaptors pin the published
  `@registrystack/client` 0.45.0. Configuration uses `attemptTimeoutMilliseconds`
  and `maximumResponseBytes`; the client's error kinds are kebab-case, and the
  adaptors' safe validation reasons follow them.
- Casework uses the review task routes: `listCaseworkReviewTasks`,
  `getCaseworkReviewTask`, `previewCaseworkTaskTemplates`,
  `listCaseworkTaskGrants`, `approveCaseworkTaskGrant`,
  `revokeCaseworkTaskGrant` and `caseworkTaskGrantStatus`. Inputs name a
  `taskId` instead of an `itemId`.
- BREG reads record types (`recordTypes`, `recordTypeIdentifier`); `getEntitySchema`
  is now `getRecordSchema` and takes `recordTypeIdentifier`. Failures report
  `refusalCode` and `reasonCode` in place of `planRefusal`.
- Evidence profile files use the `EvidenceClientProfile` envelope, expected
  output forms are mappings such as `{ type: "boolean" }`, and the progressive
  request names its requirement as `handle`.
- The event bridge's explicit `hook-envelope-v1` mode validates canonical
  0.38 events and returns the native notification acknowledgement after
  durable OpenFn acceptance. The legacy body mode remains available.

### Removed

- Removed the Relay adaptor (`@openfn/language-registry-relay`): the 0.45 client
  has no Relay namespace.
- Removed the Casework adaptor operations `listCaseworkWorkItems` and
  `getCaseworkWorkItem`; the review task operations replace them.
- Removed the BREG operations `createChangeRequest` and `executeLifecycleAction`,
  and the `jobs/create-and-submit.js` example. The 0.45 client replaces the
  change-request lifecycle with metadata-declared Actions and Proposals, which
  this adaptor does not wrap yet.
- Removed the `correction` workflow from the generated pilot Lightning project,
  which depended on those BREG operations. The container pilot itself is still
  pinned to Registry Stack 0.38.0 server images and has not been repinned.

## 0.1.0 Beta

First self-hosted Evidence and BREG agricultural-holdings pilot.

- Separate OpenFn adaptors use the maintained Registry Stack 0.27.0 client.
- Registration uses explicit idempotency. Corrections follow governed change
  requests with separate reviewer approval and manual application.
- Committed events pass through an authenticated bridge, request verified signed
  registration evidence, and produce atomic, deduplicated destination updates.
- Pinned upstream Lightning and worker packaging, Compose setup, repeatable
  workflow provisioning, and operator recovery commands are included.
- Linux acceptance covers fresh installation, the complete workflow journey,
  restart recovery, failed delivery, failed workflow steps and queued work.

### Release scope

This is a source release for supervised synthetic pilots. Setup builds the
containers locally from the committed dependency locks and pinned images.
The worker requires Linux amd64; native adaptor imports also support Linux
arm64. The assertion confirms registration only, without disclosing the holding
name or establishing ownership or programme eligibility.

Relay, legacy Notary, hosted OpenFn, wallet issuance, npm publication and OpenFn
catalogue acceptance are outside this beta. Root dependency overrides apply to
the locked source deployment and do not accompany independently installed npm
packages.

Stop/start preserves data; reset is a separate explicit destructive operation.
See the [operator guide](README.md) for private inputs, retention and recovery.
