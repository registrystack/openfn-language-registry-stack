import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import compile from "@openfn/compiler";
import run from "@openfn/runtime";
import {
  EvidenceCallerError,
  fn,
  execute,
  prepareEvidenceRequest,
  requestEvidence,
  selectSupportedValue,
} from "../src/index.js";

const CONFIGURATION_REVISION = `sha256:${"0".repeat(64)}`;
const SUBJECT_BINDING = `urn:evidence:subject:v1_${randomBytes(32).toString("base64url")}`;
const TEMPLATE_SUBJECT_BINDING = `urn:evidence:subject:v1_${"A".repeat(43)}`;
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const languageCommonRoot = findDependencyRoot(packageRoot, "@openfn/language-common");

test("adaptor reexports common operations used by Lightning autoimports", () => {
  assert.equal(typeof fn, "function");
  assert.equal(typeof execute, "function");
});

test("prepareEvidenceRequest uses the native client to close policy with fresh nonces", () => {
  const signingKey = generateSigningKey();
  const state = evidenceState("http://127.0.0.1:1/", signingKey.jwks);
  const first = prepareEvidenceRequest(state, requestOptions());
  const second = prepareEvidenceRequest(state, requestOptions());

  assert.match(first.prepared.requestNonce, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.prepared.requestNonce, second.prepared.requestNonce);
  assert.equal(first.prepared.policyDocument.requestNonce, first.prepared.requestNonce);
  assert.equal(first.prepared.policyDocument.audience, "urn:example:agency:benefits");
  assert.deepEqual(first.prepared.subjectExpectations, "acceptFirstUse");
  assert.deepEqual(first.redactDataPaths, ["person_id"]);
});

test("requestEvidence sends and verifies through the real Registry Stack client", async () => {
  const signingKey = generateSigningKey();
  const spec = resolvedRequestSpec();
  const stub = await startStubServer({
    "POST /v1/evidence": evidenceRoute(spec, signingKey),
  });

  try {
    const state = await requestEvidence(requestOptions())(
      evidenceState(stub.baseUrl, signingKey.jwks),
    );

    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].headers.authorization, "Bearer secret-token");
    assert.equal(stub.requests[0].headers.accept, "application/jose+json");
    assert.deepEqual(JSON.parse(stub.requests[0].body), {
      requestNonce: state.data.evidence.assertion.requestNonce,
      requirement: spec.requirement,
      purpose: spec.purpose,
      subjects: [{
        role: "subject",
        selector: {
          profile: "civil-record-v1",
          values: { record_reference: "person-123" },
        },
      }],
    });
    assert.equal(state.data.evidence.branch, "succeeded");
    assert.equal(state.data.evidence.trace_id, TRACE_ID);
    assert.equal(state.data.evidence.verification.authentic, true);
    assert.equal(state.data.evidence.verification.currently_valid, true);
    assert.equal(state.data.evidence.verification.policy_satisfied, true);
    assert.equal(
      selectSupportedValue(state.data.evidence.assertion, "urn:example:concept:adult-status"),
      true,
    );
    assert.deepEqual(state.data.evidence.pinned_subject_expectations, [
      { role: "subject", binding: SUBJECT_BINDING },
    ]);
    assert.equal(typeof state.data.evidence.jws, "string");
    assert.equal("person_id" in state.data, false);
    assert.equal(state.configuration.token, "secret-token");
    assert.equal(JSON.stringify(state.data).includes("secret-token"), false);
    assert.equal(JSON.stringify(state).includes("person-123"), false);
  } finally {
    await stub.close();
  }
});

test("native verification rejects a signed response outside the closed policy", async () => {
  const signingKey = generateSigningKey();
  const spec = resolvedRequestSpec();
  const stub = await startStubServer({
    "POST /v1/evidence": evidenceRoute(spec, signingKey, {
      audience: "urn:example:agency:other",
    }),
  });

  try {
    await assert.rejects(
      () => requestEvidence(requestOptions())(evidenceState(stub.baseUrl, signingKey.jwks)),
      (error) => error instanceof EvidenceCallerError
        && error.code.startsWith("verification."),
    );
  } finally {
    await stub.close();
  }
});

