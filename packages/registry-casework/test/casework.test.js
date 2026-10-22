import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import compile from "@openfn/compiler";
import run from "@openfn/runtime";
import * as adaptor from "../src/index.js";
import {
  CaseworkCallerError,
  createCaseworkOperations,
} from "../src/operations.js";

const require = createRequire(import.meta.url);

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const RESULT_ID = "10000000-0000-4000-8000-000000000001";
const NOTE_EVENT_ID = "20000000-0000-4000-8000-000000000001";
const RESULT_EVENT_ID = "30000000-0000-4000-8000-000000000001";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const TRACEPARENT = `00-${TRACE_ID}-0123456789abcdef-01`;
const subject = {
  source: "payments",
  type: "batch",
  id: "batch-0042",
  version: "7",
  digest: `sha256:${"a".repeat(64)}`,
};
const request = {
  kind: "batch-validation",
  subject,
  requesterReference: "batch-0042",
  context: {
    strategy: "submitted",
    snapshot: { summary: "Review batch 42" },
  },
  resultConstraints: { acceptedCount: { minimum: 0 } },
};
const accepted = {
  requestId: REQUEST_ID,
  subject,
  policy: {
    id: "batch-validation",
    version: "1",
    digest: `sha256:${"b".repeat(64)}`,
  },
  submissionDigest: `sha256:${"c".repeat(64)}`,
};
const cancellation = { subject, reason: "The batch was withdrawn." };

class FakeCaseworkClientError extends Error {
  constructor(fields) {
    super(fields.message ?? "synthetic client failure");
    Object.assign(this, fields);
  }
}

