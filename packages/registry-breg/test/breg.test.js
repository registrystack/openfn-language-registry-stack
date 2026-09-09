import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import compile from "@openfn/compiler";
import run from "@openfn/runtime";
import { execute, discoverRegistry, getEntitySchema, getRecord, lookupRecord, listRecords, continueList, createRecord, patchRecord, createChangeRequest, executeLifecycleAction } from "../src/index.js";
import { ID, ETAG, ACTION_ETAG, TRACE, PROFILE, metadata, record, receipt } from "./fixtures.js";

async function server(handler) {
  const requests = [];
  const httpServer = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, headers: req.headers, body });
    res.setHeader("traceparent", `00-${TRACE}-00f067aa0ba902b7-01`);
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.setHeader("vary", "authorization, accept");
    res.setHeader("link", '<https://id.registrystack.org/profiles/registry-record/v1>; rel="profile", </tenant/v1/schemas/company>; rel="describedby"');
    await handler(req, res);
  });
  await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  return { requests, baseUrl: `http://127.0.0.1:${httpServer.address().port}/tenant`, close: () => new Promise(resolve => httpServer.close(resolve)) };
}
function state(baseUrl) { return { configuration: { breg: { baseUrl, authorization: { static: "synthetic-breg-token" } } }, data: {} }; }
function regular(req, res) {
  if (req.url.includes("/v1/registry")) return res.end(JSON.stringify(metadata()));
  if (req.url.includes("/v1/schemas/")) return res.end('{"type":"object"}');
  if (req.url.includes("/actions/")) { res.removeHeader("link"); return res.end(JSON.stringify(receipt())); }
  if (!req.url.includes("lookup")) res.setHeader("etag", ETAG);
  if (req.method === "POST" && !req.url.includes("lookup")) {
    res.statusCode = 201;
    res.setHeader("location", `/tenant/v1/records/companies/${ID}`);
  }
  res.end(JSON.stringify(record()));
}
const write = { operationIdentifier: "records.company.create", accessProfile: PROFILE, idempotencyKey: "synthetic-create-001", data: { legalName: "Example Ltd" } };
const lifecycle = { entityIdentifier: "company", route: "companies", recordIdentifier: ID, accessProfile: PROFILE, operation: "submit_request", ifMatch: ACTION_ETAG, idempotencyKey: "synthetic-submit-001" };

test("native discovery, exact lookup, read, and schema preserve composition configuration", async () => {
  const stub = await server(regular);
  try {
    const initial = state(stub.baseUrl);
    const result = await execute(discoverRegistry({ accessProfile: PROFILE, as: "metadata" }), lookupRecord({ route: "companies", selector: "by-name", values: { legalName: "Example Ltd" }, accessProfile: PROFILE, as: "lookup" }), getRecord({ route: "companies", recordIdentifier: ID, as: "record" }), getEntitySchema({ entityIdentifier: "company", as: "schema" }))(initial);
    for (const key of ["metadata", "lookup", "record", "schema"]) assert.equal(result.data[key].branch, "succeeded", JSON.stringify(result.data[key]));
    assert.equal(result.configuration, initial.configuration);
    assert.deepEqual(JSON.parse(stub.requests[1].body), { selector: "by-name", values: { legalName: "Example Ltd" } });
    assert.ok(stub.requests.every(req => req.headers.authorization === "Bearer synthetic-breg-token"));
  } finally { await stub.close(); }
});

test("metadata-selected create and patch carry caller keys and exact record ETag", async () => {
  const stub = await server(regular);
  try {
    const result = await execute(createRecord({ ...write, as: "created" }), patchRecord(s => ({ operationIdentifier: "records.company.patch", accessProfile: PROFILE, recordIdentifier: ID, etag: s.data.created.etag, idempotencyKey: "synthetic-patch-001", operations: [{ op: "replace", field: "legalName", value: "Renamed Ltd" }] })))(state(stub.baseUrl));
    assert.equal(result.data.created.branch, "succeeded", JSON.stringify(result.data.created));
    assert.equal(result.data.breg.branch, "succeeded", JSON.stringify(result.data.breg));
    assert.equal(stub.requests[1].headers["idempotency-key"], write.idempotencyKey);
    assert.deepEqual(JSON.parse(stub.requests[1].body), { data: write.data });
    const patch = stub.requests[3];
    assert.equal(patch.headers["if-match"], ETAG);
    assert.equal(patch.headers["content-type"], "application/json-patch+json");
    assert.deepEqual(JSON.parse(patch.body), [{ op: "replace", path: "/data/legalName", value: "Renamed Ltd" }]);
    assert.ok(!JSON.stringify(result.data).includes("BRegCreateBinding"));
  } finally { await stub.close(); }
});

