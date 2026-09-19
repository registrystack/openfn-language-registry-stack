// SPDX-License-Identifier: Apache-2.0
// CLI fixture: prove that one job imports both maintained adaptors through their aliases.
import { execute, requestEvidence } from "@openfn/language-registry-evidence";
import { createCaseworkRequest } from "@openfn/language-registry-casework";

execute(async state => ({
  ...state,
  data: { ...state.data, adaptorsReady: typeof requestEvidence === "function" && typeof createCaseworkRequest === "function" },
}));
