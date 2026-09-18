# Changelog

## Unreleased

### Added

- The event bridge accepts `BREG_BIND_HOST=127.0.0.1` for host-local receivers.
  Its existing `0.0.0.0` default remains unchanged.
- `@openfn/language-registry-casework` wraps the native Casework client for
  requester operations on hosted items and task operations on source inboxes
  and grants.
- `createCaseworkItem` in `@openfn/language-registry-casework` accepts an
  optional `resultConstraints` object keyed by the kind's result-schema field
  names and forwards it verbatim for server-side validation.
  `pollCaseworkResults` surfaces the structured `result` on completed items
  when the server returns one and stays valid when it does not. The pinned
  0.32.0 client cannot carry these fields yet (closed request and response
  types); constraints-in and result-out go live with the coordinated client
  release and pin bump, and until then a caller passing `resultConstraints`
  receives the client's own `invalid_request` before any HTTP request.

### Changed

- The Evidence, BREG and Casework adaptors pin `@registrystack/client` 0.32.0.
  The pilot's Registry Stack images and bootstrap tools remain at 0.27.0.

### Removed

- Removed the Relay v1 adaptor (`@openfn/language-registry-relay`), its
  credential schema, example job, tests and workspace dependencies. Workflows
  using that local adaptor must be updated before upgrading. No Relay v2
  replacement is included.

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
