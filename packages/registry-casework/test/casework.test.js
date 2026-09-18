import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import * as adaptor from "../src/index.js";
import {
  CaseworkCallerError,
  createCaseworkOperations,
} from "../src/operations.js";

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
    "createHostedItem",
    "getHostedItem",
    "addHostedNote",
    "requesterHostedNotes",
    "cancelHostedItem",
    "hostedTerminalItems",
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
        kind: "complete",
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
    configuration: {
      casework: {
        baseUrl: "https://casework.example.test/tenant",
        token: "synthetic-requester-secret",
        profile: "requester",
        maxResponseBytes: 1_000_000,
      },
    },
    data: { input: "retained" },
  };
}

test("adaptor reexports common operations used by Lightning autoimports", () => {
  assert.equal(typeof adaptor.fn, "function");
  assert.equal(typeof adaptor.execute, "function");
  for (const operation of [
    "createCaseworkItem",
    "getCaseworkItem",
    "addCaseworkNote",
    "listCaseworkNotes",
    "cancelCaseworkItem",
    "pollCaseworkResults",
  ]) {
    assert.equal(typeof adaptor[operation], "function");
  }
  for (const forbidden of [
    "claimWorkItem",
    "releaseWorkItem",
    "decideWorkItem",
    "hostedAccountabilityRecord",
    "listWorkItems",
  ]) {
    assert.equal(forbidden in adaptor, false);
  }
  assert.throws(() => createCaseworkOperations(), CaseworkCallerError);
});

test("Requester operations preserve exact keys, revisions and maintained method shapes", async () => {
  const { calls, operations } = fakeOperations();
  const initial = state();
  let result = await operations.createCaseworkItem((current) => ({
    kind: "decision",
    requesterReference: "batch-0042",
    display: { summary: current.data.input },
    idempotencyKey: "create-key-exact-001",
    as: "created",
  }))(initial);
  result = await operations.getCaseworkItem({ itemId: "item-1", as: "read" })(result);
  result = await operations.addCaseworkNote({
    itemId: "item-1",
    expectedRevision: 7,
    idempotencyKey: "note-key-exact-002",
    note: "Requester context.",
    as: "noted",
  })(result);
  result = await operations.listCaseworkNotes({
    itemId: "item-1",
    cursor: "notes-cursor-1",
    limit: 12,
    as: "notes",
  })(result);
  result = await operations.cancelCaseworkItem({
    itemId: "item-1",
    expectedRevision: 8,
    idempotencyKey: "cancel-key-exact-003",
    reason: "No longer required.",
    as: "cancelled",
  })(result);
  result = await operations.pollCaseworkResults({
    cursor: "terminal-cursor-1",
    limit: 25,
    as: "terminal",
  })(result);

  assert.deepEqual(calls, [
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    [
      "createHostedItem",
      "synthetic-requester-secret",
      "requester",
      "create-key-exact-001",
      {
        kind: "decision",
        requesterReference: "batch-0042",
        display: { summary: "retained" },
      },
    ],
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    ["getHostedItem", "synthetic-requester-secret", "requester", "item-1"],
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    [
      "addHostedNote",
      "synthetic-requester-secret",
      "requester",
      "item-1",
      7,
      "note-key-exact-002",
      { note: "Requester context." },
    ],
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    [
      "requesterHostedNotes",
      "synthetic-requester-secret",
      "requester",
      "item-1",
      { cursor: "notes-cursor-1", limit: 12 },
    ],
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    [
      "cancelHostedItem",
      "synthetic-requester-secret",
      "requester",
      "item-1",
      8,
      "cancel-key-exact-003",
      { reason: "No longer required." },
    ],
    [
      "constructor",
      {
        baseUrl: "https://casework.example.test/tenant",
        maxResponseBytes: 1_000_000,
      },
    ],
    [
      "hostedTerminalItems",
      "synthetic-requester-secret",
      "requester",
      { cursor: "terminal-cursor-1", limit: 25 },
    ],
  ]);
  assert.equal(result.configuration, initial.configuration);
  assert.equal(result.data.input, "retained");
  assert.equal(result.data.terminal.branch, "succeeded");
  assert.equal(JSON.stringify(result.data).includes("synthetic-requester-secret"), false);
});

