// SPDX-License-Identifier: Apache-2.0

const CLIENT_CONFIG_FIELDS = [
  "baseUrl",
  "requestTimeoutMilliseconds",
  "connectTimeoutMilliseconds",
  "maxResponseBytes",
  "userAgent",
  "trustedRootCertificates",
];
const SAFE_VALIDATION_REASONS = new Set([
  "kind_not_allowed",
  "reference_invalid",
  "object_required",
  "maximum_bytes_exceeded",
  "maximum_depth_exceeded",
  "schema_mismatch",
  "outcome_not_declared",
  "reason_required",
  "text_invalid",
]);
const RESULT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export class CaseworkCallerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CaseworkCallerError";
    this.code = options.code ?? "casework_caller.error";
  }
}

class OperationFailure extends Error {
  constructor(branch, code) {
    super("Registry Casework operation did not complete");
    this.branch = branch;
    this.code = code;
  }
}

/** Create the narrow Requester operation set around maintained client bindings. */
export function createCaseworkOperations(loadBindings) {
  if (typeof loadBindings !== "function") {
    throw new CaseworkCallerError("Casework client loader is required", {
      code: "client.loader_required",
    });
  }

  return {
    createCaseworkItem: (options = {}) =>
      operation(loadBindings, options, "caseworkCreated", null, (client, auth, input) =>
        client.createHostedItem(
          auth.token,
          auth.profile,
          requiredString(input.idempotencyKey, "idempotencyKey"),
          {
            kind: requiredString(input.kind, "kind"),
            requesterReference: requiredString(
              input.requesterReference,
              "requesterReference",
            ),
            display: requiredObject(input.display, "display"),
          },
        ),
      ),

    getCaseworkItem: (options = {}) =>
      operation(loadBindings, options, "caseworkItem", null, (client, auth, input) =>
        client.getHostedItem(
          auth.token,
          auth.profile,
          requiredString(input.itemId, "itemId"),
        ),
      ),

    addCaseworkNote: (options = {}) =>
      operation(loadBindings, options, "caseworkNote", null, (client, auth, input) =>
        client.addHostedNote(
          auth.token,
          auth.profile,
          requiredString(input.itemId, "itemId"),
          requiredRevision(input.expectedRevision),
          requiredString(input.idempotencyKey, "idempotencyKey"),
          { note: requiredString(input.note, "note") },
        ),
      ),

    listCaseworkNotes: (options = {}) =>
      operation(loadBindings, options, "caseworkNotes", "noteId", (client, auth, input) =>
        client.requesterHostedNotes(
          auth.token,
          auth.profile,
          requiredString(input.itemId, "itemId"),
          pageQuery(input),
        ),
      ),

    cancelCaseworkItem: (options = {}) =>
      operation(
        loadBindings,
        options,
        "caseworkCancellation",
        null,
        (client, auth, input) =>
          client.cancelHostedItem(
            auth.token,
            auth.profile,
            requiredString(input.itemId, "itemId"),
            requiredRevision(input.expectedRevision),
            requiredString(input.idempotencyKey, "idempotencyKey"),
            { reason: requiredString(input.reason, "reason") },
          ),
      ),

    pollCaseworkResults: (options = {}) =>
      operation(
        loadBindings,
        options,
        "caseworkTerminal",
        "eventId",
        (client, auth, input) =>
          client.hostedTerminalItems(
            auth.token,
            auth.profile,
            pageQuery(input),
          ),
      ),
    listCaseworkWorkItems: (options = {}) =>
      operation(loadBindings, options, "caseworkWorkItems", null, (client, auth, input) =>
        client.listWorkItems(auth.token, auth.profile, requiredString(input.sourceProfile, "sourceProfile"), requiredObject(input.query, "query"))),
    getCaseworkWorkItem: (options = {}) =>
      operation(loadBindings, options, "caseworkWorkItem", null, (client, auth, input) =>
        client.getWorkItem(auth.token, auth.profile, requiredString(input.sourceProfile, "sourceProfile"), requiredString(input.itemId, "itemId"))),
    previewCaseworkTaskTemplates: (options = {}) =>
      operation(loadBindings, options, "caseworkTaskTemplates", null, (client, auth, input) =>
        client.previewTaskTemplates(auth.token, auth.profile, requiredString(input.sourceProfile, "sourceProfile"), requiredString(input.itemId, "itemId"))),
    listCaseworkTaskGrants: (options = {}) =>
      operation(loadBindings, options, "caseworkTaskGrants", null, (client, auth, input) =>
        client.listTaskGrants(auth.token, auth.profile, requiredString(input.sourceProfile, "sourceProfile"), requiredString(input.itemId, "itemId"))),
    approveCaseworkTaskGrant: (options = {}) =>
      operation(loadBindings, options, "caseworkTaskGrant", null, (client, auth, input) =>
        client.approveTaskGrant(auth.token, auth.profile, requiredString(input.sourceProfile, "sourceProfile"), requiredString(input.itemId, "itemId"),
          requiredRevision(input.expectedRevision), requiredString(input.idempotencyKey, "idempotencyKey"),
          { templateId: requiredString(input.templateId, "templateId"), templateVersion: requiredString(input.templateVersion, "templateVersion") })),
    revokeCaseworkTaskGrant: (options = {}) =>
      operation(loadBindings, options, "caseworkTaskRevocation", null, (client, auth, input) =>
        client.revokeTaskGrant(auth.token, auth.profile, requiredString(input.sourceProfile, "sourceProfile"), requiredString(input.itemId, "itemId"), requiredString(input.grantId, "grantId"))),
    caseworkTaskGrantStatus: (options = {}) =>
      operation(loadBindings, options, "caseworkTaskStatus", null, (client, auth, input) =>
        client.taskGrantStatus(auth.token, requiredString(input.grantId, "grantId"))),
  };
}

