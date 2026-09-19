// SPDX-License-Identifier: Apache-2.0
// Credentials and the bound Requester profile belong only in configuration.casework.
import { execute } from "@openfn/language-common";
import { createCaseworkRequest } from "../src/index.js";

execute(
  createCaseworkRequest((state) => ({
    request: state.data.caseworkRequest,
    expectedSubmissionDigest: state.data.caseworkSubmissionDigest,
    idempotencyKey: state.data.createIdempotencyKey,
    as: "createdCasework",
  })),
);