for (const [scenario, expectedCode] of [
  ["wrong purpose", "verification.policy"],
  ["expired assertion", "verification.time"],
  ["tampered signature", "verification.signature"],
]) {
  test(`native verification refuses ${scenario} without releasing result or response residue`, async () => {
    const signingKey = generateSigningKey();
    const spec = resolvedRequestSpec();
    const instant = Date.now();
    const timestamp = offset => new Date(instant + offset).toISOString().replace(/\.\d+Z$/, "Z");
    const overrides = scenario === "wrong purpose"
      ? { purpose: "different-governed-purpose" }
      : scenario === "expired assertion"
        ? { issuedAt: timestamp(-180_000), observedAt: timestamp(-180_000), validUntil: timestamp(-120_000) }
        : {};
    let originalJws;
    let responseJws;
    const stub = await startStubServer({
      "POST /v1/evidence": (_req, res, body) => {
        const assertion = evidenceFor(spec, JSON.parse(body).requestNonce, overrides);
        originalJws = JSON.parse(signEvidence(assertion, signingKey));
        responseJws = { ...originalJws };
        if (scenario === "tampered signature") {
          const signature = Buffer.from(responseJws.signature, "base64url");
          signature[0] ^= 1;
          responseJws.signature = signature.toString("base64url");
        }
        res.writeHead(200, { "content-type": "application/jose+json", traceparent: TRACEPARENT });
        res.end(JSON.stringify(responseJws));
      },
    });
    try {
      const state = evidenceState(stub.baseUrl, signingKey.jwks);
      const configuration = state.configuration;
      state.response = { body: "untrusted-response-residue" };
      state.data.evidence = { assertion: { residue: "previous-assertion" }, jws: "previous-jws" };
      let published;
      await assert.rejects(async () => {
        published = await requestEvidence(requestOptions())(state);
      }, error => error instanceof EvidenceCallerError && error.code === expectedCode);
      assert.equal(published, undefined);
      assert.equal(stub.requests.length, 1);
      assert.equal(state.configuration, configuration);
      assert.equal(state.configuration.token, "secret-token");
      assert.equal(state.data.evidence, undefined);
      assert.equal(state.response, undefined);
      assert.equal(state.data.person_id, undefined);
      for (const residue of ["previous-assertion", "previous-jws", "untrusted-response-residue", "person-123"]) {
        assert.equal(JSON.stringify(state.data).includes(residue), false);
      }
      // Distinguish a correctly signed policy/time refusal from malformed JWS.
      const checkSignature = jws => verify("sha256", Buffer.from(`${jws.protected}.${jws.payload}`),
        { key: signingKey.privateKey, dsaEncoding: "ieee-p1363" }, Buffer.from(jws.signature, "base64url"));
      assert.equal(checkSignature(originalJws), true);
      assert.equal(Buffer.from(responseJws.signature, "base64url").length, 64);
      assert.equal(checkSignature(responseJws), scenario !== "tampered signature");
      if (scenario === "expired assertion") {
        const assertion = JSON.parse(Buffer.from(responseJws.payload, "base64url"));
        assert.equal(Date.parse(assertion.validUntil) - Date.parse(assertion.issuedAt), 60_000);
        assert.ok(Date.parse(assertion.validUntil) + spec.clockSkewSeconds * 1000 < instant);
      }
    } finally { await stub.close(); }
  });
}

test("native revocation checking rejects a still-trusted signing key", async () => {
  const signingKey = generateSigningKey();
  const spec = resolvedRequestSpec();
  const stub = await startStubServer({
    "POST /v1/evidence": evidenceRoute(spec, signingKey),
  });

  try {
    const state = evidenceState(stub.baseUrl, signingKey.jwks, [signingKey.kid]);
    await assert.rejects(
      () => requestEvidence(requestOptions())(state),
      (error) => error instanceof EvidenceCallerError
        && error.code.startsWith("verification."),
    );
  } finally {
    await stub.close();
  }
});

