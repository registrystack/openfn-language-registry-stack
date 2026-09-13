import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import compile from "@openfn/compiler";
import run from "@openfn/runtime";
import { createCaseworkItem, getCaseworkItem, listCaseworkWorkItems, approveCaseworkTaskGrant } from "../src/index.js";

test("real native Casework client creates hosted intake and preserves task authority", async (context) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(req.method === "POST" && req.url === "/v1/hosted-items" ? 201 : 200,
      { "content-type": "application/json", traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" });
    if (req.url === "/v1/hosted-items") {
      res.end(JSON.stringify({ itemId: "00000000-0000-4000-8000-000000000001", requesterReference: "event-42",
        kind: "intake", version: "1", display: { reference: "event-42" }, state: "open", revision: 1,
        kindPolicyDigest: `sha256:${"a".repeat(64)}`, createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z" }));
    } else if (req.method === "GET") {
      res.end(JSON.stringify({ items: [], servedQueues: ["review"], status: "complete" }));
    } else {
      res.end(JSON.stringify({ id: "00000000-0000-4000-8000-000000000002", templateId: "verify", templateVersion: "1",
        agent: { issuer: "https://issuer.invalid", subject: "worker" }, client: "worker", resource: "urn:evidence", scopes: [],
        purpose: "verify", bounds: { type: "evidence", requirement: "status" }, expiresAt: 2000000900, invalidated: false }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(() => new Promise(resolve => server.close(resolve)));
  const state = { configuration: { casework: { baseUrl: `http://127.0.0.1:${server.address().port}/`, token: "synthetic-token", profile: "requester" } }, data: {} };
  const created = await createCaseworkItem({ kind: "intake", requesterReference: "event-42", display: { reference: "event-42" }, idempotencyKey: "event-42:create" })(state);
  assert.equal(created.data.caseworkCreated.branch, "succeeded", JSON.stringify(created.data.caseworkCreated));
  assert.equal(requests[0].url, "/v1/hosted-items");
  assert.equal(requests[0].headers["idempotency-key"], "event-42:create");
  assert.equal(requests[0].headers.authorization, "Bearer synthetic-token");
  const listed = await listCaseworkWorkItems({ sourceProfile: "reviewer", query: { view: "my_teams", limit: 20 } })(created);
  assert.equal(listed.data.caseworkWorkItems.branch, "succeeded", JSON.stringify(listed.data.caseworkWorkItems));
  assert.equal(requests[1].headers["registry-source-profile"], "reviewer");
  const approved = await approveCaseworkTaskGrant({ sourceProfile: "reviewer", itemId: "00000000-0000-4000-8000-000000000001",
    expectedRevision: 7, idempotencyKey: "grant-42", templateId: "verify", templateVersion: "1" })(listed);
  assert.equal(approved.data.caseworkTaskGrant.branch, "succeeded", JSON.stringify(approved.data.caseworkTaskGrant));
  assert.equal(requests[2].headers["if-match"], '"7"');
  assert.equal(requests[2].headers["idempotency-key"], "grant-42");
  assert.deepEqual(JSON.parse(requests[2].body), { templateId: "verify", templateVersion: "1" });
  const { code } = compile(readFileSync(new URL("../jobs/create-request.js", import.meta.url), "utf8"));
  const runtime = await run({ workflow: { steps: [{ id: "hosted", expression: code }], start: "hosted" }, options: { start: "hosted" } },
    { ...state, data: { caseworkKind: "intake", requesterReference: "event-42", display: { reference: "event-42" }, createIdempotencyKey: "event-42:create" } },
    { linker: { modules: { "@openfn/language-common": { path: fileURLToPath(new URL("../../../node_modules/@openfn/language-common", import.meta.url)) },
      "../src/index.js": { path: fileURLToPath(new URL("..", import.meta.url)) } }, cacheKey: `casework-${process.pid}` } });
  assert.equal(runtime.errors, undefined, JSON.stringify(runtime.errors));
  assert.equal(runtime.data.createdCasework.branch, "succeeded", JSON.stringify(runtime.data));
  assert.equal(requests[3].headers["idempotency-key"], "event-42:create");
  assert.equal("configuration" in runtime, false);
  assert.equal(JSON.stringify(runtime).includes("synthetic-token"), false);
});

test("Casework service credential is minted by the native provider before one read", async (context) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json", traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" });
    res.end(req.url === "/token" ? JSON.stringify({ access_token: "minted-casework-token", token_type: "Bearer", expires_in: 300 })
      : JSON.stringify({ itemId: "00000000-0000-4000-8000-000000000001", requesterReference: "event-42", kind: "intake", version: "1",
        display: {}, state: "open", revision: 1, kindPolicyDigest: `sha256:${"a".repeat(64)}`,
        createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z" }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const clientKey = { ...privateKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "ES256" };
  const state = { configuration: { casework: { baseUrl, profile: "requester", authorization: { privateKeyJwt: {
    tokenEndpoint: `${baseUrl}token`, clientId: "worker", clientKey, resource: baseUrl, scopes: ["casework:read"] } } } }, data: {} };
  const invalid = await createCaseworkItem({ kind: "intake", display: {} })(state);
  assert.equal(invalid.data.caseworkCreated.branch, "invalid_request");
  assert.equal(requests.length, 0);
  const result = await getCaseworkItem({ itemId: "00000000-0000-4000-8000-000000000001" })(state);
  assert.equal(result.data.caseworkItem.branch, "succeeded", JSON.stringify(result.data.caseworkItem));
  assert.equal(requests[0].url, "/token");
  assert.equal(requests[1].headers.authorization, "Bearer minted-casework-token");
  assert.equal(JSON.stringify(result.data).includes("minted-casework-token"), false);
});