function operation(loadBindings, options, defaultName, deduplicateBy, invoke) {
  return async (state) => {
    let resultName = defaultName;
    let ClientError;
    let ProviderError;
    let result;
    try {
      const supplied = typeof options === "function" ? options(state) : options;
      if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
        throw new OperationFailure("invalid_request", "request.invalid");
      }
      const input = Object.fromEntries(
        Object.entries(supplied).map(([key, value]) => [
          key,
          typeof value === "function" ? value(state) : value,
        ]),
      );
      resultName = requestedResultName(input.as, defaultName);
      const { CaseworkClient, CaseworkClientError, ProviderError: TokenError } = loadBindings();
      ClientError = CaseworkClientError;
      ProviderError = TokenError;
      const configuration = caseworkConfiguration(state);
      validateInputs(defaultName, input);
      const auth = await requesterAuthority(configuration, loadBindings);
      const client = new CaseworkClient(
        pick(configuration, CLIENT_CONFIG_FIELDS),
      );
      const outcome = await invoke(client, auth, input);
      result = {
        branch: "succeeded",
        value: outcome.value,
        ...(safeIdentifier(outcome.traceId) ? { traceId: outcome.traceId } : {}),
      };
    } catch (error) {
      result = failure(error, ClientError, ProviderError, deduplicateBy);
    }

    return {
      ...state,
      data: {
        ...dataObject(state),
        [resultName]: result,
      },
    };
  };
}

function validateInputs(name, input) {
  if (["caseworkCreated", "caseworkNote", "caseworkCancellation", "caseworkTaskGrant"].includes(name)) {
    requiredString(input.idempotencyKey, "idempotencyKey");
  }
  if (["caseworkItem", "caseworkNote", "caseworkNotes", "caseworkCancellation", "caseworkWorkItem", "caseworkTaskTemplates",
    "caseworkTaskGrants", "caseworkTaskGrant", "caseworkTaskRevocation"].includes(name)) requiredString(input.itemId, "itemId");
  if (["caseworkWorkItems", "caseworkWorkItem", "caseworkTaskTemplates", "caseworkTaskGrants", "caseworkTaskGrant",
    "caseworkTaskRevocation"].includes(name)) requiredString(input.sourceProfile, "sourceProfile");
  if (["caseworkNote", "caseworkCancellation", "caseworkTaskGrant"].includes(name)) requiredRevision(input.expectedRevision);
  if (name === "caseworkCreated") {
    requiredString(input.kind, "kind");
    requiredString(input.requesterReference, "requesterReference");
    requiredObject(input.display, "display");
  }
  if (name === "caseworkNote") requiredString(input.note, "note");
  if (name === "caseworkCancellation") requiredString(input.reason, "reason");
  if (name === "caseworkWorkItems") requiredObject(input.query, "query");
  if (name === "caseworkTaskGrant") {
    requiredString(input.templateId, "templateId");
    requiredString(input.templateVersion, "templateVersion");
  }
  if (name === "caseworkTaskRevocation" || name === "caseworkTaskStatus") requiredString(input.grantId, "grantId");
  if (["caseworkNotes", "caseworkTerminal"].includes(name)) pageQuery(input);
}

