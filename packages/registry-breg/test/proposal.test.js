import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { getProposal, startProposal, submitProposal } from "../src/index.js";

const ID = "00000000-0000-4000-8000-000000000001";
const REVISION = `sha256:${"a".repeat(64)}`;
const PROFILE = "correction-author";
const INPUTS = {
  record: "00000000-0000-4000-8000-000000000002",
  name: "Corrected farm",
  reason: "Synthetic correction",
  supportingReference: "SYNTHETIC-REF",
};
const metadata = {
  id: "agricultural-holdings", version: "1", revision: REVISION,
  metadataVersion: "2", recordTypes: [], operations: [],
  proposals: {
    method: "GET", path: "/v1/proposals", accessProfiles: [PROFILE],
    actions: [{ actionId: "correct-farm-name", accessProfile: PROFILE,
      operations: ["get", "submit"], readableInputs: ["record", "name", "reason", "supporting-reference"], readableContextFields: [] }],
    get: { method: "GET", path: "/v1/proposals/{proposal_id}", accessProfiles: [PROFILE] },
  },
  actions: [{
    id: "correct-farm-name", apiName: "correctFarmName", revision: REVISION,
    display: {}, execution: { mode: "proposal" }, attachments: [],
    route: "/v1/actions/correct-farm-name/proposals", inputMode: "fixed",
    inputs: Object.keys(INPUTS).map(key => ({ id: key === "supportingReference" ? "supporting-reference" : key,
      apiName: key, required: true, nullable: false, classification: "restricted",
      schema: { type: "string", minLength: 1, maxLength: 500 },
      fieldType: { type: "string", minimumLength: 1, maximumLength: 500 } })),
    referenceInputs: [], requiredConditionKeys: [], resultEffects: [],
    access: { selectedProfile: PROFILE },
    routes: { start: { method: "POST", path: "/v1/actions/correct-farm-name/proposals",
      operationId: "actions.correct-farm-name.start", requiresIdempotencyKey: true,
      inputSchema: "action-correct-farm-name-invoke-input", responseSchema: "action-correct-farm-name-invoke-response" } },
    bounds: { maximumTargets: 16, maximumFieldMutations: 128, maximumSnapshotBytes: 2097152 },
  }],
};

function document(state = "draft", includeSubmit = true) {
  return {
    id: ID, actionId: "correct-farm-name", actionRevision: REVISION,
    submissionVersion: 1, revision: state === "draft" ? 1 : 2, state, input: INPUTS,
    ...(state === "draft" ? {} : { effectDigest: REVISION }),
    links: {
      self: { method: "GET", path: `/v1/proposals/${ID}`, accessProfile: PROFILE, operation: "get" },
      ...(state === "draft" && includeSubmit ? { submit: { method: "POST", path: `/v1/proposals/${ID}/submit`, accessProfile: PROFILE, operation: "submit", ifMatch: '"draft-condition"' } } : {}),
    },
  };
}

