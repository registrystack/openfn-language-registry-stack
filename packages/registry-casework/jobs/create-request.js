// SPDX-License-Identifier: Apache-2.0
// Credentials and the bound Requester profile belong only in configuration.casework.
import { execute } from "@openfn/language-common";
import { createCaseworkItem } from "../src/index.js";

execute(
  createCaseworkItem((state) => ({
    kind: state.data.caseworkKind,
    requesterReference: state.data.requesterReference,
    display: state.data.display,
    idempotencyKey: state.data.createIdempotencyKey,
    as: "createdCasework",
  })),
);