test("VM-authored nested display and query reach native operations as local JSON", async () => {
  const { calls, operations } = fakeOperations();
  const display = vm.runInNewContext('({ summary: "Reviewed", nested: { count: 2 } })');
  const query = vm.runInNewContext('({ view: "my_teams", filters: { state: "open" } })');
  await operations.createCaseworkItem({ kind: "example", requesterReference: "source-1",
    display, idempotencyKey: "effect-1" })(state());
  await operations.listCaseworkWorkItems({ sourceProfile: "reviewer", query })(state());
  const createdDisplay = calls.find(([method]) => method === "createHostedItem")[4].display;
  const listedQuery = calls.find(([method]) => method === "listWorkItems")[4];
  assert.deepEqual(createdDisplay, { summary: "Reviewed", nested: { count: 2 } });
  assert.equal(Object.getPrototypeOf(createdDisplay.nested), Object.prototype);
  assert.deepEqual(listedQuery, { view: "my_teams", filters: { state: "open" } });
  assert.equal(Object.getPrototypeOf(listedQuery.filters), Object.prototype);
  const refused = await operations.createCaseworkItem({ kind: "example", requesterReference: "source-1",
    display: new Proxy({}, {}), idempotencyKey: "effect-1" })(state());
  assert.equal(refused.data.caseworkCreated.branch, "invalid_request");
});

test("createCaseworkItem forwards resultConstraints verbatim inside the create request", async () => {
  const { calls, operations } = fakeOperations();
  const resultConstraints = vm.runInNewContext(
    '({ batchStatus: { oneOf: [{ const: "valid", title: "All rows valid" }] }, acceptedCount: { minimum: 0, maximum: 412 } })',
  );
  const result = await operations.createCaseworkItem({
    kind: "batch-validation",
    requesterReference: "batch-0042",
    display: { summary: "Batch 42" },
    resultConstraints,
    idempotencyKey: "create-key-constraints-001",
    as: "created",
  })(state());
  assert.equal(result.data.created.branch, "succeeded");
  const request = calls.find(([method]) => method === "createHostedItem")[4];
  assert.deepEqual(request, {
    kind: "batch-validation",
    requesterReference: "batch-0042",
    display: { summary: "Batch 42" },
    resultConstraints: {
      batchStatus: { oneOf: [{ const: "valid", title: "All rows valid" }] },
      acceptedCount: { minimum: 0, maximum: 412 },
    },
  });
  assert.equal(Object.getPrototypeOf(request.resultConstraints), Object.prototype);
  assert.equal(
    Object.getPrototypeOf(request.resultConstraints.batchStatus),
    Object.prototype,
  );
});

test("createCaseworkItem without resultConstraints sends exactly the three closed fields", async () => {
  const { calls, operations } = fakeOperations();
  const result = await operations.createCaseworkItem({
    kind: "decision",
    requesterReference: "batch-0043",
    display: { summary: "Batch 43" },
    idempotencyKey: "create-key-constraints-002",
  })(state());
  assert.equal(result.data.caseworkCreated.branch, "succeeded");
  const request = calls.find(([method]) => method === "createHostedItem")[4];
  assert.deepEqual(request, {
    kind: "decision",
    requesterReference: "batch-0043",
    display: { summary: "Batch 43" },
  });
  assert.equal("resultConstraints" in request, false);
});

test("a non-object resultConstraints fails pre-flight and makes no client call", async () => {
  const { calls, operations } = fakeOperations();
  const before = calls.length;
  for (const resultConstraints of ["batchStatus:valid", [{ oneOf: [{ const: "valid" }] }]]) {
    const result = await operations.createCaseworkItem({
      kind: "batch-validation",
      requesterReference: "batch-0042",
      display: { summary: "Batch 42" },
      resultConstraints,
      idempotencyKey: "create-key-constraints-003",
    })(state());
    assert.equal(result.data.caseworkCreated.branch, "invalid_request");
    assert.equal(
      result.data.caseworkCreated.problem.code,
      "resultConstraints.object_required",
    );
  }
  assert.equal(calls.length, before);
});

test("terminal results surface completed items with and without a structured result", async () => {
  const completed = {
    eventId: "event-with-result",
    state: "completed",
    outcome: "confirmed",
    actorRef: "actor_staff-1",
    result: { batchStatus: "partial", acceptedCount: 400 },
  };
  const withResult = fakeOperations({
    hostedTerminalItems: () => ({
      kind: "complete",
      value: { items: [completed], status: "complete" },
    }),
  });
  const surfaced = await withResult.operations.pollCaseworkResults({ limit: 25 })(
    state(),
  );
  assert.equal(surfaced.data.caseworkTerminal.branch, "succeeded");
  assert.deepEqual(surfaced.data.caseworkTerminal.value.items[0], completed);
  assert.deepEqual(surfaced.data.caseworkTerminal.value.items[0].result, {
    batchStatus: "partial",
    acceptedCount: 400,
  });

  const withoutResult = { ...completed };
  delete withoutResult.result;
  const absent = fakeOperations({
    hostedTerminalItems: () => ({
      kind: "complete",
      value: { items: [withoutResult], status: "complete" },
    }),
  });
  const tolerated = await absent.operations.pollCaseworkResults({ limit: 25 })(
    state(),
  );
  assert.equal(tolerated.data.caseworkTerminal.branch, "succeeded");
  assert.deepEqual(tolerated.data.caseworkTerminal.value.items[0], withoutResult);
  assert.equal("result" in tolerated.data.caseworkTerminal.value.items[0], false);
});

