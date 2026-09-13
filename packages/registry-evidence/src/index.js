// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
export * from "@openfn/language-common";

const require = createRequire(import.meta.url);
const {
  EvidenceClient,
  EvidenceClientError,
} = require("@registrystack/client").evidence;

const SPEC_FIELDS = [
  "requirement",
  "purpose",
  "audience",
  "evidenceType",
  "issuedBy",
  "providedBy",
  "configurationRevision",
  "expectedAssuranceProfile",
  "subjects",
  "expectedOutputs",
  "maximumAssertionLifetimeSeconds",
  "clockSkewSeconds",
  "subjectExpectations",
];
const UNSAFE_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

export class EvidenceCallerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "EvidenceCallerError";
    this.code = options.code ?? "evidence_caller.error";
  }
}

/** Request and verify one signed Registry Stack Evidence assertion. */
export function requestEvidence(options = {}) {
  return async (state) => {
    let resolvedOptions = {};
    try {
      resolvedOptions = typeof options === "function" ? options(state) : options;
      return await callEvidence(state, prepareEvidenceRequest(state, resolvedOptions));
    } catch (error) {
      // OpenFn reports the operation's current state on a thrown failure.
      // Clear protected inputs there too, without stripping job credentials.
      const data = redactedData(state, redactDataPaths(resolvedOptions ?? {}));
      delete data[stringOrUndefined(resolvedOptions?.as) ?? "evidence"];
      state.data = data;
      delete state.response;
      throw callerError(error);
    }
  };
}

/**
 * Resolve OpenFn values without network I/O. Explicit mode closes policy and
 * generates a nonce; profile mode loads the configured local SDK profile and
 * leaves discovery, preparation, and verification to its native request call.
 */
export function prepareEvidenceRequest(state, options = {}) {
  if (typeof options === "function") options = options(state);
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new EvidenceCallerError("request options must be an object", { code: "configuration.request_options" });
  }
  const configuration = configurationObject(state);
  const clientConfig = evidenceConfiguration(configuration);
  if (options.responseFormat !== undefined && options.responseFormat !== "signed-jws") {
    throw new EvidenceCallerError("only signed-jws responses are supported", { code: "configuration.response_format" });
  }
  const spec = { responseFormat: "signed-jws" };
  for (const field of SPEC_FIELDS) {
    if (Object.hasOwn(options, field)) {
      spec[field] = resolveInputValue(state, options[field]);
    }
  }

  try {
    const profileMode = clientConfig.profilePath !== undefined;
    const unsupported = profileMode
      ? SPEC_FIELDS.filter((field) => !["requirement", "subjects"].includes(field))
      : ["selectors", "bindingReceipt"];
    if (unsupported.some((field) => options[field] !== undefined)) {
      throw new EvidenceCallerError("request options do not match the configured client mode", { code: "configuration.request_mode" });
    }
    const client = profileMode
      ? clientConfig.authorization === undefined
        ? EvidenceClient.fromProfile(clientConfig.profilePath, clientConfig.privateKeyJwk)
        : EvidenceClient.fromProfileWithAuthorization(clientConfig.profilePath, clientConfig.authorization)
      : new EvidenceClient(clientConfig);
    const progressive = profileMode ? resolveInputValue(state, {
      requirement: options.requirement,
      responseFormat: "signed-jws",
      ...(options.selectors === undefined ? {} : { selectors: options.selectors }),
      ...(options.subjects === undefined ? {} : { subjects: options.subjects }),
      ...(options.bindingReceipt === undefined ? {} : { bindingReceipt: options.bindingReceipt }),
    }) : undefined;
    return {
      client,
      prepared: profileMode ? undefined : client.prepare(spec),
      progressive,
      as: stringOrUndefined(options.as) ?? "evidence",
      requirement: spec.requirement,
      purpose: spec.purpose,
      redactDataPaths: redactDataPaths(options),
    };
  } catch (error) {
    throw callerError(error);
  }
}