test("typed Evidence failures map to redacted workflow branches", async () => {
  const signingKey = generateSigningKey();
  const unavailable = await startStubServer({
    "POST /v1/evidence": (_req, res) => {
      res.writeHead(422, {
        "content-type": "application/problem+json",
        traceparent: TRACEPARENT,
      });
      res.end(problemBody(422, "evidence.unavailable"));
    },
  });

  try {
    const state = await requestEvidence(requestOptions())(
      evidenceState(unavailable.baseUrl, signingKey.jwks),
    );
    assert.deepEqual(state.data.evidence.problem, {
      code: "evidence_not_available",
      status: 422,
      title: "Registry Evidence could not be produced",
      retryable: false,
    });
    assert.equal(state.data.evidence.branch, "evidence_not_available");
    assert.equal(JSON.stringify(state).includes("protected person-123"), false);
    assert.equal(JSON.stringify(state).includes("person-123"), false);
  } finally {
    await unavailable.close();
  }
});

test("429 failures preserve the typed retry interval", async () => {
  const signingKey = generateSigningKey();
  const stub = await startStubServer({
    "POST /v1/evidence": (_req, res) => {
      res.writeHead(429, {
        "content-type": "application/problem+json",
        "retry-after": "30",
      });
      res.end(problemBody(429, "evidence.rate_limited"));
    },
  });

  try {
    const state = await requestEvidence(requestOptions())(
      evidenceState(stub.baseUrl, signingKey.jwks),
    );
    assert.equal(state.data.evidence.branch, "retryable_infrastructure");
    assert.equal(state.data.evidence.retry_after_seconds, 30);
    assert.equal(state.data.evidence.problem.retryable, true);
  } finally {
    await stub.close();
  }
});

test("template imports the Evidence helper and avoids generic HTTP helpers", () => {
  const template = readFileSync(new URL("../jobs/request-evidence.js", import.meta.url), "utf8");
  assert.match(template, /requestEvidence/);
  assert.doesNotMatch(template, /@openfn\/language-http/);
  assert.doesNotMatch(template, /Authorization/);
});

test("compiled OpenFn template executes the current native client", async () => {
  const signingKey = generateSigningKey();
  const spec = resolvedRequestSpec({ expectedAssuranceProfile: "production" });
  const stub = await startStubServer({
    "POST /v1/evidence": evidenceRoute(spec, signingKey, {
      subjects: [{ role: "subject", binding: TEMPLATE_SUBJECT_BINDING }],
    }),
  });
  const template = readFileSync(new URL("../jobs/request-evidence.js", import.meta.url), "utf8");
  const { code } = compile(template);

  try {
    const result = await run(
      {
        workflow: {
          steps: [{ id: "request-evidence", expression: code }],
          start: "request-evidence",
        },
        options: { start: "request-evidence" },
      },
      evidenceState(stub.baseUrl, signingKey.jwks),
      {
        linker: {
          modules: {
            "@openfn/language-common": { path: languageCommonRoot },
            "../src/index.js": { path: packageRoot },
          },
          cacheKey: `openfn-evidence-native-test-${process.pid}-${Date.now()}`,
        },
      },
    );

    assert.equal(result.errors, undefined);
    assert.equal(stub.requests.length, 1);
    assert.equal(result.data.evidence.branch, "succeeded");
    assert.equal(result.data.evidence.assertion.supportedValues[0].value, true);
    assert.equal("person_id" in result.data, false);
    assert.equal("configuration" in result, false);
  } finally {
    await stub.close();
  }
});

test("nested SDK configuration exchanges privateKeyJwt once without leaking credentials", async () => {
  const signingKey = generateSigningKey();
  const clientKey = generateSigningKey();
  const clientJwk = { ...clientKey.privateKey.export({ format: "jwk" }), kid: clientKey.kid, alg: "ES256" };
  const stub = await startStubServer({
    "POST /token": (_req, res, body) => {
      const form = new URLSearchParams(body);
      assert.equal(form.get("grant_type"), "client_credentials");
      assert.equal(form.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      const [header, payload, signature] = form.get("client_assertion").split(".");
      assert.equal(JSON.parse(Buffer.from(payload, "base64url")).sub, "openfn-pilot");
      assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), { key: clientKey.privateKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "minted-token", token_type: "Bearer", expires_in: 300 }));
    },
    "POST /v1/evidence": evidenceRoute(resolvedRequestSpec(), signingKey),
  });
  try {
    const input = evidenceState(stub.baseUrl, signingKey.jwks);
    input.configuration = { evidence: {
      baseUrl: stub.baseUrl, trustedJwks: signingKey.jwks, revokedKeyIds: [],
      token: { privateKeyJwt: { tokenEndpoint: `${stub.baseUrl}token`, clientId: "openfn-pilot", clientKey: clientJwk } },
    } };
    const result = await requestEvidence(requestOptions())(input);
    assert.equal(result.data.evidence.branch, "succeeded");
    assert.equal(stub.requests.length, 2);
    assert.equal(stub.requests[1].headers.authorization, "Bearer minted-token");
    assert.equal(JSON.stringify(result.data).includes(clientJwk.d), false);
    assert.equal(JSON.stringify(result.data).includes("minted-token"), false);
  } finally { await stub.close(); }
});