test("terminal cursor expiry is typed, redacted and never retried silently", async () => {
  let attempts = 0;
  const { operations } = fakeOperations({
    hostedTerminalItems: (_token, _profile, query) => {
      attempts += 1;
      if (query.cursor) {
        throw new FakeCaseworkClientError({
          kind: "problem",
          code: "cursor.expired",
          status: 400,
          traceId: "trace-cursor-expired",
          detail: "secret-response-canary",
        });
      }
      return {
        kind: "complete",
        value: { items: [{ eventId: "event-1" }], status: "complete" },
        traceId: "trace-restarted",
      };
    },
  });

  let result = await operations.pollCaseworkResults({
    cursor: "expired-cursor",
    limit: 25,
  })(state());
  assert.equal(attempts, 1);
  assert.deepEqual(result.data.caseworkTerminal, {
    branch: "cursor_expired",
    problem: {
      code: "cursor.expired",
      status: 400,
      retryable: false,
    },
    traceId: "trace-cursor-expired",
    recovery: {
      action: "restart_without_cursor",
      deduplicateBy: "eventId",
    },
  });
  assert.equal(JSON.stringify(result).includes("secret-response-canary"), false);

  result = await operations.pollCaseworkResults({ limit: 25, as: "restarted" })(
    result,
  );
  assert.equal(attempts, 2);
  assert.equal(result.data.restarted.branch, "succeeded");
  assert.equal(result.data.restarted.value.items[0].eventId, "event-1");
});

test("note cursor recovery names noteId and caller mistakes make no client call", async () => {
  let noteCalls = 0;
  const { calls, operations } = fakeOperations({
    requesterHostedNotes: () => {
      noteCalls += 1;
      throw new FakeCaseworkClientError({
        kind: "problem",
        code: "cursor.expired",
        status: 400,
      });
    },
  });
  const expired = await operations.listCaseworkNotes({
    itemId: "item-1",
    cursor: "expired-notes",
  })(state());
  assert.equal(noteCalls, 1);
  assert.equal(expired.data.caseworkNotes.recovery.deduplicateBy, "noteId");

  const before = calls.length;
  const missingKey = await operations.createCaseworkItem({
    kind: "decision",
    requesterReference: "batch-1",
    display: {},
  })(state());
  assert.equal(missingKey.data.caseworkCreated.branch, "invalid_request");
  assert.equal(calls.length, before);
});

