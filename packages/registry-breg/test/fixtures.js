// Synthetic HTTP fixtures follow registry-breg-client/tests/write_http_boundary.rs.
export const ID = "00000000-0000-4000-8000-000000000001";
export const ETAG = '"breg-record-000000000001"';
export const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
export const PROFILE = "company-writer";
const field = { id: "legal-name", apiName: "legalName", label: "Legal name", schema: { type: "string" }, required: true, nullable: true, readOnly: false, removable: true };
function operation(id, method, path, kind, request, create = [], patch = []) {
  return { id, method, path, operation: kind, sourceRecordType: "company", responseRecordType: "company", accessProfile: PROFILE,
    requiredCapabilities: [], recordTypeLabel: "Companies",
    identifier: { apiName: "id", location: "envelope" }, titleFields: ["legal-name"], fields: [field], readableFields: ["legal-name"], readableRequestFields: [],
    createWritableFields: create, patchWritableFields: patch, selectors: [], query: null, request: { fieldNames: "api", queryParameters: [], ...request } };
}
export function metadata() {
  return { id: "business-registry", version: "1.2.3", revision: `sha256:${"a".repeat(64)}`, metadataVersion: "2",
    recordTypes: [{ id: "company", datasetIdentifier: "legal-entities", route: "companies", operations: [
      { operation: "create", accessProfile: PROFILE }, { operation: "patch", accessProfile: PROFILE }
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
    ],
  };
}
export function record() {
  return { data: { recordIdentifier: ID, revisionIdentifier: "1", domainData: { legalName: "Example Ltd" } },
    meta: { registryIdentifier: "business-registry", datasetIdentifier: "legal-entities", recordTypeIdentifier: "company" } };
}
