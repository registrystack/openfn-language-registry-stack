// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module";
export * from "@openfn/language-common";

const require = createRequire(import.meta.url);
const { BaseRegistryClient, BaseRegistryClientError } = require("./native.cjs");

class OperationFailure extends Error {
  constructor(branch, code) {
    super("Base Registry operation did not complete");
    this.branch = branch;
    this.code = code;
  }
}

/** Return caller-filtered descriptive metadata. Opaque write bindings stay local. */
export function discoverRegistry(options = {}) {
  return operation(options, async (client, input) => document(
    await client.registryMetadata(input.accessProfile),
  ));
}

export function getEntitySchema(options = {}) {
  return operation(options, async (client, input) => document(
    await client.entitySchema(required(input.entityIdentifier), input.accessProfile),
  ));
}

export function getRecord(options = {}) {
  return operation(options, (client, input) => client.getRecord(
    required(input.route), required(input.recordIdentifier), readOptions(input),
  ));
}

export function lookupRecord(options = {}) {
  return operation(options, (client, input) => client.lookupRecord(
    required(input.route), required(input.selector), input.values, readOptions(input),
  ));
}

/** Fetch one bounded page. Continue explicitly with its SDK continuation. */
export function listRecords(options = {}) {
  return operation(options, (client, input) => client.listRecords(
    required(input.route), pick(input, ["select", "accessProfile", "format", "top", "filter", "orderby", "count"]),
  ));
}

export function continueList(options = {}) {
  return operation(options, (client, input) => client.continueList(input.continuation));
}

export function createRecord(options = {}) {
  return operation(options, async (client, input) => {
    const key = required(input.idempotencyKey);
    const identifier = required(input.operationIdentifier);
    const profile = required(input.accessProfile);
    const metadata = await client.registryContract(profile);
    return client.createRecord(metadata.selectCreate(identifier, profile), input.data, key, input.format);
  });
}

/** Create a draft in the configured change-request entity. Submission is a separate lifecycle action. */
export function createChangeRequest(options = {}) {
  return createRecord(options);
}

export function patchRecord(options = {}) {
  return operation(options, async (client, input) => {
    const key = required(input.idempotencyKey);
    const etag = required(input.etag);
    const identifier = required(input.operationIdentifier);
    const profile = required(input.accessProfile);
    const recordIdentifier = required(input.recordIdentifier);
    const metadata = await client.registryContract(profile);
    return client.patchRecord(metadata.selectPatch(identifier, profile), recordIdentifier,
      etag, input.operations, key, input.format);
  });
}

/** Execute exactly one currently advertised action using a caller's held lifecycle precondition. */
export function executeLifecycleAction(options = {}) {
  return operation(options, async (client, input) => {
    const key = required(input.idempotencyKey);
    const ifMatch = required(input.ifMatch);
    const profile = required(input.accessProfile);
    const entity = required(input.entityIdentifier);
    const route = required(input.route);
    const recordIdentifier = required(input.recordIdentifier);
    const requestedOperation = required(input.operation);
    const metadata = await client.registryContract(profile);
    const authority = metadata.selectLifecycle(entity, profile);
    const record = await client.getRecord(route, recordIdentifier, { accessProfile: profile, format: input.format ?? "json" });
    const actions = client.lifecycleActions(authority, record.value, input.format);
    const selected = actions.filter((action) => action.operation === requestedOperation
      && (action.stage ?? null) === (input.stage ?? null));
    if (selected.length !== 1) throw new OperationFailure("denied", "action.unavailable");
    const action = selected[0];
    const advertised = record.value.data.request?.actions ?? [];
    if (!advertised.some((item) => item.href === action.href && item.operation === action.operation
      && (item.stage ?? null) === (action.stage ?? null) && item.ifMatch === ifMatch)) {
      throw new OperationFailure("conflict", "action.precondition_changed");
    }
    return client.executeLifecycleAction(action, key);
  });
}

function operation(options, invoke) {
  return async (state) => {
    let input;
    let result;
    try {
      const supplied = typeof options === "function" ? options(state) : options;
      if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
        throw new OperationFailure("invalid_request", "request.invalid");
      }
      // State functions are resolved at option boundaries; record graphs go intact to the SDK validator.
      input = Object.fromEntries(Object.entries(supplied).map(([key, value]) => [key,
        typeof value === "function" ? value(state) : value]));
      const configuration = state.configuration?.breg ?? state.configuration;
      const client = new BaseRegistryClient(configuration);
      const outcome = await invoke(client, input);
      result = { branch: "succeeded", ...pick(outcome, ["value", "etag", "location", "continuation", "traceId"]) };
    } catch (error) {
      result = failure(error);
    }
    const as = typeof input?.as === "string" && input.as.length ? input.as : "breg";
    // OpenFn owns final credential removal. Removing configuration here breaks execute/each composition.
    return { ...state, data: { ...state.data, [as]: result } };
  };
}

function failure(error) {
  if (error instanceof OperationFailure) {
    return { branch: error.branch, problem: { code: error.code, retryable: false } };
  }
  if (!(error instanceof BaseRegistryClientError)) {
    return { branch: "failed", problem: { code: "operation.failed", retryable: false } };
  }
  const status = Number.isSafeInteger(error.status) ? error.status : 0;
  let branch = "failed";
  if (error.kind === "configuration" || error.kind === "invalid_request") branch = "invalid_request";
  else if (error.kind === "transport" || (error.kind === "token" && error.tokenKind === "transport")
    || (error.kind === "problem" && (status === 429 || status >= 500))) branch = "retryable_infrastructure";
  else if (error.kind === "token" || status === 401) branch = "auth_failed";
  else if (status === 403 || error.kind === "metadata_selection") branch = "denied";
  else if (status === 404 || error.kind === "not_found") branch = "not_found";
  else if (status === 409 || status === 412) branch = "conflict";
  else if (error.kind === "protocol") branch = "protocol_failed";
  return {
    branch,
    problem: { code: `breg.${error.kind}`, status, retryable: branch === "retryable_infrastructure" },
    // Only typed diagnostics, never the SDK error message, response body, or caller inputs.
    ...pick(error, ["code", "planRefusal", "traceId", "transportKind", "tokenKind"]),
  };
}

function required(value) {
  if (typeof value !== "string" || !value.trim()) throw new OperationFailure("invalid_request", "request.required");
  return value;
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function readOptions(input) { return pick(input, ["select", "accessProfile", "format"]); }

function document(outcome) {
  try { return { ...outcome, value: JSON.parse(outcome.body.toString("utf8")) }; }
  catch { throw new OperationFailure("protocol_failed", "response.invalid_json"); }
}