test("typed conflicts and validation expose only bounded diagnostics", async () => {
  const { operations } = fakeOperations({
    cancelHostedItem: () => {
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
  const result = await operations.cancelCaseworkItem({
    itemId: "item-1",
    expectedRevision: 4,
    idempotencyKey: "same-key-is-preserved",
    reason: "Stop.",
  })(state());
  assert.deepEqual(result.data.caseworkCancellation, {
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

test("server constraint diagnostics pass through the bounded validation allowlist", async () => {
  for (const reason of [
    "result_not_declared",
    "result_required",
    "field_not_declared",
    "constraint_invalid",
    "constraint_violated",
  ]) {
    const { operations } = fakeOperations({
      getHostedItem: () => {
        throw new FakeCaseworkClientError({
          kind: "problem",
          code: "casework.validation",
          status: 422,
          validation: { path: "/batchStatus", reason },
        });
      },
    });
    const result = await operations.getCaseworkItem({ itemId: "item-1" })(state());
    assert.equal(result.data.caseworkItem.branch, "invalid_request");
    assert.deepEqual(result.data.caseworkItem.validation, {
      path: "/batchStatus",
      reason,
    });
  }
});

test("package pins the published client contract", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const schema = JSON.parse(
    readFileSync(new URL("../configuration-schema.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.dependencies["@registrystack/client"], "0.32.0");
  assert.deepEqual(schema.required, ["baseUrl", "profile"]);
  assert.equal(schema.properties.token.writeOnly, true);
});

test("oversized credentials are rejected without construction or disclosure", async () => {
  const { calls, operations } = fakeOperations();
  const configured = state();
  configured.configuration.casework.token = "secret-canary".repeat(2_000);
  const result = await operations.getCaseworkItem({ itemId: "item-1" })(configured);
  assert.equal(result.data.caseworkItem.branch, "invalid_request");
  assert.equal(result.data.caseworkItem.problem.code, "configuration.casework.token.too_long");
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(result.data).includes("secret-canary"), false);
});

test("source task inspection and approval use the held profile, revision and key", async () => {
  const { calls, operations } = fakeOperations();
  let current = state();
  current = await operations.listCaseworkWorkItems({ sourceProfile: "reviewer", query: { view: "my_teams", limit: 20 } })(current);
  current = await operations.getCaseworkWorkItem({ sourceProfile: "reviewer", itemId: "item-1" })(current);
  current = await operations.previewCaseworkTaskTemplates({ sourceProfile: "reviewer", itemId: "item-1" })(current);
  current = await operations.listCaseworkTaskGrants({ sourceProfile: "reviewer", itemId: "item-1" })(current);
  current = await operations.approveCaseworkTaskGrant({ sourceProfile: "reviewer", itemId: "item-1", expectedRevision: 7,
    idempotencyKey: "approval-1", templateId: "status", templateVersion: "1" })(current);
  current = await operations.revokeCaseworkTaskGrant({ sourceProfile: "reviewer", itemId: "item-1", grantId: "grant-1" })(current);
  current = await operations.caseworkTaskGrantStatus({ grantId: "grant-1" })(current);
  assert.deepEqual(calls.filter(([method]) => method !== "constructor"), [
    ["listWorkItems", "synthetic-requester-secret", "requester", "reviewer", { view: "my_teams", limit: 20 }],
    ["getWorkItem", "synthetic-requester-secret", "requester", "reviewer", "item-1"],
    ["previewTaskTemplates", "synthetic-requester-secret", "requester", "reviewer", "item-1"],
    ["listTaskGrants", "synthetic-requester-secret", "requester", "reviewer", "item-1"],
    ["approveTaskGrant", "synthetic-requester-secret", "requester", "reviewer", "item-1", 7, "approval-1", { templateId: "status", templateVersion: "1" }],
    ["revokeTaskGrant", "synthetic-requester-secret", "requester", "reviewer", "item-1", "grant-1"],
    ["taskGrantStatus", "synthetic-requester-secret", "grant-1"],
  ]);
  assert.equal(current.data.caseworkTaskStatus.branch, "succeeded");
  assert.equal("taskAssertion" in operations, false);
});

test("refreshing private-key JWT keeps minted token out of workflow data", async () => {
  const calls = [];
  class PrivateKeyJwt {
    constructor(config) { calls.push(["provider", config]); }
    async bearerToken() { calls.push(["mint"]); return "short-lived-token"; }
  }
  class CaseworkClient {
    constructor(config) { calls.push(["client", config]); }
    async getHostedItem(...args) { calls.push(["get", ...args]); return { value: { itemId: "item-1" } }; }
  }
  const operations = createCaseworkOperations(() => ({ CaseworkClient, CaseworkClientError: FakeCaseworkClientError, PrivateKeyJwt }));
  const initial = state();
  delete initial.configuration.casework.token;
  initial.configuration.casework.authorization = { privateKeyJwt: { tokenEndpoint: "https://issuer.invalid/token", clientId: "worker",
    clientKey: { kty: "EC", kid: "test", alg: "ES256" }, resource: "urn:casework", scopes: ["casework:request"] } };
  const result = await operations.getCaseworkItem({ itemId: "item-1" })(initial);
  assert.equal(result.data.caseworkItem.branch, "succeeded");
  assert.deepEqual(calls.at(-1), ["get", "short-lived-token", "requester", "item-1"]);
  assert.equal(JSON.stringify(result.data).includes("short-lived-token"), false);
  initial.configuration.casework.token = "ambiguous";
  const invalid = await operations.getCaseworkItem({ itemId: "item-1" })(initial);
  assert.equal(invalid.data.caseworkItem.problem.code, "configuration.authentication");
});

test("native token provider transport failure is retryable and redacted", async () => {
  class ProviderError extends Error {
    constructor() { super("secret-token-response"); this.kind = "token"; this.tokenKind = "transport"; }
  }
  class PrivateKeyJwt { async bearerToken() { throw new ProviderError(); } }
  const operations = createCaseworkOperations(() => ({ CaseworkClient: class {}, CaseworkClientError: FakeCaseworkClientError,
    ProviderError, PrivateKeyJwt }));
  const initial = state();
  delete initial.configuration.casework.token;
  initial.configuration.casework.authorization = { privateKeyJwt: { tokenEndpoint: "https://issuer.invalid/token" } };
  const result = await operations.getCaseworkItem({ itemId: "item-1" })(initial);
  assert.deepEqual(result.data.caseworkItem, {
    branch: "retryable_infrastructure", problem: { code: "casework.token", retryable: true },
  });
  assert.equal(JSON.stringify(result.data).includes("secret-token-response"), false);
});