/** Send one prepared request, retain its exact JWS bytes, and verify offline. */
export async function callEvidence(state, request) {
  if (request.progressive) {
    try {
      const verified = await request.client.request(request.progressive);
      return finish(state, request, {
        branch: "succeeded",
        trace_id: stringOrUndefined(verified.traceId),
        requirement: request.requirement,
        assertion: verified.evidence,
        jws: verified.assertion.toString("utf8"),
        retained_verification: verified.retainedVerification.toString("base64"),
        subject_continuity: verified.subjectContinuity,
        verification: { authentic: true, currently_valid: true, policy_satisfied: true },
      });
    } catch (error) {
      if (error instanceof EvidenceClientError && !["configuration", "nonce", "verification"].includes(error.kind)) {
        return finish(state, request, failureResult(error));
      }
      throw callerError(error);
    }
  }
  let raw;
  try {
    raw = await request.client.send(request.prepared);
  } catch (error) {
    if (error instanceof EvidenceClientError) {
      if (["configuration", "nonce", "verification"].includes(error.kind)) {
        throw callerError(error);
      }
      return finish(state, request, failureResult(error));
    }
    throw callerError(error);
  }

  let verified;
  try {
    verified = request.client.verify(request.prepared, raw);
  } catch (error) {
    throw callerError(error);
  }

  return finish(state, request, {
    branch: "succeeded",
    trace_id: stringOrUndefined(raw.traceId) ?? stringOrUndefined(verified.traceId),
    requirement: request.requirement,
    purpose: request.purpose,
    assertion: verified.evidence,
    jws: raw.body.toString("utf8"),
    pinned_subject_expectations: verified.pinnedSubjectExpectations,
    verification: {
      authentic: true,
      currently_valid: true,
      policy_satisfied: true,
    },
  });
}

/** Select exactly one verified supported value by governed concept. */
export function selectSupportedValue(assertion, concept) {
  const matches = Array.isArray(assertion?.supportedValues)
    ? assertion.supportedValues.filter((entry) => entry?.providesValueFor === concept)
    : [];
  if (matches.length !== 1) {
    throw new EvidenceCallerError("expected exactly one supported value for the concept", {
      code: "supported_value.cardinality",
    });
  }
  return matches[0].value;
}

function failureResult(error) {
  const status = error.kind === "not_available"
    ? 422
    : (Number.isSafeInteger(error.status) ? error.status : 0);
  const retryAfter = Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0
    ? error.retryAfterSeconds
    : undefined;
  let branch = "failed";
  let fallbackCode = "request.failed";

  if (error.kind === "transport" || (error.kind === "token" && error.tokenKind === "transport")) {
    branch = "retryable_infrastructure";
    fallbackCode = "transport.error";
  } else if (error.kind === "not_available") {
    branch = "evidence_not_available";
    fallbackCode = "evidence_not_available";
  } else if (error.kind === "token") {
    branch = "authentication_failed";
    fallbackCode = "authentication_failed";
  } else if (error.kind === "denied" && status === 401) {
    branch = "authentication_failed";
    fallbackCode = "authentication_failed";
  } else if (error.kind === "denied" && status === 403) {
    branch = "not_authorized";
    fallbackCode = "not_authorized";
  } else if (error.kind === "denied" && status === 429) {
    branch = "retryable_infrastructure";
    fallbackCode = "rate_limited";
  } else if (error.kind === "protocol" && status === 400) {
    branch = "invalid_request";
    fallbackCode = "malformed_request";
  } else if (error.kind === "protocol" && status === 406) {
    branch = "response_format_not_acceptable";
    fallbackCode = "response_format_not_acceptable";
  } else if (error.kind === "protocol" && status >= 500) {
    branch = "retryable_infrastructure";
    fallbackCode = "service_unavailable";
  }

  return {
    branch,
    trace_id: stringOrUndefined(error.traceId),
    ...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }),
    problem: {
      code: safeProblemCode(error.code) ?? fallbackCode,
      status,
      title: failureTitle(branch),
      retryable: branch === "retryable_infrastructure",
    },
  };
}

function failureTitle(branch) {
  switch (branch) {
    case "authentication_failed": return "Registry Evidence authentication failed";
    case "not_authorized": return "Registry Evidence request was not authorized";
    case "evidence_not_available": return "Registry Evidence could not be produced";
    case "retryable_infrastructure": return "Registry Evidence is temporarily unavailable";
    case "invalid_request": return "Registry Evidence request was invalid";
    case "response_format_not_acceptable": return "Registry Evidence response format was not acceptable";
    default: return "Registry Evidence request failed";
  }
}

function callerError(error) {
  if (error instanceof EvidenceCallerError) {
    return error;
  }
  if (error instanceof EvidenceClientError) {
    const verification = error.kind === "verification";
    return new EvidenceCallerError(
      verification
        ? "Registry Evidence verification failed"
        : "Registry Evidence client configuration was refused",
      { code: verification ? `verification.${safeProblemCode(error.code) ?? "failed"}` : `client.${error.kind}` },
    );
  }
  return new EvidenceCallerError("Registry Evidence client failed", { code: "client.native_failure" });
}

function finish(state, request, result) {
  const data = redactedData(state, request.redactDataPaths);
  const { response: _response, ...safeState } = state;
  return {
    ...safeState,
    data: {
      ...data,
      [request.as]: compactObject(result),
    },
  };
}