test("signed false is available evidence and pinned continuity refuses a different subject", async () => {
  const signingKey = generateSigningKey();
  const stub = await startStubServer({ "POST /v1/evidence": evidenceRoute(resolvedRequestSpec(), signingKey, {
    supportedValues: [{ providesValueFor: "urn:example:concept:adult-status", value: false }],
  }) });
  try {
    const result = await requestEvidence(requestOptions())(evidenceState(stub.baseUrl, signingKey.jwks));
    assert.equal(result.data.evidence.branch, "succeeded");
    assert.equal(selectSupportedValue(result.data.evidence.assertion, "urn:example:concept:adult-status"), false);
    await assert.rejects(requestEvidence(requestOptions({ subjectExpectations: { pinned: [{ role: "subject", binding: TEMPLATE_SUBJECT_BINDING }] } }))(evidenceState(stub.baseUrl, signingKey.jwks)), { name: "EvidenceCallerError" });
    assert.equal(stub.requests.length, 2);
  } finally { await stub.close(); }
});

test("runtime retains credentials between operations and strips them on success and verification failure", async () => {
  for (const invalidSignature of [false, true]) {
    const signingKey = generateSigningKey();
    const responseKey = invalidSignature ? generateSigningKey() : signingKey;
    const stub = await startStubServer({ "POST /v1/evidence": evidenceRoute(resolvedRequestSpec(), responseKey) });
    try {
      const spec = JSON.stringify({ ...resolvedRequestSpec(), redactDataPaths: ["person_id"] });
      const { code } = compile(`
        import { execute } from "@openfn/language-common";
        import { requestEvidence } from "../src/index.js";
        execute(
          requestEvidence(state => (${spec})),
          state => { if (state.configuration.token !== "secret-token") throw new Error("configuration lost"); return state; },
          requestEvidence(state => (${spec}))
        );
      `);
      const result = await run({ workflow: { steps: [{ id: "evidence", expression: code }], start: "evidence" }, options: { start: "evidence" } }, evidenceState(stub.baseUrl, signingKey.jwks), {
        linker: { modules: { "@openfn/language-common": { path: languageCommonRoot }, "../src/index.js": { path: packageRoot } }, cacheKey: `runtime-boundary-${invalidSignature}-${Date.now()}` },
      });
      assert.equal("configuration" in result, false);
      assert.equal(JSON.stringify(result).includes("secret-token"), false);
      assert.equal(JSON.stringify(result).includes("person-123"), false);
      assert.equal(stub.requests.length, invalidSignature ? 1 : 2);
      if (invalidSignature) {
        assert.ok(result.errors);
        assert.equal(result.data.evidence, undefined);
      } else {
        assert.equal(result.errors, undefined);
        assert.equal(result.data.evidence.branch, "succeeded");
        assert.notEqual(JSON.parse(stub.requests[0].body).requestNonce, JSON.parse(stub.requests[1].body).requestNonce);
      }
    } finally { await stub.close(); }
  }
});

test("ambiguous credential sources and unsigned response requests are refused locally", () => {
  const key = generateSigningKey();
  const state = evidenceState("http://127.0.0.1:1/", key.jwks);
  state.configuration.evidence = { baseUrl: "http://127.0.0.1:1/" };
  assert.throws(() => prepareEvidenceRequest(state, requestOptions()), { code: "configuration.authentication" });
  delete state.configuration.evidence;
  assert.throws(() => prepareEvidenceRequest(state, requestOptions({ responseFormat: "sd-jwt-vc" })), { code: "configuration.response_format" });
});

