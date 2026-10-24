# OpenFn Registry Relay Adaptor

OpenFn operations for Registry Relay 0.38.0. The adaptor uses the published
`@registrystack/client` Relay namespace, so route construction, continuations,
response validation, authentication, and protocol failures follow the maintained
Relay V2 client contract.

Use Registry Relay for governed read-only publication. Use
`@openfn/language-registry-evidence` when a workflow needs a minimized, signed
assertion about a governed requirement.

## Configure

Create an OpenFn credential with:

- `relay_base_url`: the Relay service base URL, including any deployment prefix.
- `token`: a bearer access token whose verified claims select the permitted
  purpose, scopes, and access profile.

Existing credentials may keep `relay_token` as an alias for `token`.

The adaptor also accepts the native client configuration under
`configuration.relay`. That form supports the client's static,
`privateKeyJwt`, and exchange authorization modes. Do not combine it with the
two legacy top-level fields.

```json
{
  "relay": {
    "baseUrl": "https://relay.example.gov",
    "authorization": { "static": "<bearer token>" },
    "maximumResponseBytes": 4194304
  }
}
```

The adaptor maps `maximumResponseBytes` to the pinned 0.38 client's internal
`maxResponseBytes` field. The `relay` namespace is closed, so the old spelling
and other unknown fields are refused by the configuration contract.

## Read one record

```js
execute(
  getRecord({
    resource: "farmers",
    recordIdentifier: dataValue("farmer_id"),
    accessProfile: "programme-reader",
    fields: ["district", "registrationStatus"],
    as: "farmer",
    redactDataPaths: ["farmer_id"],
  }),
  fn((state) => {
    const record = state.data.farmer.value.data;
    return {
      ...state,
      data: {
        ...state.data,
        district: record.domainData.district,
      },
    };
  }),
);
```

`getRecord` accepts `resource`, `recordIdentifier`, optional `fields`,
`accessProfile`, `format`, and `etag`.

## List and continue records

```js
execute(
  listRecords({
    resource: "farmers",
    accessProfile: "programme-reader",
    fields: ["district", "registrationStatus"],
    filters: { district: "north" },
    pageSize: 50,
    as: "farmer_page",
  }),
  continueList((state) => ({
    continuation: state.data.farmer_page.continuation,
    as: "next_farmer_page",
  })),
);
```

Continuations are opaque client values. Pass the complete returned object to
`continueList` or `continueResources`; do not copy its cursor into a new first
page request.

## Lookup a record

```js
lookupRecord({
  resource: "farmers",
  lookup: "by-local-identifier",
  selectors: { localIdentifier: dataValue("local_identifier") },
  accessProfile: "programme-reader",
  as: "farmer",
});
```

Lookup selector values are strings, booleans, or safe integers. The governed
lookup name and selector members must match the compiled Relay resource.

## Metadata

```js
execute(
  getServiceMetadata({ as: "service" }),
  listResources({ pageSize: 50, as: "resources" }),
  getResource({ resource: "farmers", as: "farmer_resource" }),
);
```

Service metadata carries the published capability inventory. Resource metadata
describes one governed resource and the operations Relay actually exposes.

## Aggregate data

Relay 0.38 publishes aggregate data through its SDMX 2.1 surface:

```js
queryAggregate({
  agency: "AGENCY",
  resource: "FARM_ACTIVITY",
  version: "1.0.0",
  key: "A.NORTH",
  constraints: { TIME_PERIOD: "ge:2025+le:2026" },
  offset: 0,
  limit: 100,
  dimensionAtObservation: "AllDimensions",
  format: "json",
  as: "activity",
});
```

The successful result preserves `body` as UTF-8 text and `mediaType` from the
validated native response. CSV remains text; JSON is not reparsed into an
unvalidated shape.

## Results and failures

Every operation writes under `state.data[as]` and keeps `configuration` for
later operations in the same OpenFn job. OpenFn removes credentials at the job
boundary.

Successful results use `branch: "succeeded"`, the native `value` or raw
`body`, `traceId`, optional `etag`, and optional `continuation`. A matching ETag
uses `branch: "not_modified"`.

Failures expose typed, value-free facts only:

- `invalid_request`
- `auth_failed`
- `denied`
- `not_found`
- `conflict`
- `protocol_failed`
- `retryable_infrastructure`
- `failed`

The adaptor never returns the native error message or a Problem Details body.
Its `problem` contains only a typed client failure code, status, and retryable flag;
typed `traceId`, `retryAfterSeconds`, `transportKind`, and `tokenKind` are kept
when the client supplies them.
