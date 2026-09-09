// SPDX-License-Identifier: Apache-2.0
// Synthetic names. Replace the route, operation and profile with your published metadata.
import { execute } from "@openfn/language-common";
import { getRecord, patchRecord } from "../src/index.js";

execute(
  getRecord({ route: "companies", recordIdentifier: state => state.data.recordIdentifier,
    accessProfile: "company-writer", as: "current" }),
  state => {
    if (state.data.current.branch !== "succeeded") return state;
    return patchRecord({ operationIdentifier: "records.company.patch", accessProfile: "company-writer",
      recordIdentifier: state.data.recordIdentifier, etag: state.data.current.etag,
      idempotencyKey: state.data.idempotencyKey,
      operations: [{ op: "replace", field: "legalName", value: state.data.legalName }], as: "updated" })(state);
  },
);