test("profile requests verify first-use and matched receipts and refuse subject changes", async () => {
  const signingKey = generateSigningKey();
  const clientKey = generateSigningKey();
  const spec = resolvedRequestSpec();
  const directory = mkdtempSync(resolve(tmpdir(), "openfn-evidence-profile-"));
  let binding = SUBJECT_BINDING;
  let origin;
  const jsonRoute = (value, contentType = "application/json") => (_req, res) => {
    res.writeHead(200, { "content-type": contentType });
    res.end(JSON.stringify(typeof value === "function" ? value() : value));
  };
  const stub = await startStubServer({
    "GET /.well-known/oauth-protected-resource": jsonRoute(() => ({ resource: origin, authorization_servers: [origin], jwks_uri: `${origin}/.well-known/evidence/jwks.json`, bearer_methods_supported: ["header"] })),
    "GET /.well-known/oauth-authorization-server": jsonRoute(() => ({ issuer: origin, token_endpoint: `${origin}/token`, grant_types_supported: ["client_credentials"], token_endpoint_auth_methods_supported: ["private_key_jwt"] })),
    "GET /.well-known/evidence/jwks.json": jsonRoute(signingKey.jwks, "application/jwk-set+json"),
    "POST /token": jsonRoute({ access_token: "profile-token", token_type: "Bearer", expires_in: 300 }),
    "GET /v1/evidence-definitions": jsonRoute({
      schema: "registry.evidence-definitions/v1", assuranceProfile: "local", audience: spec.audience, issuedBy: spec.issuedBy, providedBy: spec.providedBy,
      definitions: [{ handle: "adult-status", requirement: spec.requirement, configurationRevision: spec.configurationRevision, kind: "criterion", evidenceType: spec.evidenceType, purpose: spec.purpose, responseFormats: ["signed-jws"], referenceFrameworks: ["urn:example:framework:adult-status"], subjects: [{ role: "subject", cardinality: "one", selector: { profile: "civil-record-v1", valueOrigin: "request", fields: [{ type: "string", name: "record_reference", minimumBytes: 1, maximumBytes: 200 }] } }], concepts: [{ handle: "adult", concept: "urn:example:concept:adult-status", required: true, form: "boolean" }] }],
    }),
    "POST /v1/evidence": (req, res, body) => evidenceRoute(spec, signingKey, { subjects: [{ role: "subject", binding }] })(req, res, body),
  });
  origin = stub.baseUrl.replace(/\/$/, "");
  try {
    const profilePath = resolve(directory, "client.json");
    writeFileSync(profilePath, JSON.stringify({ schema: "registry.evidence-client-profile/v1", baseUrl: origin, clientId: "openfn-profile", privateKey: { source: "file", path: "unused-in-memory-key.jwk" }, trust: { type: "local-loopback-discovery" }, contracts: { type: "published" } }), { mode: 0o600 });
    const configuration = { evidence: { profilePath, privateKeyJwk: { ...clientKey.privateKey.export({ format: "jwk" }), kid: clientKey.kid, alg: "ES256" } } };
    const options = { requirement: "adult-status", selectors: { record_reference: { valueFrom: "person_id" } } };
    const input = () => ({ configuration, data: { person_id: "person-123" } });
    const first = await requestEvidence(options)(input());
    assert.equal(first.data.evidence.subject_continuity.status, "firstUse");
    const receipt = first.data.evidence.subject_continuity.receipt;
    assert.equal(JSON.stringify(receipt).includes("person-123"), false);
    const second = await requestEvidence({ ...options, bindingReceipt: receipt })(input());
    assert.equal(second.data.evidence.subject_continuity.status, "matched");
    assert.equal(second.data.evidence.trace_id, TRACE_ID);
    assert.equal(typeof second.data.evidence.jws, "string");
    binding = TEMPLATE_SUBJECT_BINDING;
    await assert.rejects(requestEvidence({ ...options, bindingReceipt: receipt })(input()), { name: "EvidenceCallerError" });
    assert.equal(stub.requests.filter(request => request.url === "/v1/evidence").length, 3);
  } finally { await stub.close(); rmSync(directory, { recursive: true, force: true }); }
});

