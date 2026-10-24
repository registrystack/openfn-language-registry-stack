import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import compile from "@openfn/compiler";
import run from "@openfn/runtime";
import {
  continueList,
  continueResources,
  getRecord,
  getResource,
  getServiceMetadata,
  listRecords,
  listResources,
  lookupRecord,
  queryAggregate,
} from "../src/index.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const ETAG = `"${"0123456789abcdef".repeat(4)}"`;
const requests = [];
let server;
let baseUrl;

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const languageCommonRoot = findDependencyRoot(packageRoot, "@openfn/language-common");

before(async () => {
  server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });

    response.setHeader("traceparent", TRACEPARENT);
    if (request.headers["if-none-match"] === ETAG) {
      response.statusCode = 304;
      response.setHeader("etag", ETAG);
      response.end();
      return;
    }

    const path = new URL(request.url, "http://relay.invalid").pathname;
    if (path === "/tenant/v2/resources/farmers/records/FARMER-1001") {
      json(response, recordEnvelope("FARMER-1001", "north"));
      return;
    }
    if (path === "/tenant/v2/resources/farmers/records") {
      json(response, recordCollection("FARMER-1001", "north"));
      return;
    }
    if (path === "/tenant/v2/resources/farmers/lookups/by-local-identifier") {
      json(response, recordEnvelope("FARMER-1001", "north"));
      return;
    }
    if (path.startsWith("/tenant/sdmx/v2/data/dataflow/AGENCY/FARM_ACTIVITY/1.0.0")) {
      response.statusCode = 200;
      response.setHeader("content-type", "application/vnd.sdmx.data+json;version=2.1.0");
      response.end('{"dataSets":[],"structure":{"name":"Farm activity"}}');
      return;
    }
    problem(response, "resource.not_found", 404);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/tenant`;
});

after(async () => {
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
});

function baseState(data = {}) {
  return {
    data: { farmer_id: "FARMER-1001", ...data },
    configuration: { relay_base_url: baseUrl, token: "secret-token" },
  };
}

test("getRecord uses the 0.38 native V2 route and preserves composition credentials", async () => {
  requests.length = 0;
  const state = await getRecord({
    resource: "farmers",
    recordIdentifier: { valueFrom: "farmer_id" },
    accessProfile: "programme-reader",
    fields: ["district", "registrationStatus"],
    as: "farmer",
    redactDataPaths: ["farmer_id"],
  })(baseState());

  assert.equal(requests.length, 1);
  const request = requests[0];
  const url = new URL(request.url, baseUrl);
  assert.equal(url.pathname, "/tenant/v2/resources/farmers/records/FARMER-1001");
  assert.equal(url.searchParams.get("accessProfile"), "programme-reader");
  assert.equal(url.searchParams.get("fields"), "district,registrationStatus");
  assert.equal(request.headers.authorization, "Bearer secret-token");
  assert.deepEqual(state.data.farmer, {
    branch: "succeeded",
    value: recordEnvelope("FARMER-1001", "north"),
    traceId: TRACE_ID,
  });
  assert.equal("farmer_id" in state.data, false);
  assert.equal(state.configuration.token, "secret-token");
});

test("canonical response bound reaches the native client and the old authored spelling is refused", async () => {
  requests.length = 0;
  const configured = baseState();
  configured.configuration = {
    unrelated: { enabled: true },
    relay: {
      baseUrl,
      authorization: { static: "secret-token" },
      maximumResponseBytes: 64,
    },
  };
  const bounded = await getRecord({ resource: "farmers", recordIdentifier: "FARMER-1001" })(configured);
  assert.equal(bounded.data.relay.branch, "retryable_infrastructure", JSON.stringify(bounded.data.relay));
  assert.equal(requests.length, 1);

  configured.configuration.relay = {
    baseUrl,
    authorization: { static: "secret-token" },
    maxResponseBytes: 64,
  };
  const refused = await getRecord({ resource: "farmers", recordIdentifier: "FARMER-1001" })(configured);
  assert.equal(refused.data.relay.branch, "invalid_request", JSON.stringify(refused.data.relay));
  assert.equal(requests.length, 1);

  const schema = JSON.parse(
    readFileSync(new URL("../configuration-schema.json", import.meta.url), "utf8"),
  );
  assert.equal(schema.properties.relay.properties.maximumResponseBytes.type, "integer");
  assert.equal(schema.properties.relay.properties.maxResponseBytes, undefined);
});

test("listRecords and continueList keep the native continuation closed", async () => {
  requests.length = 0;
  const first = await listRecords({
    resource: "farmers",
    accessProfile: "programme-reader",
    fields: ["district"],
    filters: { district: "north" },
    pageSize: 25,
    as: "page",
  })(baseState());

  const firstUrl = new URL(requests[0].url, baseUrl);
  assert.equal(firstUrl.pathname, "/tenant/v2/resources/farmers/records");
  assert.equal(firstUrl.searchParams.get("pageSize"), "25");
  assert.equal(firstUrl.searchParams.get("district"), "north");
  assert.equal(first.data.page.value.items[0].domainData.district, "north");
  assert.equal(first.data.page.continuation, undefined);

  const continuation = {
    route: { kind: "records", resource: "farmers" },
    cursor: "opaque_cursor-123",
    format: "json",
    accessProfile: "programme-reader",
  };
  const next = await continueList({ continuation, etag: ETAG, as: "next" })(first);
  const continuedUrl = new URL(requests.at(-1).url, baseUrl);
  assert.equal(continuedUrl.pathname, "/tenant/v2/resources/farmers/records");
  assert.equal(continuedUrl.searchParams.get("cursor"), "opaque_cursor-123");
  assert.equal(continuedUrl.searchParams.get("accessProfile"), "programme-reader");
  assert.equal(continuedUrl.searchParams.has("fields"), false);
  assert.deepEqual(next.data.next, { branch: "not_modified", etag: ETAG, traceId: TRACE_ID });
});

test("lookupRecord sends the selector body through the native client", async () => {
  requests.length = 0;
  const state = await lookupRecord({
    resource: "farmers",
    lookup: "by-local-identifier",
    selectors: { localIdentifier: "FARMER-1001", active: true, sequence: 42 },
    accessProfile: "programme-reader",
    as: "lookup",
  })(baseState());

  assert.deepEqual(JSON.parse(requests[0].body), {
    selectors: { active: true, localIdentifier: "FARMER-1001", sequence: 42 },
  });
  assert.equal(state.data.lookup.branch, "succeeded");
  assert.equal(state.data.lookup.value.data.recordIdentifier, "FARMER-1001");
});

test("metadata and resource continuations use only current native methods", async () => {
  requests.length = 0;
  let state = baseState();
  state = await getServiceMetadata({ etag: ETAG, as: "service" })(state);
  state = await listResources({ pageSize: 20, etag: ETAG, as: "resources" })(state);
  state = await continueResources({
    continuation: { cursor: "opaque_resource-123" },
    etag: ETAG,
    as: "continued_resources",
  })(state);
  state = await getResource({ resource: "farmers", etag: ETAG, as: "resource" })(state);

  assert.deepEqual(
    [state.data.service, state.data.resources, state.data.continued_resources, state.data.resource]
      .map((result) => result.branch),
    ["not_modified", "not_modified", "not_modified", "not_modified"],
  );
  assert.deepEqual(requests.map((request) => new URL(request.url, baseUrl).pathname), [
    "/tenant/v2",
    "/tenant/v2/resources",
    "/tenant/v2/resources",
    "/tenant/v2/resources/farmers",
  ]);
});

test("queryAggregate exposes validated SDMX bytes as UTF-8 text", async () => {
  requests.length = 0;
  const state = await queryAggregate({
    agency: "AGENCY",
    resource: "FARM_ACTIVITY",
    version: "1.0.0",
    key: "A.NORTH",
    constraints: { TIME_PERIOD: "ge:2025+le:2026" },
    offset: 0,
    limit: 100,
    dimensionAtObservation: "AllDimensions",
    format: "json",
    as: "aggregate",
  })(baseState());

  const url = new URL(requests[0].url, baseUrl);
  assert.match(url.pathname, /\/tenant\/sdmx\/v2\/data\/dataflow\/AGENCY\/FARM_ACTIVITY\/1\.0\.0\/A\.NORTH$/u);
  assert.equal(url.searchParams.get("c[TIME_PERIOD]"), "ge:2025+le:2026");
  assert.equal(state.data.aggregate.branch, "succeeded");
  assert.equal(state.data.aggregate.mediaType, "application/vnd.sdmx.data+json;version=2.1.0");
  assert.equal(state.data.aggregate.body, '{"dataSets":[],"structure":{"name":"Farm activity"}}');
});

test("native problems map to value-free branches", async () => {
  const state = await getRecord({
    resource: "farmers",
    recordIdentifier: "missing",
    as: "missing",
  })(baseState());

  assert.deepEqual(state.data.missing, {
    branch: "not_found",
    problem: { code: "resource.not_found", status: 404, retryable: false },
    traceId: TRACE_ID,
  });
  assert.equal(JSON.stringify(state).includes("The requested resource does not exist"), false);
});

test("missing current route arguments fail before network I/O", async () => {
  requests.length = 0;
  const state = await getRecord({ dataset: "old", entity: "old", id: "old" })(baseState());
  assert.deepEqual(state.data.relay, {
    branch: "invalid_request",
    problem: { code: "request.required", retryable: false },
  });
  assert.equal(requests.length, 0);
});

test("cyclic and accessor inputs fail before credentials or network are used", async () => {
  requests.length = 0;
  const cyclic = { resource: "farmers" };
  cyclic.filters = cyclic;
  const cyclicState = await listRecords(cyclic)(baseState());
  assert.equal(cyclicState.data.relay.branch, "invalid_request");

  let getterInvoked = false;
  const accessor = { resource: "farmers" };
  Object.defineProperty(accessor, "filters", {
    enumerable: true,
    get() {
      getterInvoked = true;
      return { district: "north" };
    },
  });
  const accessorState = await listRecords(accessor)(baseState());
  assert.equal(accessorState.data.relay.branch, "invalid_request");
  assert.equal(getterInvoked, false);

  let tokenGetterInvoked = false;
  const configuration = { relay_base_url: baseUrl };
  Object.defineProperty(configuration, "token", {
    enumerable: true,
    get() {
      tokenGetterInvoked = true;
      return "must-not-be-read";
    },
  });
  const configurationState = await getRecord({
    resource: "farmers", recordIdentifier: "FARMER-1001",
  })({ data: {}, configuration });
  assert.equal(configurationState.data.relay.branch, "invalid_request");
  assert.equal(tokenGetterInvoked, false);
  assert.equal(requests.length, 0);
});

test("VM-built fields, filters, and selectors cross the native JSON boundary", async () => {
  const source = `
    import { dataValue, execute } from "@openfn/language-common";
    import { listRecords, lookupRecord } from "../src/index.js";
    execute(
      listRecords(state => ({
        resource: "farmers",
        accessProfile: "programme-reader",
        fields: state.data.fields,
        filters: { district: state.data.district },
        pageSize: 10,
        as: "page",
      })),
      lookupRecord({
        resource: "farmers",
        lookup: "by-local-identifier",
        selectors: { localIdentifier: dataValue("farmer_id") },
        accessProfile: "programme-reader",
        as: "lookup",
      }),
    );
  `;
  const { code } = compile(source);
  const result = await run(
    {
      workflow: { steps: [{ id: "native-json", expression: code }], start: "native-json" },
      options: { start: "native-json" },
    },
    baseState({ fields: ["district"], district: "north" }),
    {
      linker: {
        modules: {
          "@openfn/language-common": { path: languageCommonRoot },
          "../src/index.js": { path: packageRoot },
        },
        cacheKey: `openfn-relay-json-${process.pid}-${Date.now()}`,
      },
      statePropsToRemove: [],
    },
  );

  assert.equal(result.errors, undefined);
  assert.equal(result.data.page.branch, "succeeded");
  assert.equal(result.data.lookup.branch, "succeeded");
  assert.equal(result.data.lookup.value.data.recordIdentifier, "FARMER-1001");
});

test("the compiled OpenFn job runs through the VM and the real native client", async () => {
  const template = readFileSync(new URL("../jobs/read-record.js", import.meta.url), "utf8");
  const { code } = compile(template);
  const result = await run(
    {
      workflow: { steps: [{ id: "read-record", expression: code }], start: "read-record" },
      options: { start: "read-record" },
    },
    baseState(),
    {
      linker: {
        modules: {
          "@openfn/language-common": { path: languageCommonRoot },
          "../src/index.js": { path: packageRoot },
        },
        cacheKey: `openfn-relay-037-${process.pid}-${Date.now()}`,
      },
      statePropsToRemove: [],
    },
  );

  assert.equal(result.errors, undefined);
  assert.equal(result.data.farmer.branch, "succeeded");
  assert.equal(result.data.decision_input.farmer_id, "FARMER-1001");
  assert.equal(result.data.decision_input.district, "north");
  assert.equal(result.data.decision_input.relay_trace_id, TRACE_ID);
  assert.equal(result.configuration.token, "secret-token");
});

function record(resourceId, district) {
  return {
    recordIdentifier: resourceId,
    revisionIdentifier: "revision-1",
    lifecycleState: "active",
    schemaReference: "https://relay.example.invalid/schemas/farmer",
    semanticModelReference: "https://relay.example.invalid/models/farmer",
    authorityIdentifier: "agriculture-authority",
    recordedAt: "2026-09-01T00:00:00Z",
    domainData: { district, registrationStatus: "active" },
  };
}

function metadata() {
  return {
    registryIdentifier: "agriculture-registry",
    datasetIdentifier: "agriculture",
    entityTypeIdentifier: "farmer",
    operationIdentifier: "farmer.read",
    accessProfile: "programme-reader",
    family: "consultation",
    pattern: "retrieve",
    disclosureProfile: "programme",
    contractRevision: "1",
    sourceRevision: { profile: "snapshot", status: "versioned", value: "1" },
    selectedFields: ["district", "registrationStatus"],
    links: {
      self: "https://relay.example.invalid/v2/resources/farmers/records/FARMER-1001",
      context: "https://relay.example.invalid/contexts/farmer.jsonld",
      schema: "https://relay.example.invalid/schemas/farmer",
      semanticModel: "https://relay.example.invalid/models/farmer",
    },
  };
}

function recordEnvelope(resourceId, district) {
  return { data: record(resourceId, district), meta: metadata() };
}

function recordCollection(resourceId, district) {
  return { items: [record(resourceId, district)], pageInfo: { nextCursor: null }, meta: metadata() };
}

function json(response, body) {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function problem(response, code, status) {
  response.statusCode = status;
  response.setHeader("content-type", "application/problem+json");
  response.end(JSON.stringify({
    type: "https://id.registrystack.org/problems/registry-relay/resource/not_found",
    title: "Requested resource was not found",
    status,
    detail: "the requested resource was not found",
    code,
    traceId: TRACE_ID,
  }));
}

function findDependencyRoot(start, packageName) {
  let current = resolve(start);
  while (true) {
    const candidate = resolve(current, "node_modules", packageName);
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
    const parent = resolve(current, "..");
    if (parent === current) throw new Error(`dependency not found: ${packageName}`);
    current = parent;
  }
}
