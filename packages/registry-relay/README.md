# OpenFn Registry Relay Adaptor

OpenFn helpers for reading protected Registry Relay APIs from workflows.

Use this package when a workflow is authorized to read registry rows, metadata,
relationships, or aggregate outputs directly. Use
`@openfn/language-registry-evidence` when the workflow needs a signed trust
decision instead of the data.

When this repository is used as `OPENFN_ADAPTORS_REPO`, this package is loaded
as:

```text
@openfn/language-registry-relay@local
```

## Compatibility

The helpers here speak the Relay V1 route surface: `/v1/datasets`,
`/v1/datasets/{dataset}/entities/{entity}/records`, and `/metadata/...`. The
public Registry Stack lab still serves it.

Relay V2 is a different runtime with a different surface. It answers under
`/v2/resources/{resource}` with records, lookups, and searches, and its
capability inventory reports `evidence` among the families it does not support.
No helper in this package reaches a V2 deployment, and the evidence-offering
listing has no V2 successor: Registry Manifest publishes offerings there.

Relay sits outside the repository's 0.1.0 beta scope. The root `npm run check`
and `npm run pack:dry-run` cover the Evidence and BREG adaptors only; this
package's own tests run with `npm test` inside `packages/registry-relay`.

## Configure

Create an OpenFn credential with:

- `relay_base_url`: Registry Relay service base URL.
- `token`: bearer token or API key for the Relay caller credential.

The adaptor sends credentials as `Authorization: Bearer <token>`. It does not
send `x-api-key`.

The examples below use the public Registry Stack lab at
`https://lab.registrystack.org`. The lab publishes current credential metadata
at `https://lab.registrystack.org/api/lab.json`; use `agri-row-reader` for row
reads, `agri-aggregate-reader` for aggregate reads, `agri-metadata` for dataset
discovery, and `agri-evidence-only` for evidence offering discovery.

## Read One Record

```js
execute(
  getRecord({
    dataset: "agri_registry",
    entity: "farmer",
    id: dataValue("farmer_id"),
    purpose: "https://demo.example.gov/purpose/nagdi/climate-smart-input-support",
    fields: ["id", "district", "registration_status"],
    as: "farmer",
    redactDataPaths: ["farmer_id"],
  }),

  fn((state) => {
    const farmer = state.data.farmer.record;

    return {
      ...state,
      data: {
        ...state.data,
        decision_input: {
          farmer_id: farmer.id,
          district: farmer.district,
          relay_request_id: state.data.farmer.request_id,
        },
      },
    };
  }),
);
```

## List Records

Collection reads require an explicit `limit` and at least one filter unless
`allowUnfiltered: true` is set.

```js
execute(
  listRecords({
    dataset: "agri_registry",
    entity: "farmer",
    purpose: "https://demo.example.gov/purpose/nagdi/climate-smart-input-support",
    filters: {
      district: "north",
      "id.in": ["FARMER-1001", "FARMER-1002"],
    },
    fields: ["id", "district", "registration_status"],
    limit: 50,
    as: "farmers",
  }),
);
```

## Query An Aggregate

```js
execute(
  queryAggregate({
    dataset: "agri_registry",
    aggregate: "voucher_opportunities_by_district_crop_risk_input",
    purpose: "https://demo.example.gov/purpose/nagdi/program-monitoring",
    dimensions: ["district_code"],
    measures: ["eligible_opportunity_count"],
    filters: { season: ["2026A"] },
    maxRows: 100,
    as: "district_summary",
  }),

  fn((state) => {
    const observations = state.data.district_summary.observations;

    return {
      ...state,
      data: {
        ...state.data,
        north_voucher_opportunities:
          observations.find((row) => row.district_code === "north")?.eligible_opportunity_count ?? 0,
      },
    };
  }),
);
```

## Discovery

```js
execute(
  discoverDatasets({ as: "catalog" }),
  getEntitySchema({
    dataset: "agri_registry",
    entity: "farmer",
    as: "farmer_schema",
  }),
  listEvidenceOfferings({ as: "evidence_offerings" }),
);
```

`listEvidenceOfferings` reads the V1 `/metadata/evidence-offerings` route. Do
not carry it into work aimed at Relay V2.

## Result Branches

Every helper writes its result under `state.data[as]`. If `as` is omitted, the
default names are `record`, `records`, `relationship`, `aggregate`, `datasets`,
`entity_schema`, or `evidence_offerings`.

Common branches:

- `succeeded`
- `not_modified`
- `not_found`
- `auth_failed`
- `forbidden`
- `filter_required`
- `cursor_invalid`
- `retryable_infrastructure`
- `failed`

Problem Details are reduced to safe fields: `code`, `status`, `title`, and
`retryable`. The adaptor does not expose Problem Details `detail`.

## Guardrails

- Row, relationship, and aggregate helpers require `purpose`.
- `listRecords` requires `limit` and filters unless `allowUnfiltered: true`.
- Query values support OpenFn references such as `dataValue("farmer_id")`, plus
  `{ valueFrom: "farmer_id" }` for simple path-based lookup.
- `X-Request-Id` uses `state.data.request_id` when present.
- `traceparent` is forwarded when `state.data.traceparent` is present.
- `ETag`, `Retry-After`, request id, and pagination cursors are preserved.
- Credentials, raw request material, and `configuration` are removed from final
  state.

Relay is a protected consultation API. It does not evaluate trust decisions.
Use the Registry Evidence adaptor when a workflow needs a signed assertion
rather than the underlying rows.