function requestOptions(overrides = {}) {
  return {
    requirement: "urn:example:requirement:adult-status:v1",
    purpose: "benefit-eligibility",
    audience: "urn:example:agency:benefits",
    evidenceType: "urn:example:evidence-type:adult-status:v1",
    issuedBy: "urn:example:authority:population-registry",
    providedBy: "urn:example:data-service:evidence",
    configurationRevision: CONFIGURATION_REVISION,
    expectedAssuranceProfile: "local",
    subjects: [{
      role: "subject",
      selectorProfile: "civil-record-v1",
      selectorValues: { record_reference: { valueFrom: "person_id" } },
    }],
    expectedOutputs: [
      { concept: "urn:example:concept:adult-status", form: "boolean" },
    ],
    maximumAssertionLifetimeSeconds: 300,
    clockSkewSeconds: 30,
    subjectExpectations: "acceptFirstUse",
    ...overrides,
  };
}

function resolvedRequestSpec(overrides = {}) {
  const options = requestOptions(overrides);
  return {
    ...options,
    subjects: [{
      role: "subject",
      selectorProfile: "civil-record-v1",
      selectorValues: { record_reference: "person-123" },
    }],
  };
}

function evidenceState(baseUrl, jwks, revokedKeyIds = []) {
  return {
    data: {
      request_id: "workflow-request-1",
      person_id: "person-123",
    },
    configuration: {
      evidence_base_url: baseUrl,
      token: "secret-token",
      evidence_verification_jwks: JSON.stringify(jwks),
      evidence_revoked_key_ids: JSON.stringify(revokedKeyIds),
    },
  };
}

function generateSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const thumbprint = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const kid = createHash("sha256").update(thumbprint).digest("base64url");
  return {
    kid,
    privateKey,
    jwks: { keys: [{ ...jwk, kid, alg: "ES256" }] },
  };
}

function evidenceRoute(spec, signingKey, overrides = {}) {
  return (_req, res, body) => {
    const requestBody = JSON.parse(body);
    const evidence = evidenceFor(spec, requestBody.requestNonce, overrides);
    res.writeHead(200, {
      "content-type": "application/jose+json",
      traceparent: TRACEPARENT,
    });
    res.end(signEvidence(evidence, signingKey));
  };
}

function evidenceFor(spec, nonce, overrides = {}) {
  const issuedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const validUntil = new Date(Date.now() + 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  return {
    schema: "registry.assertion-evidence/v1",
    assuranceProfile: spec.expectedAssuranceProfile,
    subjectBinding: "audience-scoped",
    requestNonce: nonce,
    id: "urn:example:openfn-test:evidence:1",
    type: "Evidence",
    supportsRequirement: spec.requirement,
    isConformantTo: spec.evidenceType,
    issuedBy: spec.issuedBy,
    providedBy: spec.providedBy,
    issuedAt,
    observedAt: issuedAt,
    validUntil,
    purpose: spec.purpose,
    audience: spec.audience,
    configurationRevision: spec.configurationRevision,
    subjects: [{ role: "subject", binding: SUBJECT_BINDING }],
    supportedValues: [{
      providesValueFor: "urn:example:concept:adult-status",
      value: true,
    }],
    ...overrides,
  };
}

function signEvidence(evidence, signingKey) {
  const protectedSegment = Buffer.from(JSON.stringify({
    alg: "ES256",
    kid: signingKey.kid,
    typ: "evidence+jws",
    cty: "application/evidence+json",
  })).toString("base64url");
  const payloadSegment = Buffer.from(JSON.stringify(evidence)).toString("base64url");
  const signingInput = `${protectedSegment}.${payloadSegment}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: signingKey.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return JSON.stringify({
    protected: protectedSegment,
    payload: payloadSegment,
    signature: signature.toString("base64url"),
  });
}

function problemBody(status, code) {
  const [title, detail] = {
    "evidence.unavailable": ["Evidence could not be produced", "evidence could not be produced for this request"],
    "evidence.rate_limited": ["Evidence request rate is exhausted", "the Evidence request rate is exhausted"],
  }[code];
  return JSON.stringify({
    type: `https://id.registrystack.org/problems/registry-evidence/${code.replaceAll(".", "/")}`,
    title, status, detail, code, traceId: TRACE_ID,
  });
}

function startStubServer(routes) {
  const requests = [];
  const table = new Map(Object.entries(routes));
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const handler = table.get(`${req.method} ${req.url}`);
      if (!handler) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("no route");
        return;
      }
      res.setHeader("traceparent", TRACEPARENT);
      handler(req, res, body);
    });
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({
        baseUrl: `http://127.0.0.1:${port}/`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
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
