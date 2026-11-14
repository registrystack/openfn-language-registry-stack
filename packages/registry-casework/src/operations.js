// SPDX-License-Identifier: Apache-2.0

const CLIENT_CONFIG_FIELDS = [
  "baseUrl",
  "attemptTimeoutMilliseconds",
  "connectTimeoutMilliseconds",
  "maximumResponseBytes",
  "userAgent",
  "trustedRootCertificates",
];
const CASEWORK_CONFIG_FIELDS = new Set([
  ...CLIENT_CONFIG_FIELDS,
  "token",
  "authorization",
  "profile",
]);
const SAFE_VALIDATION_REASONS = new Set([
  "binding-invalid",
  "field-required",
  "policy-not-allowed",
  "reference-invalid",
  "object-required",
  "maximum-bytes-exceeded",
  "maximum-depth-exceeded",
  "schema-mismatch",
  "outcome-not-declared",
  "reason-required",
  "text-invalid",
  "result-not-declared",
  "result-required",
  "field-not-declared",
  "constraint-invalid",
  "constraint-violated",
  "public-reason-required",
  "public-reason-not-declared",
  "approval-outcome-differs",
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

/** Create the bounded requester and task-inspection operations around maintained bindings. */
export function createCaseworkOperations(loadBindings) {
  if (typeof loadBindings !== "function") {
    throw new CaseworkCallerError("Casework client loader is required", {
      code: "client.loader_required",
    });
  }

  return {
    createOrRecoverReviewRequest: (options = {}) =>
      operation(
        loadBindings,
        options,
        "reviewRequestAccepted",
        null,
        (input) => {
          requiredObject(input.request, "request");
          requiredString(input.expectedSubmissionDigest, "expectedSubmissionDigest");
          requiredString(input.idempotencyKey, "idempotencyKey");
        },
        (client, auth, input) =>
          client.createOrRecoverReviewRequest(
            auth.token,
            auth.profile,
            input.idempotencyKey,
            input.request,
            input.expectedSubmissionDigest,
          ),
      ),

    getReviewRequest: (options = {}) =>
      operation(
        loadBindings,
        options,
        "reviewRequest",
        null,
        (input) => requiredString(input.requestId, "requestId"),
        (client, auth, input) =>
          client.reviewRequest(auth.token, auth.profile, input.requestId),
      ),

    getReviewResult: (options = {}) =>
      operation(
        loadBindings,
        options,
        "reviewResult",
        null,
        (input) => requiredObject(input.accepted, "accepted"),
        (client, auth, input) =>
          client.reviewResult(auth.token, auth.profile, input.accepted),
        reviewResult,
      ),

    listReviewResults: (options = {}) =>
      operation(
        loadBindings,
        options,
        "reviewResults",
        "eventId",
        pageQuery,
        (client, auth, input) =>
          client.reviewResults(auth.token, auth.profile, pageQuery(input)),
      ),

    addReviewNote: (options = {}) =>
      operation(
        loadBindings,
        options,
        "reviewNote",
        null,
        (input) => {
          requiredString(input.requestId, "requestId");
          requiredString(input.idempotencyKey, "idempotencyKey");
          requiredString(input.note, "note");
        },
        (client, auth, input) =>
          client.addReviewNote(
            auth.token,
            auth.profile,
            input.requestId,
            input.idempotencyKey,
            { audience: "requester", note: input.note },
          ),
      ),

    listReviewHistory: (options = {}) =>
      operation(
        loadBindings,
        options,
        "reviewHistory",
        "eventId",
        (input) => {
          requiredString(input.requestId, "requestId");
          pageQuery(input);
        },
        (client, auth, input) =>
          client.reviewHistory(
            auth.token,
            auth.profile,
            input.requestId,
            pageQuery(input),
          ),
      ),

    cancelReviewRequest: (options = {}) =>
      operation(
        loadBindings,
        options,
        "reviewCancellation",
        null,
        (input) => {
          requiredObject(input.accepted, "accepted");
          requiredString(input.idempotencyKey, "idempotencyKey");
          requiredObject(input.cancellation, "cancellation");
        },
        (client, auth, input) =>
          client.cancelReviewRequest(
            auth.token,
            auth.profile,
            input.accepted,
            input.idempotencyKey,
            input.cancellation,
          ),
      ),

    listCaseworkReviewTasks: (options = {}) =>
      operation(
        loadBindings,
        options,
        "caseworkReviewTasks",
        null,
        (input) => {
          optionalString(input.sourceProfile, "sourceProfile");
          if (input.query !== undefined) requiredObject(input.query, "query");
        },
        (client, auth, input) =>
          client.reviewTasks(
            auth.token,
            auth.profile,
            input.query ?? {},
            input.sourceProfile,
          ),
      ),

    getCaseworkReviewTask: (options = {}) =>
      taskOperation(loadBindings, options, "caseworkReviewTask", (client, auth, input) =>
        client.reviewTask(
          auth.token,
          auth.profile,
          input.taskId,
          input.sourceProfile,
        )),

    previewCaseworkTaskTemplates: (options = {}) =>
      taskOperation(loadBindings, options, "caseworkTaskTemplates", (client, auth, input) =>
        client.previewReviewTaskTemplates(
          auth.token,
          auth.profile,
          taskGrantReadOptions(input),
        )),

    listCaseworkTaskGrants: (options = {}) =>
      taskOperation(loadBindings, options, "caseworkTaskGrants", (client, auth, input) =>
        client.listReviewTaskGrants(
          auth.token,
          auth.profile,
          taskGrantReadOptions(input),
        )),

    approveCaseworkTaskGrant: (options = {}) =>
      operation(
        loadBindings,
        options,
        "caseworkTaskGrant",
        null,
        (input) => {
          reviewTask(input);
          requiredRevision(input.expectedRevision);
          requiredString(input.idempotencyKey, "idempotencyKey");
          requiredString(input.templateId, "templateId");
          requiredString(input.templateVersion, "templateVersion");
        },
        (client, auth, input) =>
          client.approveReviewTaskGrant(
            auth.token,
            auth.profile,
            input.taskId,
            input.expectedRevision,
            input.idempotencyKey,
            {
              templateId: input.templateId,
              templateVersion: input.templateVersion,
            },
            input.sourceProfile,
          ),
      ),

    revokeCaseworkTaskGrant: (options = {}) =>
      operation(
        loadBindings,
        options,
        "caseworkTaskRevocation",
        null,
        (input) => {
          requiredString(input.taskId, "taskId");
          requiredString(input.grantId, "grantId");
        },
        (client, auth, input) =>
          client.revokeReviewTaskGrant(
            auth.token,
            auth.profile,
            input.taskId,
            input.grantId,
          ),
      ),

    caseworkTaskGrantStatus: (options = {}) =>
      operation(
        loadBindings,
        options,
        "caseworkTaskStatus",
        null,
        (input) => requiredString(input.grantId, "grantId"),
        (client, auth, input) => client.taskGrantStatus(auth.token, input.grantId),
      ),
  };
}

function taskOperation(loadBindings, options, defaultName, invoke) {
  return operation(loadBindings, options, defaultName, null, reviewTask, invoke);
}

function reviewTask(input) {
  requiredString(input.taskId, "taskId");
  optionalString(input.sourceProfile, "sourceProfile");
}

function taskGrantReadOptions(input) {
  return {
    taskId: input.taskId,
    ...(input.sourceProfile === undefined ? {} : { sourceProfile: input.sourceProfile }),
  };
}

function operation(
  loadBindings,
  options,
  defaultName,
  deduplicateBy,
  validate,
  invoke,
  normalize = completeResult,
) {
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
      validate(input);
      const {
        CaseworkClient,
        CaseworkClientError,
        PrivateKeyJwt,
        ProviderError: TokenError,
      } = loadBindings();
      ClientError = CaseworkClientError;
      ProviderError = TokenError;
      const configuration = caseworkConfiguration(state);
      const auth = await requesterAuthority(configuration, PrivateKeyJwt);
      const clientConfiguration = pick(configuration, CLIENT_CONFIG_FIELDS);
      const client = new CaseworkClient(clientConfiguration);
      result = normalize(await invoke(client, auth, input));
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

function completeResult(outcome) {
  return {
    branch: "succeeded",
    value: outcome.value,
    ...(safeIdentifier(outcome.traceId) ? { traceId: outcome.traceId } : {}),
  };
}

function reviewResult(outcome) {
  const trace = safeIdentifier(outcome.traceId) ? { traceId: outcome.traceId } : {};
  if (outcome.kind === "available") {
    return { branch: "available", value: outcome.value, ...trace };
  }
  if (
    outcome.kind === "pending" ||
    outcome.kind === "concealed_or_unknown" ||
    outcome.kind === "expired"
  ) {
    return { branch: outcome.kind, value: null, ...trace };
  }
  throw new OperationFailure("failed", "result.invalid");
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
    const branch =
      error.kind === "configuration" || error.kind === "invalid-request"
        ? "invalid_request"
        : retryable
          ? "retryable_infrastructure"
          : "authentication_failed";
    return {
      branch,
      problem: { code: "casework.token", retryable },
    };
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
  else if (error.kind === "configuration" || error.kind === "invalid-request")
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
  const configuration = root.casework;
  if (
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration)
  ) {
    throw new OperationFailure("invalid_request", "configuration.invalid");
  }
  if (Object.keys(configuration).some((field) => !CASEWORK_CONFIG_FIELDS.has(field))) {
    throw new OperationFailure("invalid_request", "configuration.casework.unknown_field");
  }
  boundedString(configuration.baseUrl, "configuration.casework.baseUrl", 2048);
  if (
    configuration.authorization !== undefined &&
    (!configuration.authorization ||
      typeof configuration.authorization !== "object" ||
      Array.isArray(configuration.authorization) ||
      Object.keys(configuration.authorization).length !== 1 ||
      configuration.authorization.privateKeyJwt === undefined)
  ) {
    throw new OperationFailure("invalid_request", "configuration.authentication");
  }
  if ((configuration.token === undefined) === (configuration.authorization === undefined)) {
    throw new OperationFailure("invalid_request", "configuration.authentication");
  }
  if (configuration.token !== undefined) {
    boundedString(configuration.token, "configuration.casework.token", 16_384);
  }
  boundedString(configuration.profile, "configuration.casework.profile", 128);
  for (const field of [
    "attemptTimeoutMilliseconds",
    "connectTimeoutMilliseconds",
    "maximumResponseBytes",
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

async function requesterAuthority(configuration, PrivateKeyJwt) {
  if (configuration.authorization?.privateKeyJwt !== undefined) {
    if (typeof PrivateKeyJwt !== "function") {
      throw new OperationFailure("failed", "client.token_provider_unavailable");
    }
    return {
      token: await new PrivateKeyJwt(
        configuration.authorization.privateKeyJwt,
      ).bearerToken(),
      profile: configuration.profile,
    };
  }
  return { token: configuration.token, profile: configuration.profile };
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

function optionalString(value, label) {
  if (value !== undefined) requiredString(value, label);
}

function boundedString(value, label, maximumLength) {
  requiredString(value, label);
  if (value.length > maximumLength) {
    throw new OperationFailure("invalid_request", `${label}.too_long`);
  }
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