function redactedData(state, paths) {
  const data = { ...dataObject(state) };
  delete data.evidence_request;
  delete data.evidence_context;
  for (const path of paths) deleteDataPath(data, path);
  return data;
}

function evidenceConfiguration(configuration) {
  const legacyFields = ["evidence_base_url", "token", "evidence_verification_jwks", "evidence_revoked_key_ids", "evidence_trusted_root_certificates", "evidence_max_response_bytes"];
  if (configuration.evidence !== undefined) {
    if (legacyFields.some((field) => configuration[field] !== undefined)) {
      throw new EvidenceCallerError("configure evidence or legacy Evidence fields, never both", { code: "configuration.authentication" });
    }
    const config = parseConfigurationJson(configuration.evidence, "configuration.evidence");
    if (config.profilePath !== undefined && (Object.keys(config).some((key) => !["profilePath", "privateKeyJwk", "authorization"].includes(key))
      || (config.privateKeyJwk !== undefined && config.authorization !== undefined))) {
      throw new EvidenceCallerError("profilePath cannot be combined with explicit client settings", { code: "configuration.profile" });
    }
    return config;
  }
  const config = {
    baseUrl: requireString(configuration.evidence_base_url, "configuration.evidence_base_url"),
    trustedJwks: parseConfigurationJson(configuration.evidence_verification_jwks, "configuration.evidence_verification_jwks"),
    revokedKeyIds: parseConfigurationJson(configuration.evidence_revoked_key_ids, "configuration.evidence_revoked_key_ids"),
    token: { static: requireString(configuration.token, "configuration.token") },
  };
  copyOptionalConfiguration(configuration, config, "evidence_trusted_root_certificates", "trustedRootCertificates");
  copyOptionalConfiguration(configuration, config, "evidence_max_response_bytes", "maxResponseBytes");
  return config;
}

function parseConfigurationJson(value, label) {
  if (value && typeof value === "object") {
    return value;
  }
  const text = requireString(value, label);
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new EvidenceCallerError(`${label} must contain valid JSON`, { code: "configuration.invalid_json" });
  }
}

function copyOptionalConfiguration(source, target, sourceKey, targetKey) {
  const value = source[sourceKey];
  if (value !== undefined && value !== null && value !== "") {
    target[targetKey] = value;
  }
}

function resolveInputValue(state, value) {
  if (typeof value === "function") {
    return value(state);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveInputValue(state, item));
  }
  if (value && typeof value === "object") {
    if (typeof value.valueFrom === "string") {
      return valueFromPath(dataObject(state), value.valueFrom);
    }
    const resolved = {};
    for (const [key, item] of Object.entries(value)) {
      resolved[key] = resolveInputValue(state, item);
    }
    return resolved;
  }
  return value;
}

function valueFromPath(data, path) {
  const parts = safePathParts(path);
  if (!parts || parts.length === 0) return undefined;
  let current = data;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function redactDataPaths(options) {
  const paths = new Set(Array.isArray(options.redactDataPaths) ? options.redactDataPaths : []);
  collectValueFromPaths(options, paths);
  return [...paths].filter((path) => safePathParts(path)?.length > 0);
}

function collectValueFromPaths(value, paths) {
  if (Array.isArray(value)) {
    for (const item of value) collectValueFromPaths(item, paths);
  } else if (value && typeof value === "object") {
    if (typeof value.valueFrom === "string") paths.add(value.valueFrom);
    for (const item of Object.values(value)) collectValueFromPaths(item, paths);
  }
}

function deleteDataPath(data, path) {
  const parts = safePathParts(path);
  if (!parts || parts.length === 0) return;
  if (parts.length === 1) {
    delete data[parts[0]];
    return;
  }
  let current = data;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) return;
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    current[part] = { ...next };
    current = current[part];
  }
  delete current[parts.at(-1)];
}

function safePathParts(path) {
  if (typeof path !== "string" || path.length === 0) return undefined;
  const parts = path.split(".").filter(Boolean);
  return parts.some((part) => UNSAFE_PATH_PARTS.has(part)) ? undefined : parts;
}

function safeProblemCode(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value) ? value : undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function dataObject(state) {
  return state?.data && typeof state.data === "object" && !Array.isArray(state.data) ? state.data : {};
}

function configurationObject(state) {
  return state?.configuration && typeof state.configuration === "object" && !Array.isArray(state.configuration)
    ? state.configuration
    : {};
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new EvidenceCallerError(`${label} is required`, { code: "configuration.required" });
  }
  return value;
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