test("missing keys/preconditions and arbitrary operation URLs cannot write", async () => {
  const stub = await server(regular);
  try {
    for (const op of [createRecord({ ...write, idempotencyKey: undefined }), patchRecord({ ...write, etag: undefined }), executeLifecycleAction({ ...lifecycle, ifMatch: undefined })]) {
      assert.equal((await op(state(stub.baseUrl))).data.breg.branch, "invalid_request");
    }
    assert.equal(stub.requests.length, 0);
    const result = await createRecord({ ...write, operationIdentifier: "https://attacker.invalid/write" })(state(stub.baseUrl));
    assert.equal(result.data.breg.branch, "denied");
    assert.equal(stub.requests.length, 1);
    const draft = await createChangeRequest(write)(state(stub.baseUrl));
    assert.equal(draft.data.breg.branch, "succeeded");
  } finally { await stub.close(); }
});

test("native lifecycle promotion executes exact action and refuses a changed precondition", async () => {
  const stub = await server((req, res) => {
    if (req.method === "GET" && req.url.includes(`/companies/${ID}`)) { res.setHeader("etag", ETAG); return res.end(JSON.stringify(record(true))); }
    regular(req, res);
  });
  try {
    const result = await executeLifecycleAction(lifecycle)(state(stub.baseUrl));
    assert.equal(result.data.breg.branch, "succeeded", JSON.stringify(result.data.breg));
    assert.equal(stub.requests[2].headers["if-match"], ACTION_ETAG);
    assert.equal(stub.requests[2].headers["idempotency-key"], lifecycle.idempotencyKey);
    assert.deepEqual(JSON.parse(stub.requests[2].body), {});
    const stale = await executeLifecycleAction({ ...lifecycle, ifMatch: ETAG })(state(stub.baseUrl));
    assert.equal(stale.data.breg.branch, "conflict");
    assert.equal(stub.requests.filter(req => req.method === "POST").length, 1);
  } finally { await stub.close(); }
});

test("one explicit page and continuation preserve native cursor bindings", async () => {
  const stub = await server((req, res) => res.end(JSON.stringify({ items: [record().data], pageInfo: { nextCursor: req.url.includes("skiptoken") ? null : "synthetic_cursor" }, meta: record().meta })));
  try {
    const first = await listRecords({ route: "companies", top: 1, accessProfile: PROFILE })(state(stub.baseUrl));
    assert.equal(first.data.breg.branch, "succeeded", JSON.stringify(first.data.breg));
    assert.equal(stub.requests.length, 1);
    const second = await continueList({ continuation: first.data.breg.continuation })(first);
    assert.equal(second.data.breg.branch, "succeeded", JSON.stringify(second.data.breg));
    assert.equal(stub.requests.length, 2);
    const params = new URL(stub.requests[1].url, stub.baseUrl).searchParams;
    assert.equal(params.get("$skiptoken"), "synthetic_cursor");
    assert.equal(params.has("$top"), false);
  } finally { await stub.close(); }
});

test("safe stable failures distinguish not found, denied, conflict and temporary service errors without retries", async () => {
  for (const [status, code, branch] of [[404, "resource.not_found", "not_found"], [403, "auth.forbidden", "denied"], [409, "mutation.conflict", "conflict"], [503, "source.unavailable", "retryable_infrastructure"]]) {
    const stub = await server((_req, res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/problem+json");
      res.end(JSON.stringify({ type: status === 503 ? "https://id.registrystack.org/problems/registry-breg/source/unavailable" : "about:blank", title: status === 503 ? "Service Unavailable" : "secret-canary", status, code, traceId: TRACE, detail: status === 503 ? "The Registry data service is unavailable." : "secret-canary" }));
    });
    try {
      const result = await getRecord({ route: "companies", recordIdentifier: ID })(state(stub.baseUrl));
      assert.equal(result.data.breg.branch, branch, JSON.stringify(result.data.breg));
      assert.equal(stub.requests.length, 1);
      assert.ok(!JSON.stringify(result.data.breg).includes("secret-canary"));
    } finally { await stub.close(); }
  }
});

