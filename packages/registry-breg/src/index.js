// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
export * from "@openfn/language-common";

const require = createRequire(import.meta.url);
const { BaseRegistryClient, BaseRegistryClientError, copy } = require("./native.cjs");

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

export function getRecordSchema(options = {}) {
  return operation(options, async (client, input) => document(
    await client.recordSchema(required(input.recordTypeIdentifier), input.accessProfile),
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

/** Start only an Action selected from current caller-filtered metadata. */
export function startProposal(options = {}) {
  return operation(options, async (client, input) => {
    const action = required(input.actionIdentifier);
    const profile = required(input.accessProfile);
    const key = required(input.idempotencyKey);
    const contract = await client.registryContract(profile);
    return client.startProposal(contract.selectAction(action, profile), input.inputs, key);
  }, proposalResult);
}

/** Read a Proposal with the selected profile's current Get authority. */
export function getProposal(options = {}) {
  return operation(options, async (client, input) => {
    const profile = required(input.accessProfile);
    const identifier = required(input.proposalIdentifier);
    const contract = await client.registryContract(profile);
    return client.getProposal(contract.selectProposalGet(profile), identifier);
  }, proposalResult);
}

/** Submit a matching Draft once; an observed terminal submission is an inert replay. */
export function submitProposal(options = {}) {
  return operation(options, async (client, input) => {
    const profile = required(input.accessProfile);
    const identifier = required(input.proposalIdentifier);
    const key = required(input.idempotencyKey);
    const expectedInputs = copy(input.expectedInputs);
    if (!expectedInputs || typeof expectedInputs !== "object" || Array.isArray(expectedInputs)) {
      throw new OperationFailure("invalid_request", "request.invalid");
    }
    const contract = await client.registryContract(profile);
    const proposal = await client.getProposal(contract.selectProposalGet(profile), identifier);
    const observed = proposalDocument(proposal);
    if (!isDeepStrictEqual(observed.input, expectedInputs)) {
      throw new OperationFailure("conflict", "proposal.input_mismatch");
    }
    if (observed.state === "draft") {
      const attempt = client.prepareProposal(proposal, "submit", {}, key);
      return { branch: "succeeded", value: proposalValue(await client.executeProposal(attempt)) };
    }
    if (["submitted", "applied", "rejected"].includes(observed.state)) {
      return { branch: "already_submitted", value: proposalValue(proposal) };
    }
    throw new OperationFailure("conflict", "proposal.unavailable");
  }, outcome => outcome);
}

function operation(options, invoke, normalize = completeResult) {
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
      result = normalize(outcome);
    } catch (error) {
      result = failure(error);
    }
    const as = typeof input?.as === "string" && input.as.length ? input.as : "breg";
    // OpenFn owns final credential removal. Removing configuration here breaks execute/each composition.
    return { ...state, data: { ...state.data, [as]: result } };
  };
}

function completeResult(outcome) {
  return { branch: "succeeded", ...pick(outcome, ["value", "etag", "location", "continuation", "traceId"]) };
}

function proposalDocument(proposal) {
  try { return JSON.parse(proposal.documentJson); }
  catch { throw new OperationFailure("protocol_failed", "response.invalid_json"); }
}

function proposalValue(proposal) {
  return pick(proposalDocument(proposal), ["id", "actionId", "state", "input", "submissionVersion",
    "revision", "effectDigest", "turn", "decision", "handoffRefusal", "applicationStatus"]);
}

function proposalResult(proposal) {
  return { branch: "succeeded", value: proposalValue(proposal) };
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
  if (error.kind === "configuration" || error.kind === "invalid-request"
    || (error.kind === "problem" && status === 400)) branch = "invalid_request";
  else if (error.kind === "transport" || (error.kind === "token" && error.tokenKind === "transport")
    || (error.kind === "problem" && (status === 429 || status >= 500))) branch = "retryable_infrastructure";
  else if (error.kind === "token" || status === 401) branch = "auth_failed";
  else if (status === 403 || error.kind === "metadata-selection") branch = "denied";
  else if (status === 404 || error.kind === "not-found") branch = "not_found";
  else if (status === 409 || status === 412) branch = "conflict";
  else if (error.kind === "protocol") branch = "protocol_failed";
  return {
    branch,
    problem: { code: `breg.${error.kind}`, status, retryable: branch === "retryable_infrastructure" },
    // Only typed diagnostics, never the SDK error message, response body, or caller inputs.
    ...pick(error, ["code", "refusalCode", "reasonCode", "traceId", "transportKind", "tokenKind"]),
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
