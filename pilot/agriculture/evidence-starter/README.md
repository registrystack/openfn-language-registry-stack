# Agriculture Evidence project

Registry Stack v0.45 compiles this project from `evidence.yaml`. The active
deployment inputs are `production-target.yaml` and `production-authority.yaml`.
The project embeds the generated `adapter-packs/holding-register` source pack,
uses `functions/derive-holding-registered.rhai`, and verifies behavior with
`fixtures/holding-registered.yaml`.

The following pre-v0.45 paths remain tracked only to preserve the existing
checkout during this migration. They are not referenced by `evidence.yaml` or
the active production target, and the v0.45 compiler ignores them:

- `questions/`
- `derivations/`
- `targets/production/`

Run the v0.45 authoring checks against the root project and target:

```console
evidencectl target new /config/evidence/target --settings production-target.yaml
evidencectl check . --target /config/evidence/target --production --format json
evidencectl test . --target /config/evidence/target --format json
```
