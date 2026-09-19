import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import * as adaptor from "../src/index.js";
import { CaseworkCallerError, createCaseworkOperations } from "../src/operations.js";

class FakeCaseworkClientError extends Error {
  constructor(fields) {
    super(fields.message ?? "synthetic client failure");
    Object.assign(this, fields);
  }
}

function fakeOperations(handlers = {}) {
  const calls = [];
  class FakeCaseworkClient {
    constructor(configuration) { calls.push(["constructor", configuration]); }
  }
  for (const method of [
    "createOrRecoverReviewRequest", "reviewRequest", "reviewResult", "addReviewNote",
    "reviewHistory", "cancelReviewRequest", "reviewResults", "listWorkItems",
    "getWorkItem", "previewTaskTemplates", "listTaskGrants", "approveTaskGrant",
    "revokeTaskGrant", "taskGrantStatus",
  ]) {
    FakeCaseworkClient.prototype[method] = async function (...args) {
      calls.push([method, ...args]);
      if (handlers[method]) return handlers[method](...args);
      return {
        kind: method === "reviewResult" ? "available" : "complete",
        value: { method, revision: 2, items: [] },
        traceId: "trace-synthetic-1",
      };
    };
  }
  return {
    calls,
    operations: createCaseworkOperations(() => ({
      CaseworkClient: FakeCaseworkClient,
      CaseworkClientError: FakeCaseworkClientError,
    })),
  };
}

function state() {
  return {
    configuration: { casework: {
      baseUrl: "https://casework.example.test/tenant",
      token: "synthetic-requester-secret",
      profile: "requester",
      maxResponseBytes: 1_000_000,
    } },
    data: { input: "retained" },
  };
}

const subject = {
  source: "payments", type: "batch", id: "batch-0042", version: "7",
  digest: `sha256:${"a".repeat(64)}`,
};
const request = {
  kind: "batch-validation", subject, requesterReference: "batch-0042",
  context: { strategy: "submitted", snapshot: { summary: "Batch 42" } },
  resultConstraints: { acceptedCount: { minimum: 0 } },
};
const accepted = {
  requestId: "00000000-0000-4000-8000-000000000001", subject,
  policy: { id: "batch-validation", version: "1", digest: `sha256:${"b".repeat(64)}` },
  submissionDigest: `sha256:${"c".repeat(64)}`,
};

test("adaptor exports only unified requester operations", () => {
  assert.equal(typeof adaptor.fn, "function");
  assert.equal(typeof adaptor.execute, "function");
  for (const operation of [
    "createCaseworkRequest", "getCaseworkRequest", "getCaseworkResult",
    "addCaseworkNote", "listCaseworkHistory", "cancelCaseworkRequest",
    "pollCaseworkResults",
  ]) assert.equal(typeof adaptor[operation], "function");
  for (const removed of [
    "createCaseworkItem", "getCaseworkItem", "listCaseworkNotes", "cancelCaseworkItem",
  ]) assert.equal(removed in adaptor, false);
  assert.throws(() => createCaseworkOperations(), CaseworkCallerError);
});

