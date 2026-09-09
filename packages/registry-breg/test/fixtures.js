// Synthetic HTTP fixtures follow registry-breg-client/tests/write_http_boundary.rs.
export const ID = "00000000-0000-4000-8000-000000000001";
export const ETAG = '"breg-record-000000000001"';
export const ACTION_ETAG = '"breg-action-hmac-sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"';
export const DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
export const PROFILE = "company-writer";
const field = { id: "legal-name", apiName: "legalName", label: "Legal name", schema: { type: "string" }, required: true, nullable: true, readOnly: false, removable: true };
function operation(id, method, path, kind, request, create = [], patch = []) {
  return { id, method, path, operation: kind, sourceEntity: "company", responseEntity: "company", accessProfile: PROFILE,
    requiredCapabilities: kind === "submit_request" ? ["change_request_lifecycle"] : [], entityLabel: "Companies",
    identifier: { apiName: "id", location: "envelope" }, titleFields: ["legal-name"], fields: [field], readableFields: ["legal-name"],
    createWritableFields: create, patchWritableFields: patch, selectors: [], query: null, request: { fieldNames: "api", queryParameters: [], ...request } };
}
export function metadata() {
  return { id: "business-registry", version: "1.2.3", revision: `sha256:${"a".repeat(64)}`, metadataVersion: "1",
    entities: [{ id: "company", datasetIdentifier: "legal-entities", route: "companies", operations: [
      { operation: "create", accessProfile: PROFILE }, { operation: "patch", accessProfile: PROFILE }, { operation: "submit_request", accessProfile: PROFILE },
    ], readableFields: ["legal-name"], schema: "/v1/schemas/company" }],
    operations: [
      operation("records.company.create", "POST", "/v1/records/companies", "create", {
        body: "data_envelope", contentType: "application/json", idempotencyKeyRequired: true, mutationSemantics: "direct",
        schema: { type: "object", additionalProperties: false, required: ["data"], properties: { data: { type: "object" } } },
      }, ["legal-name"]),
      operation("records.company.patch", "PATCH", "/v1/records/companies/{record_id}", "patch", {
        body: "json_patch", contentType: "application/json-patch+json", patchPathPrefix: "/data/", patchOperations: ["add", "replace", "remove", "test"],
        removeSemantics: "set_null", ifMatchRequired: true, idempotencyKeyRequired: true, mutationSemantics: "direct",
        schema: { type: "array", items: { oneOf: [{ type: "object" }] } },
      }, [], ["legal-name"]),
      operation("records.company.request.submit", "POST", "/v1/records/companies/{record_id}/actions/submit", "submit_request", {
        body: "change_request_action", contentType: "application/json", ifMatchRequired: true, idempotencyKeyRequired: true, mutationSemantics: "change_request_lifecycle",
        schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, properties: {} },
      }),
    ],
  };
}
export function record(lifecycle = false) {
  return { data: { recordIdentifier: ID, revisionIdentifier: lifecycle ? "7" : "1", domainData: { legalName: "Example Ltd" }, snapshot: `breg1_${ID}`,
    ...(lifecycle ? { request: { bregState: "draft", proposalVersion: 7, effectDigest: DIGEST, editable: true,
      actions: [{ operation: "submit_request", method: "POST", href: `/v1/records/companies/${ID}/actions/submit?accessProfile=${PROFILE}`, ifMatch: ACTION_ETAG }] } } : {}),
  }, meta: { registryIdentifier: "business-registry", datasetIdentifier: "legal-entities", entityTypeIdentifier: "company" } };
}
export function receipt() { return { id: ID, revision: 8, snapshot: `breg1_${ID}`, request: { bregState: "submitted", proposalVersion: 7, effectDigest: DIGEST, application: null } }; }
