import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import compile from "@openfn/compiler";
import run from "@openfn/runtime";
import {
  approveCaseworkTaskGrant,
  createOrRecoverReviewRequest,
  getReviewRequest,
  listCaseworkReviewTasks,
} from "../src/index.js";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const subject = {
  source: "payments",
  type: "batch",
  id: "batch-0042",
  version: "7",
  digest: `sha256:${"a".repeat(64)}`,
};
const request = {
  policy: { id: "batch-validation" },
  subject,
  requesterReference: "batch-0042",
  context: {
    mode: "submitted",
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

test("installed client preserves requester and source-task authority", async (context) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    res.setHeader(
      "traceparent",
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    );
    if (req.method === "POST" && req.url === "/v1/review-requests") {
      res.statusCode = 201;
      return res.end(JSON.stringify(accepted));
    }
    if (req.method === "GET" && req.url?.startsWith("/v1/review-tasks?")) {
      return res.end(JSON.stringify({ items: [], status: "complete" }));
    }
    if (
      req.method === "POST" &&
      req.url === `/v1/review-tasks/${REQUEST_ID}/task-grants`
    ) {
      return res.end(
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000002",
          templateId: "verify",
          templateVersion: "1",
          agent: { issuer: "https://issuer.invalid", subject: "worker" },
          client: "worker",
          resource: "urn:evidence",
          scopes: [],
          purpose: "verify",
          bounds: { type: "evidence", requirement: "status" },
          expiresAt: 2_000_000_900,
          invalidated: false,
        }),
      );
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const state = {
    configuration: {
      casework: {
        baseUrl: `http://127.0.0.1:${server.address().port}/`,
        token: "synthetic-token",
        profile: "requester",
      },
    },
    data: {},
  };
  const created = await createOrRecoverReviewRequest({
    request,
    expectedSubmissionDigest: accepted.submissionDigest,
    idempotencyKey: "batch-0042:create",
  })(state);
  assert.equal(
    created.data.reviewRequestAccepted.branch,
    "succeeded",
    JSON.stringify(created.data.reviewRequestAccepted),
  );
  assert.equal(requests[0].url, "/v1/review-requests");
  assert.equal(requests[0].headers["idempotency-key"], "batch-0042:create");
  assert.deepEqual(JSON.parse(requests[0].body), request);

  const listed = await listCaseworkReviewTasks({
    sourceProfile: "reviewer",
    query: { ownership: "unclaimed", limit: 20 },
  })(created);
  assert.equal(
    listed.data.caseworkReviewTasks.branch,
    "succeeded",
    JSON.stringify(listed.data.caseworkReviewTasks),
  );
  assert.equal(requests[1].headers["registry-source-profile"], "reviewer");

  const approved = await approveCaseworkTaskGrant({
    sourceProfile: "reviewer",
    taskId: REQUEST_ID,
    expectedRevision: 7,
    idempotencyKey: "grant-42",
    templateId: "verify",
    templateVersion: "1",
  })(listed);
  assert.equal(
    approved.data.caseworkTaskGrant.branch,
    "succeeded",
    JSON.stringify(approved.data.caseworkTaskGrant),
  );
  assert.equal(requests[2].headers["if-match"], '"7"');
  assert.equal(requests[2].headers["idempotency-key"], "grant-42");
  assert.deepEqual(JSON.parse(requests[2].body), {
    templateId: "verify",
    templateVersion: "1",
  });

  const { code } = compile(
    readFileSync(new URL("../jobs/create-request.js", import.meta.url), "utf8"),
  );
  const runtime = await run(
    {
      workflow: {
        steps: [{ id: "review", expression: code }],
        start: "review",
      },
      options: { start: "review" },
    },
    {
      ...state,
      data: {
        caseworkReviewRequest: request,
        caseworkSubmissionDigest: accepted.submissionDigest,
        createIdempotencyKey: "batch-0042:compiled",
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
        cacheKey: `casework-${process.pid}`,
      },
    },
  );
  assert.equal(runtime.errors, undefined, JSON.stringify(runtime.errors));
  assert.equal(runtime.data.acceptedReviewRequest.branch, "succeeded");
  assert.equal(requests[3].headers["idempotency-key"], "batch-0042:compiled");
  assert.equal("configuration" in runtime, false);
  assert.equal(JSON.stringify(runtime).includes("synthetic-token"), false);
});

test("installed token provider mints a credential for one requester read", async (context) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    res.setHeader(
      "traceparent",
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    );
    if (req.url === "/token") {
      return res.end(
        JSON.stringify({
          access_token: "minted-casework-token",
          token_type: "Bearer",
          expires_in: 300,
        }),
      );
    }
    return res.end(
      JSON.stringify({
        ...accepted,
        requesterReference: request.requesterReference,
        lifecycle: "reviewing",
        activeStage: "review",
        createdAt: "2026-09-19T00:00:00Z",
        updatedAt: "2026-09-19T00:00:00Z",
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const clientKey = {
    ...privateKey.export({ format: "jwk" }),
    kid: "synthetic-key",
    alg: "ES256",
  };
  const state = {
    configuration: {
      casework: {
        baseUrl,
        profile: "requester",
        authorization: {
          privateKeyJwt: {
            tokenEndpoint: `${baseUrl}token`,
            clientId: "worker",
            clientKey,
            resource: baseUrl,
            scopes: ["casework:read"],
          },
        },
      },
    },
    data: {},
  };

  const invalid = await getReviewRequest({})(state);
  assert.equal(invalid.data.reviewRequest.branch, "invalid_request");
  assert.equal(requests.length, 0);

  const result = await getReviewRequest({ requestId: REQUEST_ID })(state);
  assert.equal(
    result.data.reviewRequest.branch,
    "succeeded",
    JSON.stringify(result.data.reviewRequest),
  );
  assert.equal(requests[0].url, "/token");
  assert.equal(requests[1].headers.authorization, "Bearer minted-casework-token");
  assert.equal(JSON.stringify(result.data).includes("minted-casework-token"), false);
});
