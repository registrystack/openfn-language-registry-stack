import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { DurableInbox } from './inbox.js';

export const EVENT_PATH = '/events/breg';
const SIGNED_HEADERS = [
  'ce-specversion', 'ce-id', 'ce-source', 'ce-type', 'ce-time', 'ce-dataschema',
  'x-registry-event-generation', 'x-registry-delivery-attempt', 'x-registry-delivery-time',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class Refusal extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

function positive(value, fallback, maximum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error('invalid configuration');
  return number;
}

export function loadConfig(env = process.env) {
  try {
    const hmacKey = readFileSync(env.BREG_HMAC_KEY_FILE);
    const eventPath = env.BREG_EVENT_PATH ?? EVENT_PATH;
    const bindHost = env.BREG_BIND_HOST ?? '0.0.0.0';
    const deliveryMode = env.OPENFN_DELIVERY_MODE ?? 'webhook';
    if (!['webhook', 'cli'].includes(deliveryMode)) throw new Error('invalid delivery mode');
    const apiKey = deliveryMode === 'webhook' ? readFileSync(env.OPENFN_API_KEY_FILE, 'utf8') : undefined;
    const expectedEvents = JSON.parse(readFileSync(env.BREG_EXPECTED_EVENTS_FILE, 'utf8'));
    const allowedValueFields = JSON.parse(readFileSync(env.BREG_ALLOWED_VALUE_FIELDS_FILE, 'utf8'));
    const url = deliveryMode === 'webhook' ? new URL(env.OPENFN_WEBHOOK_URL) : undefined;
    if (hmacKey.length < 32 || !/^\/events\/[a-z0-9][a-z0-9-]{0,63}$/.test(eventPath) ||
        !['0.0.0.0', '127.0.0.1'].includes(bindHost) ||
        (apiKey !== undefined && !/^[\x21-\x7e]+$/.test(apiKey)) ||
        !env.BREG_EXPECTED_SOURCE || !env.BREG_EXPECTED_ENTITY ||
        !object(expectedEvents) || Object.keys(expectedEvents).length === 0 ||
        Object.entries(expectedEvents).some(([type, binding]) => !type || !object(binding) ||
          typeof binding.schema !== 'string' || !binding.schema || !['created', 'patched', 'request_lifecycle'].includes(binding.trigger) ||
          (binding.entity !== undefined && (typeof binding.entity !== 'string' || !binding.entity)) ||
          (binding.valueFields !== undefined && (!Array.isArray(binding.valueFields) ||
            binding.valueFields.some(field => typeof field !== 'string' || !field) ||
            new Set(binding.valueFields).size !== binding.valueFields.length)) ||
          (deliveryMode === 'cli' && (typeof binding.effect !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding.effect)))) ||
        !Array.isArray(allowedValueFields) ||
        allowedValueFields.some(field => typeof field !== 'string' || !field) ||
        new Set(allowedValueFields).size !== allowedValueFields.length ||
        (deliveryMode === 'cli' && (!env.OPENFN_INBOX_PATH || env.OPENFN_WEBHOOK_URL || env.OPENFN_API_KEY_FILE)) ||
        (url && (url.username || url.password || url.hash || url.search ||
          (url.protocol !== 'https:' && !(url.protocol === 'http:' && env.ALLOW_HTTP === 'true'))))) {
      throw new Error('invalid configuration');
    }
    return {
      hmacKey, apiKey, expectedEvents, allowedValueFields, deliveryMode,
      inboxPath: env.OPENFN_INBOX_PATH,
      expectedSource: env.BREG_EXPECTED_SOURCE, expectedEntity: env.BREG_EXPECTED_ENTITY,
      eventPath, bindHost,
      openfnUrl: url, port: positive(env.PORT, 8081, 65535),
      maxBodyBytes: positive(env.MAX_BODY_BYTES, 65536, 1048576),
      maxDeliverySkewSeconds: positive(env.MAX_DELIVERY_SKEW_SECONDS, 300, 3600),
      timeoutMs: positive(env.OPENFN_TIMEOUT_MS, 3000, 30000),
    };
  } catch {
    // File paths and parser errors can include operator secrets or input values.
    throw new Error('invalid bridge configuration');
  }
}

