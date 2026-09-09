import { createHash } from 'node:crypto';

// Stable identities make provisioning repeatable. This project is dedicated to the pilot.
export function id(name) {
  const bytes = createHash('sha256').update(`registry-openfn-agriculture-v1:${name}`).digest();
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const projectId = id('project');
export const triggerIds = Object.fromEntries(['registration', 'correction', 'committed'].map(name => [name, id(`${name}:trigger`)]));

const checked = `
fn(state => {
  const result = state.data.result;
  if (result.branch !== 'succeeded') {
    const error = new Error('Registry operation did not complete: ' + result.branch);
    error.name = 'RegistryWorkflowError';
    throw error;
  }
  return state;
});`;

export function projectDocument(bindings, credentials = {}, enabled = false) {
  const literal = value => JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const profile = literal(bindings.accessProfile);
  const validateSubmission = `fn(state => {
    const value = state.data.submissionId;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('A stable submissionId is required');
    return state;
  });`;
  const registration = `${validateSubmission}
createRecord(state => ({
  operationIdentifier: ${literal(bindings.createFarmOperation)}, accessProfile: ${profile},
  data: {localIdentifier: state.data.localIdentifier, name: state.data.name},
  idempotencyKey: 'registration:' + state.data.submissionId, as: 'result'
}));
${checked}
fn(state => ({data: {status: 'registered', recordId: state.data.result.value.data.recordIdentifier, traceId: state.data.result.traceId}}));`;
  const correction = `${validateSubmission}
createChangeRequest(state => ({
  operationIdentifier: ${literal(bindings.createCorrectionOperation)}, accessProfile: ${profile},
  entityIdentifier: 'name-correction', route: 'name-corrections',
  data: {record: state.data.recordId, name: state.data.name, reason: state.data.reason, supportingReference: state.data.supportingReference},
  idempotencyKey: 'correction:' + state.data.submissionId,
  as: 'result'
}));
${checked}
fn(state => ({...state, data: {...state.data, requestId: state.data.result.value.data.recordIdentifier}}));
getRecord(state => ({route: 'name-corrections', recordIdentifier: state.data.requestId, accessProfile: ${profile}, as: 'result'}));
${checked}
fn(async state => {
  const current = state.data.result.value.data;
  const expected = {record: state.data.recordId, name: state.data.name, reason: state.data.reason, supportingReference: state.data.supportingReference};
  if (Object.entries(expected).some(([field, value]) => typeof value !== 'string' || current.domainData[field] !== value)) {
    throw new Error('Correction content does not match the submitted event');
  }
  const request = current.request;
  const action = request?.actions?.find(action => action.operation === 'submit_request');
  if (action) {
    state = await executeLifecycleAction({
      entityIdentifier: 'name-correction', route: 'name-corrections',
      recordIdentifier: state.data.requestId, accessProfile: ${profile},
      operation: 'submit_request', ifMatch: action.ifMatch,
      idempotencyKey: 'correction-submit:' + state.data.submissionId, as: 'result'
    })(state);
    if (state.data.result.branch !== 'succeeded') throw new Error('Correction submission did not complete: ' + state.data.result.branch);
  } else if (!['submitted', 'approved', 'applied', 'rejected'].includes(request?.bregState)) {
    throw new Error('Correction is not ready for submission');
  }
  return {data: {status: action ? 'submitted' : 'already_submitted', requestId: state.data.requestId}};
});`;
  const evidence = `
fn(state => {
  const event = state.data.event;
  const committed = state.data.data;
  const delivery = state.data.delivery;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!event || typeof event.source !== 'string' || !event.source.startsWith('urn:registrystack:registry:') || event.source.length > 512 ||
      typeof event.id !== 'string' || !uuid.test(event.id) ||
      !committed || typeof committed.recordId !== 'string' || !uuid.test(committed.recordId) ||
      !Number.isSafeInteger(committed.revision) || committed.revision < 1 ||
      !Number.isSafeInteger(delivery?.generation) || delivery.generation < 1 ||
      typeof committed.values?.['local-identifier'] !== 'string' || !committed.values['local-identifier']) {
    throw new Error('A committed registry event with identity, revision, and selector is required');
  }
  return state;
});
requestEvidence({
  requirement: ${literal(bindings.requirement)},
  selectors: {'local-identifier': {valueFrom: 'data.values.local-identifier'}}, as: 'result'
});
fn(state => {
  const result = state.data.result;
  if (result.branch !== 'succeeded') throw new Error('Evidence request did not complete: ' + result.branch);
  if (selectSupportedValue(result.assertion, ${literal(bindings.registeredConcept)}) !== true) throw new Error('A verified registration assertion is required');
  // Revision identifies the committed event for destination ordering. The
  // assertion verifies current registration; it does not attest a historical
  // snapshot at that event revision. Never replace this with evidence metadata.
  return {data: {
    source: state.data.event.source, eventId: state.data.event.id, effect: 'record-sync',
    recordId: state.data.data.recordId, revision: state.data.data.revision,
    values: {registered: true}
  }, integration: {
    eventSource: state.data.event.source, eventId: state.data.event.id,
    committedRevision: state.data.data.revision, deliveryGeneration: state.data.delivery.generation,
    evidenceTraceId: result.trace_id ?? null, evidenceObservedAt: result.assertion.observedAt
  }};
});`;
  const destination = `post('/updates', state => state.data, {
  headers: state => ({'x-destination-key': state.configuration.apiKey}),
  maxRedirections: 0, retries: 0, timeout: 3000
});
fn(state => ({data: {status: state.data.status, revision: state.data.revision}, integration: state.integration}));`;

  function workflow(name, steps) {
    const jobs = steps.map(([key, adaptor, body, credential]) => ({
      id: id(`${name}:${key}`), name: key, adaptor, body,
      project_credential_id: credentials[credential] ?? null,
    }));
    return {
      id: id(name), name: `Agriculture ${name}`,
      jobs,
      triggers: [{id: triggerIds[name], type: 'webhook', enabled, has_auth_method: true,
        webhook_reply: name === 'committed' ? 'before_start' : 'after_completion',
        ...(name === 'committed' ? {} : {webhook_response_config: {success_code: 200, error_code: 422}}),
      }],
      edges: jobs.map((job, index) => ({
        id: id(`${name}:edge:${index}`), enabled: true, target_job_id: job.id,
        ...(index === 0 ? {source_trigger_id: triggerIds[name], condition_type: 'always'} : {source_job_id: jobs[index - 1].id, condition_type: 'on_job_success'}),
      })),
    };
  }
  return {
    id: projectId, name: 'registry-agriculture-pilot',
    description: 'Synthetic governed registration, correction, and signed registration evidence.',
    workflows: [
      workflow('registration', [['register', '@openfn/language-registry-breg@local', registration, 'breg']]),
      workflow('correction', [['submit-correction', '@openfn/language-registry-breg@local', correction, 'breg']]),
      workflow('committed', [
        ['verify-registration', '@openfn/language-registry-evidence@local', evidence, 'evidence'],
        ['record-update', '@openfn/language-http@local', destination, 'destination'],
      ]),
    ],
  };
}