function fakeOperations(handlers = {}) {
  const calls = [];
  class FakeCaseworkClient {
    constructor(configuration) {
      calls.push(["constructor", configuration]);
    }
  }
  for (const method of [
    "createOrRecoverReviewRequest",
    "reviewRequest",
    "reviewResult",
    "reviewResults",
    "addReviewNote",
    "reviewHistory",
    "cancelReviewRequest",
    "listWorkItems",
    "getWorkItem",
    "previewTaskTemplates",
    "listTaskGrants",
    "approveTaskGrant",
    "revokeTaskGrant",
    "taskGrantStatus",
  ]) {
    FakeCaseworkClient.prototype[method] = async function (...args) {
      calls.push([method, ...args]);
      if (handlers[method]) return handlers[method](...args);
      return {
        kind: method === "reviewResult" ? "available" : "complete",
        value: { method, items: [] },
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

function state(baseUrl = "https://casework.example.test/tenant") {
  return {
    configuration: {
      casework: {
        baseUrl,
        token: "synthetic-requester-secret",
        profile: "requester",
        maximumResponseBytes: 1_000_000,
      },
    },
    data: { input: "retained" },
  };
}

test("adaptor exports current Requester review and bounded task operations", () => {
  assert.equal(typeof adaptor.fn, "function");
  assert.equal(typeof adaptor.execute, "function");
  for (const operation of [
    "createOrRecoverReviewRequest",
    "getReviewRequest",
    "getReviewResult",
    "listReviewResults",
    "addReviewNote",
    "listReviewHistory",
    "cancelReviewRequest",
    "listCaseworkWorkItems",
    "getCaseworkWorkItem",
    "previewCaseworkTaskTemplates",
    "listCaseworkTaskGrants",
    "approveCaseworkTaskGrant",
    "revokeCaseworkTaskGrant",
    "caseworkTaskGrantStatus",
  ]) {
    assert.equal(typeof adaptor[operation], "function");
  }
  for (const removedOrStaff of [
    "createCaseworkItem",
    "getCaseworkItem",
    "listCaseworkNotes",
    "pollCaseworkResults",
    "claimReviewTask",
    "decideReviewTask",
    "listWorkItems",
    "taskAssertion",
  ]) {
    assert.equal(removedOrStaff in adaptor, false);
  }
  assert.throws(() => createCaseworkOperations(), CaseworkCallerError);
});

test("Requester operations preserve exact native arguments and caller-owned bindings", async () => {
  const { calls, operations } = fakeOperations();
  const initial = state();
  let result = await operations.createOrRecoverReviewRequest({
    request,
    expectedSubmissionDigest: accepted.submissionDigest,
    idempotencyKey: "create-key-001",
    as: "created",
  })(initial);
  result = await operations.getReviewRequest({
    requestId: REQUEST_ID,
    as: "read",
  })(result);
  result = await operations.getReviewResult({ accepted, as: "result" })(result);
  result = await operations.addReviewNote({
    requestId: REQUEST_ID,
    idempotencyKey: "note-key-002",
    note: "Requester context.",
    as: "noted",
  })(result);
  result = await operations.listReviewHistory({
    requestId: REQUEST_ID,
    cursor: NOTE_EVENT_ID,
    limit: 12,
    as: "history",
  })(result);
  result = await operations.cancelReviewRequest({
    accepted,
    idempotencyKey: "cancel-key-003",
    cancellation,
    as: "cancelled",
  })(result);
  result = await operations.listReviewResults({
    cursor: RESULT_EVENT_ID,
    limit: 25,
    as: "feed",
  })(result);

  assert.deepEqual(calls.filter(([method]) => method !== "constructor"), [
    [
      "createOrRecoverReviewRequest",
      "synthetic-requester-secret",
      "requester",
      "create-key-001",
      request,
      accepted.submissionDigest,
    ],
    ["reviewRequest", "synthetic-requester-secret", "requester", REQUEST_ID],
    ["reviewResult", "synthetic-requester-secret", "requester", accepted],
    [
      "addReviewNote",
      "synthetic-requester-secret",
      "requester",
      REQUEST_ID,
      "note-key-002",
      { audience: "requester", note: "Requester context." },
    ],
    [
      "reviewHistory",
      "synthetic-requester-secret",
      "requester",
      REQUEST_ID,
      { cursor: NOTE_EVENT_ID, limit: 12 },
    ],
    [
      "cancelReviewRequest",
      "synthetic-requester-secret",
      "requester",
      accepted,
      "cancel-key-003",
      cancellation,
    ],
    [
      "reviewResults",
      "synthetic-requester-secret",
      "requester",
      { cursor: RESULT_EVENT_ID, limit: 25 },
    ],
  ]);
  assert.equal(result.configuration, initial.configuration);
  assert.equal(result.data.input, "retained");
  assert.equal(result.data.feed.branch, "succeeded");
  assert.equal(JSON.stringify(result.data).includes("synthetic-requester-secret"), false);
});

test("result lookup keeps all native availability states distinct", async () => {
  for (const kind of [
    "available",
    "pending",
    "concealed_or_unknown",
    "expired",
  ]) {
    const value = kind === "available" ? { status: "approved" } : null;
    const { operations } = fakeOperations({
      reviewResult: () => ({ kind, value, traceId: `trace-${kind}` }),
    });
    const result = await operations.getReviewResult({ accepted })(state());
    assert.deepEqual(result.data.reviewResult, {
      branch: kind,
      value,
      traceId: `trace-${kind}`,
    });
  }
});

test("cursor expiry is typed, redacted, and never retried silently", async () => {
  for (const [name, execute] of [
    ["reviewResults", (operations) => operations.listReviewResults({ cursor: RESULT_EVENT_ID })],
    [
      "reviewHistory",
      (operations) =>
        operations.listReviewHistory({ requestId: REQUEST_ID, cursor: NOTE_EVENT_ID }),
    ],
  ]) {
    let attempts = 0;
    const { operations } = fakeOperations({
      [name]: () => {
        attempts += 1;
        throw new FakeCaseworkClientError({
          kind: "problem",
          code: "cursor.expired",
          status: 400,
          traceId: "trace-cursor-expired",
          detail: "secret-response-canary",
        });
      },
    });
    const result = await execute(operations)(state());
    const outcome = Object.values(result.data).at(-1);
    assert.equal(attempts, 1);
    assert.equal(outcome.branch, "cursor_expired");
    assert.deepEqual(outcome.recovery, {
      action: "restart_without_cursor",
      deduplicateBy: "eventId",
    });
    assert.equal(JSON.stringify(result).includes("secret-response-canary"), false);
  }
});

test("caller mistakes fail before client construction", async () => {
  const { calls, operations } = fakeOperations();
  for (const execute of [
    operations.createOrRecoverReviewRequest({
      request: [],
      expectedSubmissionDigest: accepted.submissionDigest,
      idempotencyKey: "key",
    }),
    operations.getReviewResult({ accepted: [] }),
    operations.addReviewNote({ requestId: REQUEST_ID, idempotencyKey: "key" }),
    operations.cancelReviewRequest({
      accepted,
      idempotencyKey: "key",
      cancellation: [],
    }),
  ]) {
    const result = await execute(state());
    assert.equal(Object.values(result.data).at(-1).branch, "invalid_request");
  }
  assert.equal(calls.length, 0);
});

test("typed conflicts expose only bounded diagnostics", async () => {
  const { operations } = fakeOperations({
    cancelReviewRequest: () => {
      throw new FakeCaseworkClientError({
        kind: "problem",
        code: "idempotency.key-reused",
        status: 409,
        detail: "secret-cancellation-canary",
        message: "secret-message-canary",
        validation: { path: "/reason", reason: "text_invalid" },
      });
    },
  });
  const result = await operations.cancelReviewRequest({
    accepted,
    idempotencyKey: "same-key-is-preserved",
    cancellation,
  })(state());
  assert.deepEqual(result.data.reviewCancellation, {
    branch: "conflict",
    problem: {
      code: "idempotency.key-reused",
      status: 409,
      retryable: false,
    },
    validation: { path: "/reason", reason: "text_invalid" },
  });
  assert.equal(JSON.stringify(result).includes("secret-cancellation-canary"), false);
  assert.equal(JSON.stringify(result).includes("secret-message-canary"), false);
});

test("installed native client completes the Requester review loop over HTTP", async () => {
  let cancelled = false;
  const note = "Requester context.";
  const result = {
    resultId: RESULT_ID,
    ...accepted,
    status: "cancelled",
    completedAt: "2026-09-20T00:00:00Z",
    availableUntil: "2026-10-20T00:00:00Z",
  };
  const noteEntry = {
    eventId: NOTE_EVENT_ID,
    requestId: REQUEST_ID,
    kind: "note",
    detail: { audience: "requester", note },
    occurredAt: "2026-09-19T00:00:00Z",
  };
  const stub = await startServer((observed, response) => {
    const url = new URL(observed.url, "http://casework.test");
    if (observed.method === "POST" && url.pathname === "/tenant/v1/review-requests") {
      response.statusCode = 201;
      return response.end(JSON.stringify(accepted));
    }
    if (
      observed.method === "GET" &&
      url.pathname === `/tenant/v1/review-requests/${REQUEST_ID}`
    ) {
      return response.end(JSON.stringify({
        ...accepted,
        requesterReference: request.requesterReference,
        lifecycle: "reviewing",
        activeStage: "review",
        createdAt: "2026-09-19T00:00:00Z",
        updatedAt: "2026-09-19T00:00:00Z",
      }));
    }
    if (
      observed.method === "GET" &&
      url.pathname === `/tenant/v1/review-requests/${REQUEST_ID}/result`
    ) {
      if (!cancelled) {
        response.statusCode = 202;
        response.removeHeader("content-type");
        return response.end();
      }
      return response.end(JSON.stringify(result));
    }
    if (
      observed.method === "POST" &&
      url.pathname === `/tenant/v1/review-requests/${REQUEST_ID}/notes`
    ) {
      return response.end(JSON.stringify(noteEntry));
    }
    if (
      observed.method === "GET" &&
      url.pathname === `/tenant/v1/review-requests/${REQUEST_ID}/history`
    ) {
      return response.end(JSON.stringify({ items: [noteEntry] }));
    }
    if (
      observed.method === "POST" &&
      url.pathname === `/tenant/v1/review-requests/${REQUEST_ID}/cancel`
    ) {
      cancelled = true;
      return response.end(JSON.stringify({ outcome: "cancelled", result }));
    }
    if (observed.method === "GET" && url.pathname === "/tenant/v1/review-results") {
      return response.end(JSON.stringify({
        items: [{
          eventId: RESULT_EVENT_ID,
          requestId: REQUEST_ID,
          resultId: RESULT_ID,
          completedAt: result.completedAt,
        }],
      }));
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    let workflow = state(stub.baseUrl);
    const crossRealmRequest = vm.runInNewContext(`(${JSON.stringify(request)})`);
    workflow = await adaptor.createOrRecoverReviewRequest({
      request: crossRealmRequest,
      expectedSubmissionDigest: accepted.submissionDigest,
      idempotencyKey: "create-key-native-001",
      as: "accepted",
    })(workflow);
    assert.equal(workflow.data.accepted.branch, "succeeded");
    assert.deepEqual(workflow.data.accepted.value, accepted);
    const crossRealmAccepted = vm.runInNewContext(`(${JSON.stringify(accepted)})`);
    const crossRealmCancellation = vm.runInNewContext(
      `(${JSON.stringify(cancellation)})`,
    );

    workflow = await adaptor.getReviewRequest({ requestId: REQUEST_ID, as: "read" })(workflow);
    assert.equal(workflow.data.read.value.lifecycle, "reviewing");
    workflow = await adaptor.getReviewResult({
      accepted: crossRealmAccepted,
      as: "pending",
    })(workflow);
    assert.equal(workflow.data.pending.branch, "pending");
    workflow = await adaptor.addReviewNote({
      requestId: REQUEST_ID,
      idempotencyKey: "note-key-native-002",
      note,
      as: "noted",
    })(workflow);
    assert.equal(workflow.data.noted.value.eventId, NOTE_EVENT_ID);
    workflow = await adaptor.listReviewHistory({
      requestId: REQUEST_ID,
      limit: 25,
      as: "history",
    })(workflow);
    assert.deepEqual(workflow.data.history.value.items, [noteEntry]);
    workflow = await adaptor.cancelReviewRequest({
      accepted: crossRealmAccepted,
      idempotencyKey: "cancel-key-native-003",
      cancellation: crossRealmCancellation,
      as: "cancelled",
    })(workflow);
    assert.equal(workflow.data.cancelled.value.outcome, "cancelled");
    workflow = await adaptor.listReviewResults({ limit: 25, as: "feed" })(workflow);
    assert.equal(workflow.data.feed.value.items[0].eventId, RESULT_EVENT_ID);
    workflow = await adaptor.getReviewResult({
      accepted: crossRealmAccepted,
      as: "available",
    })(workflow);
    assert.equal(workflow.data.available.branch, "available");
    assert.deepEqual(workflow.data.available.value, result);

    const { code } = compile(
      readFileSync(new URL("../jobs/create-request.js", import.meta.url), "utf8"),
    );
    const compiled = await run(
      {
        workflow: {
          steps: [{ id: "casework", expression: code }],
          start: "casework",
        },
        options: { start: "casework" },
      },
      {
        ...state(stub.baseUrl),
        data: {
          caseworkReviewRequest: request,
          caseworkSubmissionDigest: accepted.submissionDigest,
          createIdempotencyKey: "compiled-create-key-004",
        },
      },
      {
        linker: {
          modules: {
            "@openfn/language-common": {
              path: fileURLToPath(
                new URL(
                  "../../../node_modules/@openfn/language-common",
                  import.meta.url,
                ),
              ),
            },
            "../src/index.js": {
              path: fileURLToPath(new URL("..", import.meta.url)),
            },
          },
          cacheKey: `casework-create-${process.pid}`,
        },
      },
    );
    assert.equal(compiled.errors, undefined, JSON.stringify(compiled.errors));
    assert.equal(compiled.data.acceptedReviewRequest.branch, "succeeded");
    assert.deepEqual(compiled.data.acceptedReviewRequest.value, accepted);
    assert.equal("configuration" in compiled, false);
    assert.equal(JSON.stringify(compiled).includes("synthetic-requester-secret"), false);

    assert.equal(stub.requests.length, 9);
    for (const observed of stub.requests) {
      assert.equal(observed.headers.authorization, "Bearer synthetic-requester-secret");
      assert.equal(observed.headers["registry-casework-profile"], "requester");
      assert.equal(observed.headers["registry-source-profile"], undefined);
    }
    assert.deepEqual(JSON.parse(stub.requests[0].body), request);
    assert.equal(stub.requests[0].headers["idempotency-key"], "create-key-native-001");
    const noteRequest = stub.requests.find(({ url }) => url.endsWith("/notes"));
    assert.deepEqual(JSON.parse(noteRequest.body), { audience: "requester", note });
    assert.equal(noteRequest.headers["idempotency-key"], "note-key-native-002");
    const cancelRequest = stub.requests.find(({ url }) => url.endsWith("/cancel"));
    assert.deepEqual(JSON.parse(cancelRequest.body), cancellation);
    assert.equal(cancelRequest.headers["idempotency-key"], "cancel-key-native-003");
    const compiledRequest = stub.requests.find(
      ({ headers }) => headers["idempotency-key"] === "compiled-create-key-004",
    );
    assert.deepEqual(JSON.parse(compiledRequest.body), request);
  } finally {
    await stub.close();
  }
});

test("VM normalization refuses unsafe graphs before the native client sends", () => {
  const { CaseworkClient, CaseworkClientError } = require("../src/native.cjs");
  const client = new CaseworkClient({ baseUrl: "http://127.0.0.1:1" });
  let accessorRead = false;
  const accessor = {};
  Object.defineProperty(accessor, "kind", {
    enumerable: true,
    get() {
      accessorRead = true;
      throw new Error("secret-accessor-canary");
    },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  for (const invalidRequest of [accessor, cyclic, new Date(), new Proxy({}, {})]) {
    assert.throws(
      () => client.createOrRecoverReviewRequest(
        "synthetic-token",
        "requester",
        "invalid-request-key",
        invalidRequest,
        accepted.submissionDigest,
      ),
      (error) => error instanceof CaseworkClientError && error.kind === "invalid_request",
    );
  }
  assert.equal(accessorRead, false);
});

test("package pins the published native client and authentication schema", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const schema = JSON.parse(
    readFileSync(new URL("../configuration-schema.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.dependencies["@registrystack/client"], "0.38.0");
  assert.deepEqual(schema.required, ["baseUrl", "profile"]);
  assert.deepEqual(schema.oneOf, [
    { required: ["token"] },
    { required: ["authorization"] },
  ]);
  assert.equal(schema.properties.token.writeOnly, true);
  assert.equal(schema.properties.maximumResponseBytes.type, "integer");
  assert.equal(schema.properties.maxResponseBytes, undefined);
});

test("source task inspection and grants preserve held authority", async () => {
  const { calls, operations } = fakeOperations();
  let current = state();
  current = await operations.listCaseworkWorkItems({
    sourceProfile: "reviewer",
    query: { view: "my_teams", limit: 20 },
  })(current);
  current = await operations.getCaseworkWorkItem({
    sourceProfile: "reviewer",
    itemId: REQUEST_ID,
  })(current);
  current = await operations.previewCaseworkTaskTemplates({
    sourceProfile: "reviewer",
    itemId: REQUEST_ID,
  })(current);
  current = await operations.listCaseworkTaskGrants({
    sourceProfile: "reviewer",
    itemId: REQUEST_ID,
  })(current);
  current = await operations.approveCaseworkTaskGrant({
    sourceProfile: "reviewer",
    itemId: REQUEST_ID,
    expectedRevision: 7,
    idempotencyKey: "approval-key-004",
    templateId: "verify",
    templateVersion: "1",
  })(current);
  current = await operations.revokeCaseworkTaskGrant({
    sourceProfile: "reviewer",
    itemId: REQUEST_ID,
    grantId: "grant-1",
  })(current);
  current = await operations.caseworkTaskGrantStatus({ grantId: "grant-1" })(current);

  assert.deepEqual(calls.filter(([method]) => method !== "constructor"), [
    ["listWorkItems", "synthetic-requester-secret", "requester", "reviewer", { view: "my_teams", limit: 20 }],
    ["getWorkItem", "synthetic-requester-secret", "requester", "reviewer", REQUEST_ID],
    ["previewTaskTemplates", "synthetic-requester-secret", "requester", "reviewer", REQUEST_ID],
    ["listTaskGrants", "synthetic-requester-secret", "requester", "reviewer", REQUEST_ID],
    ["approveTaskGrant", "synthetic-requester-secret", "requester", "reviewer", REQUEST_ID, 7, "approval-key-004", { templateId: "verify", templateVersion: "1" }],
    ["revokeTaskGrant", "synthetic-requester-secret", "requester", "reviewer", REQUEST_ID, "grant-1"],
    ["taskGrantStatus", "synthetic-requester-secret", "grant-1"],
  ]);
  assert.equal(current.data.caseworkTaskStatus.branch, "succeeded");
  assert.equal("taskAssertion" in operations, false);
});

test("private-key JWT authentication validates the operation before minting", async () => {
  const calls = [];
  class PrivateKeyJwt {
    constructor(configuration) {
      calls.push(["provider", configuration]);
    }
    async bearerToken() {
      calls.push(["mint"]);
      return "short-lived-token";
    }
  }
  class CaseworkClient {
    constructor(configuration) {
      calls.push(["client", configuration]);
    }
    async reviewRequest(...args) {
      calls.push(["read", ...args]);
      return { kind: "complete", value: { requestId: REQUEST_ID } };
    }
  }
  const operations = createCaseworkOperations(() => ({
    CaseworkClient,
    CaseworkClientError: FakeCaseworkClientError,
    PrivateKeyJwt,
  }));
  const configured = state();
  delete configured.configuration.casework.token;
  configured.configuration.casework.authorization = {
    privateKeyJwt: {
      tokenEndpoint: "https://issuer.invalid/token",
      clientId: "worker",
      clientKey: { kty: "EC", kid: "test", alg: "ES256" },
      resource: "urn:casework",
      scopes: ["casework:request"],
    },
  };

  const invalid = await operations.getReviewRequest({})(configured);
  assert.equal(invalid.data.reviewRequest.branch, "invalid_request");
  assert.equal(calls.length, 0);

  const result = await operations.getReviewRequest({ requestId: REQUEST_ID })(configured);
  assert.equal(result.data.reviewRequest.branch, "succeeded");
  assert.deepEqual(calls.at(-1), [
    "read",
    "short-lived-token",
    "requester",
    REQUEST_ID,
  ]);
  assert.equal(JSON.stringify(result.data).includes("short-lived-token"), false);

  configured.configuration.casework.token = "ambiguous";
  const ambiguous = await operations.getReviewRequest({ requestId: REQUEST_ID })(configured);
  assert.equal(ambiguous.data.reviewRequest.problem.code, "configuration.authentication");
});

test("native token provider failures are typed and redacted", async () => {
  class ProviderError extends Error {
    constructor() {
      super("secret-token-response");
      this.kind = "token";
      this.tokenKind = "transport";
    }
  }
  class PrivateKeyJwt {
    async bearerToken() {
      throw new ProviderError();
    }
  }
  const operations = createCaseworkOperations(() => ({
    CaseworkClient: class {},
    CaseworkClientError: FakeCaseworkClientError,
    ProviderError,
    PrivateKeyJwt,
  }));
  const configured = state();
  delete configured.configuration.casework.token;
  configured.configuration.casework.authorization = {
    privateKeyJwt: { tokenEndpoint: "https://issuer.invalid/token" },
  };
  const result = await operations.getReviewRequest({ requestId: REQUEST_ID })(configured);
  assert.deepEqual(result.data.reviewRequest, {
    branch: "retryable_infrastructure",
    problem: { code: "casework.token", retryable: true },
  });
  assert.equal(JSON.stringify(result.data).includes("secret-token-response"), false);
});

test("oversized credentials are rejected without construction or disclosure", async () => {
  const { calls, operations } = fakeOperations();
  const configured = state();
  configured.configuration.casework.token = "secret-canary".repeat(2_000);
  const result = await operations.getReviewRequest({ requestId: REQUEST_ID })(configured);
  assert.equal(result.data.reviewRequest.branch, "invalid_request");
  assert.equal(
    result.data.reviewRequest.problem.code,
    "configuration.casework.token.too_long",
  );
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(result.data).includes("secret-canary"), false);
});

test("Casework uses only its closed namespace and forwards the canonical response bound", async () => {
  const { calls, operations } = fakeOperations();
  const configured = state();
  configured.configuration.unrelated = { enabled: true };
  const result = await operations.getReviewRequest({ requestId: REQUEST_ID })(configured);
  assert.equal(result.data.reviewRequest.branch, "succeeded");
  assert.deepEqual(calls.find(([method]) => method === "constructor")?.[1], {
    baseUrl: configured.configuration.casework.baseUrl,
    maxResponseBytes: 1_000_000,
  });

  configured.configuration.casework.maxResponseByes = 1234;
  const refused = await operations.getReviewRequest({ requestId: REQUEST_ID })(configured);
  assert.equal(refused.data.reviewRequest.branch, "invalid_request");
  assert.equal(refused.data.reviewRequest.problem.code, "configuration.casework.unknown_field");
  assert.equal(calls.filter(([method]) => method === "constructor").length, 1);
});

test("Casework requires an explicit namespace when other product settings exist", async () => {
  const { calls, operations } = fakeOperations();
  const configured = state();
  configured.configuration.other = configured.configuration.casework;
  delete configured.configuration.casework;
  const result = await operations.getReviewRequest({ requestId: REQUEST_ID })(configured);
  assert.equal(result.data.reviewRequest.branch, "invalid_request");
  assert.equal(result.data.reviewRequest.problem.code, "configuration.invalid");
  assert.equal(calls.length, 0);
});

async function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (requestMessage, response) => {
    let body = "";
    for await (const chunk of requestMessage) body += chunk;
    const observed = {
      method: requestMessage.method,
      url: requestMessage.url,
      headers: requestMessage.headers,
      body,
    };
    requests.push(observed);
    response.setHeader("content-type", "application/json");
    response.setHeader("traceparent", TRACEPARENT);
    response.setHeader("cache-control", "no-store");
    response.setHeader("vary", "authorization, accept");
    handler(observed, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/tenant`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