export function webhookSignature(key, headers, body, method = 'POST', path = EVENT_PATH) {
  const mac = createHmac('sha256', key).update('breg-webhook-signature-v1', 'ascii');
  const values = [...SIGNED_HEADERS.map(name => Buffer.from(headers[name], 'latin1')),
    Buffer.from(method), Buffer.from(path), Buffer.from(headers['content-type'], 'latin1'),
    Buffer.from(headers['idempotency-key'], 'latin1'), body];
  for (const value of values) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(value.length));
    mac.update(length).update(value);
  }
  return `v1=${mac.digest('base64url')}`;
}

function verifyHeaders(request, config) {
  const required = [...SIGNED_HEADERS, 'content-type', 'idempotency-key', 'x-registry-signature'];
  for (const name of required) {
    const matches = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name);
    if (matches.length !== 1 || typeof request.headers[name] !== 'string' || !request.headers[name]) {
      throw new Refusal(400, 'invalid_event');
    }
  }
  const h = request.headers;
  const binding = Object.hasOwn(config.expectedEvents, h['ce-type']) ? config.expectedEvents[h['ce-type']] : undefined;
  const schema = binding?.schema;
  const delivered = Date.parse(h['x-registry-delivery-time']);
  if (h['content-type'] !== 'application/json' || h['content-encoding'] !== undefined ||
      h['ce-specversion'] !== '1.0' || h['ce-source'] !== config.expectedSource ||
      !binding || h['ce-dataschema'] !== schema || !UUID.test(h['ce-id']) ||
      !DATE.test(h['ce-time']) || !Number.isFinite(Date.parse(h['ce-time'])) ||
      !DATE.test(h['x-registry-delivery-time']) || !Number.isFinite(delivered) ||
      Math.abs(Date.now() - delivered) > config.maxDeliverySkewSeconds * 1000 ||
      !DIGEST.test(h['idempotency-key']) ||
      !['x-registry-event-generation', 'x-registry-delivery-attempt'].every(name =>
        /^[1-9]\d*$/.test(h[name]) && Number.isSafeInteger(Number(h[name])))) {
    throw new Refusal(400, 'invalid_event');
  }
  return binding;
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (error, body) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(body);
    };
    const timer = setTimeout(() => finish(new Refusal(408, 'request_timeout')), 5000);
    request.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) finish(new Refusal(413, 'body_too_large'));
      else chunks.push(chunk);
    });
    request.on('end', () => finish(size ? null : new Refusal(400, 'invalid_event'), Buffer.concat(chunks)));
    request.on('error', () => finish(new Refusal(400, 'invalid_event')));
  });
}

function verifyPayload(body, config, binding) {
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new Refusal(400, 'invalid_event'); }
  const fields = binding.valueFields ?? config.allowedValueFields;
  const keys = ['entity', 'recordId', 'revision', 'trigger', 'packageRevision', 'values'];
  if (binding.trigger === 'request_lifecycle') keys.push('request');
  if (!object(data) || Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key)) ||
      data.entity !== (binding.entity ?? config.expectedEntity) || typeof data.recordId !== 'string' || !UUID.test(data.recordId) ||
      !Number.isSafeInteger(data.revision) || data.revision < 1 ||
      typeof data.packageRevision !== 'string' || !DIGEST.test(data.packageRevision) ||
      !['created', 'patched', 'request_lifecycle'].includes(data.trigger) ||
      data.trigger !== binding.trigger || !object(data.values) ||
      Object.keys(data.values).length !== fields.length ||
      fields.some(field => !Object.hasOwn(data.values, field) ||
        typeof data.values[field] !== 'string' || Buffer.byteLength(data.values[field]) > 1024)) {
    throw new Refusal(400, 'invalid_event');
  }
  if (binding.trigger === 'request_lifecycle') verifyLifecycle(data.request);
  return data;
}