async function fixture() {
  const requests = [];
  let current = document();
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.setHeader("vary", "authorization, accept");
    res.setHeader("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    if (req.url.startsWith("/tenant/v1/registry")) return res.end(JSON.stringify(metadata));
    if (req.url.startsWith("/tenant/v1/actions/correct-farm-name/proposals?")) {
      res.statusCode = 201;
      return res.end(JSON.stringify(document()));
    }
    if (req.url.startsWith(`/tenant/v1/proposals/${ID}/submit?`)) {
      current = document("submitted");
      return res.end(JSON.stringify(current));
    }
    return res.end(JSON.stringify(current));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/tenant`,
    setCurrent: value => { current = value; },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function state(baseUrl) {
  return { configuration: { breg: { baseUrl, authorization: { static: "synthetic-secret-canary" } } }, data: {} };
}

test("metadata-selected Proposal start, get and submit use native conditions and return inert JSON", async () => {
  const stub = await fixture();
  try {
    const started = await startProposal({ actionIdentifier: "correct-farm-name", accessProfile: PROFILE,
      inputs: INPUTS, idempotencyKey: "correction:one" })(state(stub.baseUrl));
    assert.equal(started.data.breg.branch, "succeeded", JSON.stringify({ result: started.data.breg, requests: stub.requests.map(request => [request.method, request.url]) }));
    assert.equal(started.data.breg.value.id, ID);
    assert.equal(started.data.breg.value.state, "draft");
    assert.ok(!JSON.stringify(started.data).includes("synthetic-secret-canary"));
    assert.ok(!JSON.stringify(started.data).includes("/v1/proposals/"));
    assert.ok(!JSON.stringify(started.data).includes("BRegProposal"));
    const observed = await getProposal({ proposalIdentifier: ID, accessProfile: PROFILE })(started);
    assert.equal(observed.data.breg.branch, "succeeded", JSON.stringify(observed.data.breg));
    const submitted = await submitProposal({ proposalIdentifier: ID, accessProfile: PROFILE,
      expectedInputs: INPUTS, idempotencyKey: "correction-submit:one" })(observed);
    assert.equal(submitted.data.breg.branch, "succeeded", JSON.stringify(submitted.data.breg));
    assert.equal(submitted.data.breg.value.state, "submitted");
    const posts = stub.requests.filter(request => request.method === "POST");
    assert.deepEqual(posts.map(request => request.headers["idempotency-key"]), ["correction:one", "correction-submit:one"]);
    assert.deepEqual(JSON.parse(posts[0].body), { input: INPUTS });
    assert.deepEqual(JSON.parse(posts[1].body), {});
    assert.equal(posts[1].headers["if-match"], '"draft-condition"');
  } finally { await stub.close(); }
});

test("exact replay observes a submitted Proposal without a duplicate transition; changed inputs conflict", async () => {
  const stub = await fixture();
  try {
    const input = { proposalIdentifier: ID, accessProfile: PROFILE, expectedInputs: INPUTS, idempotencyKey: "correction-submit:one" };
    const first = await submitProposal(input)(state(stub.baseUrl));
    const replay = await submitProposal(input)(state(stub.baseUrl));
    assert.equal(first.data.breg.branch, "succeeded", JSON.stringify({ result: first.data.breg, requests: stub.requests.map(request => [request.method, request.url]) }));
    assert.equal(replay.data.breg.branch, "already_submitted", JSON.stringify(replay.data.breg));
    assert.equal(stub.requests.filter(request => request.url.includes("/submit?")).length, 1);
    const changed = await submitProposal({ ...input, expectedInputs: { ...INPUTS, name: "Different" } })(state(stub.baseUrl));
    assert.equal(changed.data.breg.branch, "conflict", JSON.stringify(changed.data.breg));
    assert.equal(stub.requests.filter(request => request.url.includes("/submit?")).length, 1);
  } finally { await stub.close(); }
});

test("unavailable submit and unselected action identifiers do not send a transition", async () => {
  const stub = await fixture();
  try {
    stub.setCurrent(document("draft", false));
    const unavailable = await submitProposal({ proposalIdentifier: ID, accessProfile: PROFILE,
      expectedInputs: INPUTS, idempotencyKey: "correction-submit:one" })(state(stub.baseUrl));
    assert.notEqual(unavailable.data.breg.branch, "succeeded");
    assert.equal(stub.requests.filter(request => request.url.includes("/submit?")).length, 0);
    const foreign = await startProposal({ actionIdentifier: "https://attacker.invalid/write", accessProfile: PROFILE,
      inputs: INPUTS, idempotencyKey: "correction:one" })(state(stub.baseUrl));
    assert.notEqual(foreign.data.breg.branch, "succeeded");
    assert.equal(stub.requests.filter(request => request.method === "POST").length, 0);
  } finally { await stub.close(); }
});
