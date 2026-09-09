// SPDX-License-Identifier: Apache-2.0
// Mount the reviewed SDK profile and set configuration.evidence.profilePath.
import { execute } from "@openfn/language-common";
import { requestEvidence } from "../src/index.js";

execute(requestEvidence({
  requirement: "adult-status",
  selectors: { record_reference: { valueFrom: "person_id" } },
  bindingReceipt: state => state.data.previous_receipt,
}));
