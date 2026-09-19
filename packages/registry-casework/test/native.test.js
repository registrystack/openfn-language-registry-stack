import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import test from "node:test";

import {
  createCaseworkRequest,
  getCaseworkResult,
  pollCaseworkResults,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const installedCasework = require("@registrystack/client").casework;
const unifiedClientAvailable =
  typeof installedCasework?.CaseworkClient?.prototype?.createOrRecoverReviewRequest === "function";
const requiresUnifiedRelease = unifiedClientAvailable
  ? false
  : "installed @registrystack/client does not yet contain the unified Casework release";

const subject = {
  source: "payments",
  type: "batch",
  id: "batch-0042",
  version: "7",
  digest: `sha256:${"a".repeat(64)}`,
};
const accepted = {
  requestId: "00000000-0000-4000-8000-000000000001",
  subject,
  policy: {
    id: "batch-validation",
    version: "1",
    digest: `sha256:${"b".repeat(64)}`,
  },
  submissionDigest: `sha256:${"c".repeat(64)}`,
};
const request = {
  kind: "batch-validation",
  subject,
  requesterReference: "batch-0042",
  context: { strategy: "submitted", snapshot: { summary: "Batch 42" } },
  resultConstraints: { acceptedCount: { minimum: 0 } },
};

function requesterState(baseUrl) {
  return {
    configuration: {
      casework: { baseUrl, token: "synthetic-token", profile: "requester" },
    },
    data: {},
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

test("real native client uses unified create and result-feed routes", { skip: requiresUnifiedRelease }, async (context) => {
  const requests = [];
  const server = await listen(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(req.method === "POST" ? 201 : 200, {
      "content-type": "application/json",
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    });
    res.end(req.method === "POST"
      ? JSON.stringify(accepted)
      : JSON.stringify({
        items: [{
          eventId: "00000000-0000-4000-8000-000000000002",
          requestId: accepted.requestId,
          resultId: "00000000-0000-4000-8000-000000000003",
          completedAt: "2026-09-20T00:00:00Z",
        }],
      }));
  });
  context.after(() => new Promise(resolve => server.close(resolve)));
  const state = requesterState(`http://127.0.0.1:${server.address().port}/`);
  const created = await createCaseworkRequest({
    request,
    expectedSubmissionDigest: accepted.submissionDigest,
    idempotencyKey: "batch-0042:create",
  })(state);
  assert.equal(created.data.caseworkCreated.branch, "succeeded", JSON.stringify(created.data.caseworkCreated));
  const polled = await pollCaseworkResults({ limit: 25 })(created);
  assert.equal(polled.data.caseworkTerminal.branch, "succeeded", JSON.stringify(polled.data.caseworkTerminal));
  assert.equal(requests[0].url, "/v1/review-requests");
  assert.equal(requests[0].headers["idempotency-key"], "batch-0042:create");
  assert.deepEqual(JSON.parse(requests[0].body), request);
  assert.equal(requests[1].url, "/v1/review-results?limit=25");
  assert.equal(requests[1].headers.authorization, "Bearer synthetic-token");
  assert.equal(JSON.stringify(polled.data).includes("synthetic-token"), false);
});

test("real native result lookup preserves 202 pending", { skip: requiresUnifiedRelease }, async (context) => {
  const requests = [];
  const server = await listen(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(202, {
      "content-length": "0",
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    });
    res.end();
  });
  context.after(() => new Promise(resolve => server.close(resolve)));
  const result = await getCaseworkResult({ accepted })(
    requesterState(`http://127.0.0.1:${server.address().port}/`),
  );
  assert.equal(result.data.caseworkResult.branch, "pending");
  assert.equal(result.data.caseworkResult.value, null);
  assert.equal(requests[0].url, `/v1/review-requests/${accepted.requestId}/result`);
});
