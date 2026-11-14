// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module";
import { createCaseworkOperations } from "./operations.js";

export * from "@openfn/language-common";
export { CaseworkCallerError } from "./operations.js";

const require = createRequire(import.meta.url);
const operations = createCaseworkOperations(() => require("./native.cjs"));

export const {
  createOrRecoverReviewRequest,
  getReviewRequest,
  getReviewResult,
  listReviewResults,
  addReviewNote,
  listReviewHistory,
  cancelReviewRequest,
  listCaseworkReviewTasks,
  getCaseworkReviewTask,
  previewCaseworkTaskTemplates,
  listCaseworkTaskGrants,
  approveCaseworkTaskGrant,
  revokeCaseworkTaskGrant,
  caseworkTaskGrantStatus,
} = operations;
