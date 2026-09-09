// SPDX-License-Identifier: Apache-2.0
//
// OpenFn workflow template for one signed Registry Stack Evidence request.

import { execute } from "@openfn/language-common";
import { requestEvidence } from "../src/index.js";

execute(
  requestEvidence({
    requirement: "urn:example:requirement:adult-status:v1",
    purpose: "benefit-eligibility",
    audience: "urn:example:agency:benefits",
    evidenceType: "urn:example:evidence-type:adult-status:v1",
    issuedBy: "urn:example:authority:population-registry",
    providedBy: "urn:example:data-service:evidence",
    configurationRevision: `sha256:${"0".repeat(64)}`,
    expectedAssuranceProfile: "production",
    subjects: [
      {
        role: "subject",
        selectorProfile: "civil-record-v1",
        selectorValues: { record_reference: { valueFrom: "person_id" } },
      },
    ],
    expectedOutputs: [
      { concept: "urn:example:concept:adult-status", form: "boolean" },
    ],
    maximumAssertionLifetimeSeconds: 300,
    clockSkewSeconds: 30,
    subjectExpectations: {
      pinned: [
        {
          role: "subject",
          binding: `urn:evidence:subject:v1_${"A".repeat(43)}`,
        },
      ],
    },
  }),
);