test("privateKeyJwt configuration reaches native validation without disclosing keys", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "synthetic-key" };
  const configured = { configuration: { baseUrl: "http://127.0.0.1:1", authorization: { privateKeyJwt: { tokenEndpoint: "https://127.0.0.1:1/token", clientId: "synthetic-client", clientKey: key, requestTimeoutMilliseconds: 100, connectTimeoutMilliseconds: 100 } } }, data: {} };
  const result = await discoverRegistry()(configured);
  assert.equal(result.data.breg.branch, "retryable_infrastructure", JSON.stringify(result.data.breg));
  assert.ok(!JSON.stringify(result.data).includes(key.d));
});

test("compiled OpenFn job composes native reads and writes and runtime removes credentials", async () => {
  const stub = await server(regular);
  try {
    const { code } = compile(readFileSync(new URL("../jobs/read-and-patch.js", import.meta.url), "utf8"));
    const result = await run({ workflow: { steps: [{ id: "breg", expression: code }], start: "breg" }, options: { start: "breg" } },
      { ...state(stub.baseUrl), data: { recordIdentifier: ID, idempotencyKey: "synthetic-job-patch-001", legalName: "Renamed Ltd" } },
      { linker: { modules: { "@openfn/language-common": { path: fileURLToPath(new URL("../../../node_modules/@openfn/language-common", import.meta.url)) }, "../src/index.js": { path: fileURLToPath(new URL("..", import.meta.url)) } }, cacheKey: `breg-${process.pid}` } });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    assert.equal(result.data.updated.branch, "succeeded", JSON.stringify(result.data));
    assert.equal("configuration" in result, false);
    assert.ok(!JSON.stringify(result).includes("synthetic-breg-token"));
  } finally { await stub.close(); }
});

test("malformed plain-data graphs fail without accessing properties or sending mutations", async () => {
  const stub = await server(regular);
  let read = false;
  const accessor = {};
  Object.defineProperty(accessor, "legalName", { enumerable: true, get() { read = true; throw new Error("secret-accessor-canary"); } });
  const cyclic = {}; cyclic.self = cyclic;
  try {
    for (const data of [accessor, cyclic, new Date(), new Proxy({}, {})]) {
      const result = await createRecord({ ...write, data })(state(stub.baseUrl));
      assert.equal(result.data.breg.branch, "invalid_request");
      assert.ok(!JSON.stringify(result.data.breg).includes("secret-accessor-canary"));
    }
    assert.equal(read, false);
    assert.equal(stub.requests.some(req => req.method !== "GET"), false);
  } finally { await stub.close(); }
});

test("record action URLs cannot create authority outside metadata", async () => {
  const stub = await server((req, res) => {
    if (req.url.includes(`/companies/${ID}`)) {
      const body = record(true);
      body.data.request.actions[0].href = "https://attacker.invalid/mutate";
      return res.end(JSON.stringify(body));
    }
    regular(req, res);
  });
  try {
    const result = await executeLifecycleAction(lifecycle)(state(stub.baseUrl));
    assert.notEqual(result.data.breg.branch, "succeeded");
    assert.equal(stub.requests.length, 2);
    assert.equal(stub.requests.some(req => req.method !== "GET"), false);
  } finally { await stub.close(); }
});

test("redirects and malformed success responses fail closed without automatic follow-up", async () => {
  for (const redirect of [true, false]) {
    const stub = await server((_req, res) => {
      if (redirect) { res.statusCode = 302; res.setHeader("location", "/tenant/elsewhere"); }
      res.end("secret-malformed-response-canary");
    });
    try {
      const result = await getRecord({ route: "companies", recordIdentifier: ID })(state(stub.baseUrl));
      assert.notEqual(result.data.breg.branch, "succeeded");
      assert.equal(stub.requests.length, 1);
      assert.ok(!JSON.stringify(result.data.breg).includes("secret-malformed-response-canary"));
    } finally { await stub.close(); }
  }
});