test("requester operations preserve exact unified method shapes", async () => {
  const { calls, operations } = fakeOperations();
  const initial = state();
  let result = await operations.createCaseworkRequest({
    request: vm.runInNewContext(`(${JSON.stringify(request)})`),
    expectedSubmissionDigest: accepted.submissionDigest,
    idempotencyKey: "create-key-001", as: "created",
  })(initial);
  result = await operations.getCaseworkRequest({ requestId: accepted.requestId, as: "read" })(result);
  result = await operations.getCaseworkResult({ accepted, as: "result" })(result);
  result = await operations.addCaseworkNote({
    requestId: accepted.requestId, idempotencyKey: "note-key-002",
    audience: "requester", note: "Requester context.", as: "noted",
  })(result);
  result = await operations.listCaseworkHistory({
    requestId: accepted.requestId, cursor: "history-cursor-1", limit: 12, as: "history",
  })(result);
  result = await operations.cancelCaseworkRequest({
    requestId: accepted.requestId, subject, idempotencyKey: "cancel-key-003",
    reason: "No longer required.", as: "cancelled",
  })(result);
  result = await operations.pollCaseworkResults({ cursor: "feed-cursor-1", limit: 25, as: "feed" })(result);

  assert.deepEqual(calls.filter(([method]) => method !== "constructor"), [
    ["createOrRecoverReviewRequest", "synthetic-requester-secret", "requester", "create-key-001", request, accepted.submissionDigest],
    ["reviewRequest", "synthetic-requester-secret", "requester", accepted.requestId],
    ["reviewResult", "synthetic-requester-secret", "requester", accepted],
    ["addReviewNote", "synthetic-requester-secret", "requester", accepted.requestId, "note-key-002", { audience: "requester", note: "Requester context." }],
    ["reviewHistory", "synthetic-requester-secret", "requester", accepted.requestId, { cursor: "history-cursor-1", limit: 12 }],
    ["cancelReviewRequest", "synthetic-requester-secret", "requester", accepted.requestId, "cancel-key-003", { subject, reason: "No longer required." }],
    ["reviewResults", "synthetic-requester-secret", "requester", { cursor: "feed-cursor-1", limit: 25 }],
  ]);
  assert.equal(result.configuration, initial.configuration);
  assert.equal(JSON.stringify(result.data).includes("synthetic-requester-secret"), false);
});

test("result lookup keeps pending, concealed and expired meanings distinct", async () => {
  for (const kind of ["pending", "concealed_or_unknown", "expired"]) {
    const { operations } = fakeOperations({
      reviewResult: () => ({ kind, value: null, traceId: `trace-${kind}` }),
    });
    const result = await operations.getCaseworkResult({ accepted })(state());
    assert.equal(result.data.caseworkResult.branch, kind);
    assert.equal(result.data.caseworkResult.value, null);
  }
});

test("cursor expiry is typed, redacted and never retried silently", async () => {
  let attempts = 0;
  const { operations } = fakeOperations({ reviewResults: () => {
    attempts += 1;
    throw new FakeCaseworkClientError({
      kind: "problem", code: "cursor.expired", status: 400,
      traceId: "trace-cursor-expired", detail: "secret-response-canary",
    });
  } });
  const result = await operations.pollCaseworkResults({ cursor: "expired", limit: 25 })(state());
  assert.equal(attempts, 1);
  assert.equal(result.data.caseworkTerminal.branch, "cursor_expired");
  assert.deepEqual(result.data.caseworkTerminal.recovery, {
    action: "restart_without_cursor", deduplicateBy: "eventId",
  });
  assert.equal(JSON.stringify(result).includes("secret-response-canary"), false);
});

test("invalid unified inputs fail before client construction", async () => {
  const { calls, operations } = fakeOperations();
  for (const execute of [
    operations.createCaseworkRequest({ request: [], idempotencyKey: "key", expectedSubmissionDigest: accepted.submissionDigest }),
    operations.getCaseworkResult({ accepted: [] }),
    operations.addCaseworkNote({ requestId: accepted.requestId, idempotencyKey: "key", audience: "public", note: "x" }),
    operations.cancelCaseworkRequest({ requestId: accepted.requestId, subject: [], idempotencyKey: "key", reason: "x" }),
  ]) {
    const result = await execute(state());
    assert.equal(Object.values(result.data).at(-1).branch, "invalid_request");
  }
  assert.equal(calls.length, 0);
});

test("source task inspection and approval preserve source-profile authority", async () => {
  const { calls, operations } = fakeOperations();
  await operations.listCaseworkWorkItems({ sourceProfile: "reviewer", query: { view: "my_teams" } })(state());
  await operations.approveCaseworkTaskGrant({
    sourceProfile: "reviewer", itemId: accepted.requestId, expectedRevision: 7,
    idempotencyKey: "grant-42", templateId: "verify", templateVersion: "1",
  })(state());
  assert.deepEqual(calls.filter(([method]) => method !== "constructor"), [
    ["listWorkItems", "synthetic-requester-secret", "requester", "reviewer", { view: "my_teams" }],
    ["approveTaskGrant", "synthetic-requester-secret", "requester", "reviewer", accepted.requestId, 7, "grant-42", { templateId: "verify", templateVersion: "1" }],
  ]);
});

test("package pins the maintained client contract", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.dependencies["@registrystack/client"], "0.32.0");
});
