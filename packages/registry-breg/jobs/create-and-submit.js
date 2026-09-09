// SPDX-License-Identifier: Apache-2.0
// Supply the configured request entity's operation ID, route and profile in data.
// Credentials belong only in configuration.breg.
import { execute } from "@openfn/language-common";
import { createChangeRequest, getRecord, executeLifecycleAction } from "../src/index.js";

execute(
  createChangeRequest(state => ({
    operationIdentifier: state.data.createOperationIdentifier,
    accessProfile: state.data.accessProfile,
    data: state.data.requestFields,
    idempotencyKey: state.data.createIdempotencyKey,
    as: "draft",
  })),
  state => {
    if (state.data.draft.branch !== "succeeded") return state;
    return getRecord({ route: state.data.requestRoute,
      recordIdentifier: state.data.draft.value.data.recordIdentifier,
      accessProfile: state.data.accessProfile, as: "currentRequest" })(state);
  },
  state => {
    if (state.data.currentRequest?.branch !== "succeeded") return state;
    const record = state.data.currentRequest.value;
    const action = record.data.request?.actions?.find(item => item.operation === "submit_request");
    if (!action) return { ...state, data: { ...state.data, submission: {
      branch: "denied", problem: { code: "action.unavailable", retryable: false },
    } } };
    return executeLifecycleAction({
      entityIdentifier: record.meta.entityTypeIdentifier,
      route: state.data.requestRoute,
      recordIdentifier: record.data.recordIdentifier,
      accessProfile: state.data.accessProfile,
      operation: "submit_request",
      ifMatch: action.ifMatch,
      idempotencyKey: state.data.submitIdempotencyKey,
      as: "submission",
    })(state);
  },
);