function verifyLifecycle(value) {
  const keys = ['proposalVersion', 'workflowRevision', 'transition', 'fromState', 'toState',
    'stage', 'reasonPresent', 'effectDigest', 'deduplicationKey'];
  const text = v => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 128;
  if (!object(value) || keys.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !keys.includes(key) && key !== 'reason') ||
      !['proposalVersion', 'workflowRevision'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 1) ||
      !['transition', 'fromState', 'toState'].every(key => text(value[key])) ||
      !(value.stage === null || text(value.stage)) || typeof value.reasonPresent !== 'boolean' ||
      !(value.effectDigest === null || (typeof value.effectDigest === 'string' && DIGEST.test(value.effectDigest))) ||
      typeof value.deduplicationKey !== 'string' || !DIGEST.test(value.deduplicationKey) ||
      (Object.hasOwn(value, 'reason') && (typeof value.reason !== 'string' || Buffer.byteLength(value.reason) > 8192))) {
    throw new Refusal(400, 'invalid_event');
  }
}

function forward(config, envelope) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(envelope));
    const transport = config.openfnUrl.protocol === 'https:' ? https : http;
    const request = transport.request(config.openfnUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': bytes.length,
        'x-api-key': config.apiKey },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 16384) { response.destroy(); reject(new Refusal(502, 'openfn_not_accepted')); }
        else chunks.push(chunk);
      });
      response.on('error', () => reject(new Refusal(502, 'openfn_unavailable')));
      response.on('end', () => {
        try {
          const accepted = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode < 200 || response.statusCode >= 300 ||
              !object(accepted) || typeof accepted.work_order_id !== 'string' || !UUID.test(accepted.work_order_id) ||
              Object.hasOwn(accepted, 'error')) throw new Error();
          resolve();
        } catch { reject(new Refusal(502, 'openfn_not_accepted')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Refusal(504, 'openfn_timeout')), config.timeoutMs);
    request.on('error', error => reject(error instanceof Refusal ? error : new Refusal(502, 'openfn_unavailable')));
    request.on('close', () => clearTimeout(timer));
    request.end(bytes);
  });
}

function respond(response, status, code) {
  if (!response.destroyed && !response.writableEnded) {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
      ...(status >= 400 ? { connection: 'close' } : {}) });
    response.end(JSON.stringify({ status: code }));
  }
}

export function createBridge(config) {
  const inbox = config.deliveryMode === 'cli' ? new DurableInbox(config.inboxPath) : undefined;
  const eventPath = config.eventPath ?? EVENT_PATH;
  const server = http.createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    try {
      if (request.url === '/healthz' && request.method === 'GET') return respond(response, 200, 'ok');
      if (request.url !== eventPath || request.method !== 'POST') return respond(response, 404, 'not_found');
      const binding = verifyHeaders(request, config);
      const body = await readBody(request, config.maxBodyBytes);
      const provided = request.headers['x-registry-signature'];
      const expected = webhookSignature(config.hmacKey, request.headers, body, 'POST', eventPath);
      if (!/^v1=[A-Za-z0-9_-]{43}$/.test(provided) ||
          !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) throw new Refusal(401, 'invalid_signature');
      const data = verifyPayload(body, config, binding);
      const h = request.headers;
      const envelope = {
        event: Object.fromEntries(['specversion', 'id', 'source', 'type', 'time', 'dataschema'].map(key => [key, h[`ce-${key}`]])),
        delivery: { generation: Number(h['x-registry-event-generation']), attempt: Number(h['x-registry-delivery-attempt']),
          time: h['x-registry-delivery-time'], idempotencyKey: h['idempotency-key'] },
        data,
      };
      if (inbox) inbox.accept(envelope, binding.effect);
      else await forward(config, envelope);
      respond(response, 202, 'accepted');
    } catch (error) { respond(response, error instanceof Refusal ? error.status : 503, error instanceof Refusal ? error.message : 'unavailable'); }
  });
  if (inbox) server.on('close', () => inbox.close());
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const server = createBridge(config);
    server.on('error', () => { process.stderr.write('bridge unavailable\n'); process.exitCode = 1; });
    server.listen(config.port, config.bindHost);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch { process.stderr.write('invalid bridge configuration\n'); process.exitCode = 1; }
}