test("compiled governed draft creation and explicit submission keep separate keys", async () => {
  const stub = await server((req, res) => {
    if (req.url.includes("/v1/registry") || req.url.includes("/actions/")) return regular(req, res);
    res.setHeader("etag", ETAG);
    if (req.method === "POST") { res.statusCode = 201; res.setHeader("location", `/tenant/v1/records/companies/${ID}`); }
    const value = record(req.method !== "POST");
    res.end(JSON.stringify(value));
  });
  try {
    const { code } = compile(readFileSync(new URL("../jobs/create-and-submit.js", import.meta.url), "utf8"));
    const result = await run({ workflow: { steps: [{ id: "breg", expression: code }], start: "breg" }, options: { start: "breg" } },
      { ...state(stub.baseUrl), data: { createOperationIdentifier: "records.company.create", accessProfile: PROFILE, requestFields: { legalName: "Example Ltd" }, createIdempotencyKey: "synthetic-draft-001", submitIdempotencyKey: "synthetic-draft-submit-001", requestRoute: "companies" } },
      { linker: { modules: { "@openfn/language-common": { path: fileURLToPath(new URL("../../../node_modules/@openfn/language-common", import.meta.url)) }, "../src/index.js": { path: fileURLToPath(new URL("..", import.meta.url)) } }, cacheKey: `breg-submit-${process.pid}` } });
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    assert.equal(result.data.submission?.branch, "succeeded", JSON.stringify(result.data));
    assert.equal("configuration" in result, false);
    assert.deepEqual(stub.requests.filter(req => req.method === "POST").map(req => req.headers["idempotency-key"]), ["synthetic-draft-001", "synthetic-draft-submit-001"]);
  } finally { await stub.close(); }
});

test("stale patch ETag conflicts without overwriting or acquiring a replacement precondition", async () => {
  let current = record();
  let currentEtag = ETAG;
  let committedWrites = 0;
  const stub = await server((req, res) => {
    if (req.url.includes("/v1/registry")) return res.end(JSON.stringify(metadata()));
    if (req.method === "PATCH") {
      if (req.headers["if-match"] !== currentEtag) {
        res.statusCode = 412;
        res.setHeader("content-type", "application/problem+json");
        return res.end(JSON.stringify({
          type: "https://id.registrystack.org/problems/registry-breg/precondition/failed",
          title: "Precondition Failed", status: 412, code: "precondition.failed",
          detail: "The mutation precondition failed.", traceId: TRACE,
        }));
      }
      const operations = JSON.parse(stub.requests.at(-1).body);
      assert.deepEqual(operations.map(operation => [operation.op, operation.path]), [["replace", "/data/legalName"]]);
      current = { ...current, data: { ...current.data, revisionIdentifier: "2", domainData: { legalName: operations[0].value } } };
      currentEtag = '"breg-record-000000000002"';
      committedWrites++;
    }
    res.setHeader("etag", currentEtag);
    res.end(JSON.stringify(current));
  });
  try {
    const initial = await getRecord({ route: "companies", recordIdentifier: ID, accessProfile: PROFILE })(state(stub.baseUrl));
    assert.equal(initial.data.breg.branch, "succeeded");
    const heldEtag = initial.data.breg.etag;
    const patch = {
      operationIdentifier: "records.company.patch", accessProfile: PROFILE,
      recordIdentifier: ID, etag: heldEtag,
      operations: [{ op: "replace", field: "legalName", value: "Accepted update" }],
      idempotencyKey: "synthetic-etag-first-001",
    };
    const accepted = await patchRecord(patch)(initial);
    assert.equal(accepted.data.breg.branch, "succeeded", JSON.stringify(accepted.data.breg));
    assert.notEqual(accepted.data.breg.etag, heldEtag);
    const rejected = await patchRecord({ ...patch,
      operations: [{ op: "replace", field: "legalName", value: "Rejected overwrite" }],
      idempotencyKey: "synthetic-etag-stale-002",
    })(accepted);
    assert.equal(rejected.data.breg.branch, "conflict", JSON.stringify(rejected.data.breg));
    assert.equal(rejected.data.breg.problem.status, 412);
    assert.equal(rejected.data.breg.code, "precondition.failed");
    assert.equal(rejected.data.breg.problem.retryable, false);
    assert.equal(committedWrites, 1);
    assert.deepEqual(current.data.domainData, { legalName: "Accepted update" });
    assert.equal(current.data.revisionIdentifier, "2");
    assert.deepEqual(stub.requests.map(request => request.method), ["GET", "GET", "PATCH", "GET", "PATCH"]);
    assert.ok(stub.requests.filter(request => request.method === "GET").slice(1).every(request => request.url.includes("/v1/registry")));
    const attempts = stub.requests.filter(request => request.method === "PATCH");
    assert.deepEqual(attempts.map(request => request.headers["if-match"]), [heldEtag, heldEtag]);
    assert.deepEqual(attempts.map(request => request.headers["idempotency-key"]), ["synthetic-etag-first-001", "synthetic-etag-stale-002"]);
    const final = await getRecord({ route: "companies", recordIdentifier: ID, accessProfile: PROFILE })(rejected);
    assert.equal(final.data.breg.branch, "succeeded");
    assert.deepEqual(final.data.breg.value.data.domainData, { legalName: "Accepted update" });
  } finally { await stub.close(); }
});
