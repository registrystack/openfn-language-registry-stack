// SPDX-License-Identifier: Apache-2.0
// Persist nextCursor only after a succeeded page. Handle cursor_expired explicitly.
import { execute } from "@openfn/language-common";
import { pollCaseworkResults } from "../src/index.js";

execute(
  pollCaseworkResults((state) => ({
    cursor: state.data.caseworkTerminalCursor,
    limit: 25,
    as: "terminalResults",
  })),
);
