# Synthetic agricultural holding pilot

This project adapts the maintained Registry Stack agricultural-holdings core
starter. It retains its Farm, holder, responsibility and reviewed name-correction
model, including the original PublicSchema attribution. All supplied names,
identifiers, inputs and identities are synthetic.

The complete deployment and OpenFn workflows are described in the repository
README. `prepare.py --bin-dir <Registry Stack 0.27.0 binaries>` creates an ignored,
owner-only `.runtime` directory. It needs Python 3 with PyYAML and OpenSSL.
Preparation generates fresh keys, fixed service bindings, separate database roles,
a direct BREG source export, a compiled Evidence bundle and a native client
profile. It executes eight Evidence fixtures before producing the deployment.
It does not connect to a database or start services. Existing output is refused;
normal restart reuses it and retains records and credentials.

`initialize.py` runs inside the deployment tools container after the pilot Mint
and PostgreSQL are ready. It uses `bregctl test`, `package`, `apply --initial`, and
`verify`. The schema test database is separate from the pilot record database.
It never resets an existing database or clears a migration interlock. An
interrupted activation needs the maintained BREG recovery procedure.

## Authority and disclosure

- `openfn-service` creates farms, resolves their unique `localIdentifier`, and
  creates/submits its own corrections. It has no review, application, direct farm
  patch, collection listing, or holder maintenance authority.
- The separate `reviewer` principal can inspect, approve and explicitly apply a
  proposed correction. `excludeSubmitter: true` and manual application remain
  authored BREG requirements. OpenFn receives no reviewer private key.
- `evidence-source` can only perform an exact Farm lookup returning
  `localIdentifier`. It cannot read names, list records or write.
- `holding-registered` signs one Boolean concept. It means a unique holding is
  currently resolved in this synthetic register. It makes no claim about subsidy
  eligibility, land rights, activity, ownership or an individual's identity.
  A missing holding produces `evidence.unavailable`, never signed `false`.
- Committed Farm create/patch events project only `local-identifier`. A correction
  proposal or approval does not produce a Farm patch event. Delivery uses the
  existing transactional outbox and HMAC contract.

The inherited reader/editor/reviewer registry-wide collection and history grants
remain intentional learning profiles. Production deployments must review their
population scope. The two integration profiles deliberately permit any exact
synthetic Farm identifier, so caller filters are never treated as authorization.

## Explicit reviewer steps

Copy the correction request UUID from the registration/correction workflow result.
Run these commands through the deployment's tools service, which has the private
reviewer credential. `inspect` prints the synthetic before/after proposal and saves
that exact response. An approval or application uses its advertised action,
proposal version, effect digest and lifecycle ETag. Stale snapshots are refused.

```sh
deployment/compose.sh run --rm tools \
  python3 /opt/pilot/agriculture/review.py inspect REQUEST_UUID
deployment/compose.sh run --rm tools \
  python3 /opt/pilot/agriculture/review.py approve REQUEST_UUID
# Approval leaves the authoritative Farm unchanged. Inspect the approved request.
deployment/compose.sh run --rm tools \
  python3 /opt/pilot/agriculture/review.py inspect REQUEST_UUID
deployment/compose.sh run --rm tools \
  python3 /opt/pilot/agriculture/review.py apply REQUEST_UUID
```

The supplied `inputs/registration.json` and `inputs/correction.json` use stable
submission identifiers for replay-safe workflow keys. Change both the submission
identifier and local holding identifier for another synthetic registration.
Repeating a correction with changed content requires a new submission identifier.

## Native verification

The retained starter journey checks typed holder relationships and dates, and the
reviewed correction lifecycle. The integration journey exercises the new service
creation and both authorized exact lookups. The real HTTP smoke separately proves
refusal of direct farm patch and Evidence-source creation, source name exclusion,
reviewer approval without mutation, explicit application, a cryptographically
verified registered assertion, and missing-record unavailability:

```sh
deployment/compose.sh run --rm tools \
  python3 /opt/pilot/agriculture/smoke.py
```

The smoke uses `SYNTHETIC-DIRECT-SMOKE-001`, separate from the workflow input farm.
It retains that synthetic record and privately stores request verification contexts
under `.runtime/breg/smoke`. Repeated smoke runs create fresh synthetic correction
proposals. They do not reset a database. Its committed events can reach the pilot
workflow once the event bridge is enabled.