function failure(error, ClientError, ProviderError, deduplicateBy) {
  if (error instanceof OperationFailure) {
    return {
      branch: error.branch,
      problem: { code: error.code, retryable: false },
    };
  }
  if (ProviderError && error instanceof ProviderError) {
    const retryable = error.kind === "transport" || error.tokenKind === "transport";
    const branch = error.kind === "configuration" || error.kind === "invalid_request" ? "invalid_request"
      : retryable ? "retryable_infrastructure" : "authentication_failed";
    return { branch, problem: { code: "casework.token", retryable } };
  }
  if (!ClientError || !(error instanceof ClientError)) {
    return {
      branch: "failed",
      problem: { code: "operation.failed", retryable: false },
    };
  }

  const status = Number.isSafeInteger(error.status) ? error.status : 0;
  const code = safeProblemCode(error.code) ?? `casework.${error.kind}`;
  let branch = "failed";
  if (code === "cursor.expired") branch = "cursor_expired";
  else if (error.kind === "configuration" || error.kind === "invalid_request")
    branch = "invalid_request";
  else if (error.kind === "transport" || status === 429 || status >= 500)
    branch = "retryable_infrastructure";
  else if (status === 401 || code === "authentication.refused")
    branch = "authentication_failed";
  else if (status === 403) branch = "not_authorized";
  else if (status === 404) branch = "not_found";
  else if (status === 409 || status === 412) branch = "conflict";
  else if (status === 400 || status === 422) branch = "invalid_request";
  else if (error.kind === "protocol") branch = "protocol_failed";

  const validation = safeValidation(error.validation);
  return {
    branch,
    problem: {
      code,
      status,
      retryable: branch === "retryable_infrastructure",
    },
    ...(safeIdentifier(error.traceId) ? { traceId: error.traceId } : {}),
    ...(safeProblemCode(error.transportKind)
      ? { transportKind: error.transportKind }
      : {}),
    ...(safeProblemCode(error.protocolFailure)
      ? { protocolFailure: error.protocolFailure }
      : {}),
    ...(validation ? { validation } : {}),
    ...(branch === "cursor_expired" && deduplicateBy
      ? {
          recovery: {
            action: "restart_without_cursor",
            deduplicateBy,
          },
        }
      : {}),
  };
}

function caseworkConfiguration(state) {
  const root =
    state?.configuration &&
    typeof state.configuration === "object" &&
    !Array.isArray(state.configuration)
      ? state.configuration
      : {};
  const configuration = root.casework ?? root;
  if (
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration)
  ) {
    throw new OperationFailure("invalid_request", "configuration.invalid");
  }
  boundedString(configuration.baseUrl, "configuration.casework.baseUrl", 2048);
  if (configuration.authorization !== undefined && (!configuration.authorization || typeof configuration.authorization !== "object"
    || Array.isArray(configuration.authorization) || Object.keys(configuration.authorization).length !== 1
    || configuration.authorization.privateKeyJwt === undefined)) {
    throw new OperationFailure("invalid_request", "configuration.authentication");
  }
  if ((configuration.token === undefined) === (configuration.authorization === undefined)) {
    throw new OperationFailure("invalid_request", "configuration.authentication");
  }
  if (configuration.token !== undefined) boundedString(configuration.token, "configuration.casework.token", 16_384);
  boundedString(configuration.profile, "configuration.casework.profile", 128);
  for (const field of [
    "requestTimeoutMilliseconds",
    "connectTimeoutMilliseconds",
    "maxResponseBytes",
  ]) {
    if (configuration[field] !== undefined) {
      requiredPositiveInteger(configuration[field], `configuration.casework.${field}`);
    }
  }
  if (configuration.userAgent !== undefined) {
    boundedString(configuration.userAgent, "configuration.casework.userAgent", 512);
  }
  if (configuration.trustedRootCertificates !== undefined) {
    boundedString(
      configuration.trustedRootCertificates,
      "configuration.casework.trustedRootCertificates",
      262_144,
    );
  }
  return configuration;
}

async function requesterAuthority(configuration, loadBindings) {
  if (configuration.authorization?.privateKeyJwt !== undefined) {
    const { PrivateKeyJwt } = loadBindings();
    return { token: await new PrivateKeyJwt(configuration.authorization.privateKeyJwt).bearerToken(), profile: configuration.profile };
  }
  return {
    token: configuration.token,
    profile: configuration.profile,
  };
}

function pageQuery(input) {
  return {
    ...(input.cursor === undefined
      ? {}
      : { cursor: requiredString(input.cursor, "cursor") }),
    ...(input.limit === undefined
      ? {}
      : { limit: requiredPositiveInteger(input.limit, "limit") }),
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.length) {
    throw new OperationFailure("invalid_request", `${label}.required`);
  }
  return value;
}

function boundedString(value, label, maximumLength) {
  requiredString(value, label);
  if (value.length > maximumLength) {
    throw new OperationFailure("invalid_request", `${label}.too_long`);
  }
  return value;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationFailure("invalid_request", `${label}.object_required`);
  }
  return value;
}

function requiredRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OperationFailure(
      "invalid_request",
      "expectedRevision.safe_integer_required",
    );
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OperationFailure("invalid_request", `${label}.positive_integer_required`);
  }
  return value;
}

function requestedResultName(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !RESULT_NAME.test(value)) {
    throw new OperationFailure("invalid_request", "result_name.invalid");
  }
  return value;
}

function safeProblemCode(value) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}

function safeIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function safeValidation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (
    typeof value.path !== "string" ||
    value.path.length > 256 ||
    !/^[A-Za-z0-9_./~:-]*$/.test(value.path) ||
    !SAFE_VALIDATION_REASONS.has(value.reason)
  ) {
    return undefined;
  }
  return { path: value.path, reason: value.reason };
}

function pick(value, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

function dataObject(state) {
  return state?.data && typeof state.data === "object" && !Array.isArray(state.data)
    ? state.data
    : {};
}
