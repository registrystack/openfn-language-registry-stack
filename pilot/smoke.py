#!/usr/bin/env python3
"""Exercise the retained synthetic pilot; all credentials and command output stay private.

Run after provisioning: python3 pilot/smoke.py
Only after the main smoke passes, explicitly request retained-state restart proof:
  python3 pilot/smoke.py --restart-recovery
No command deletes containers, volumes, records, or the persisted smoke identity.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

REPO = Path(__file__).resolve().parent.parent
RUNTIME = REPO / 'pilot/agriculture/.runtime'
COMPOSE = [str(REPO / 'deployment/compose.sh')]
PROFILE = 'openfn-service'
SAFE_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


class SmokeFailure(Exception):
    """A deliberately value-free diagnostic suitable for the operator console."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(condition, message):
    if not condition:
        raise SmokeFailure(message)


def captured(args, label, timeout=120):
    try:
        result = subprocess.run(args, cwd=REPO, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise SmokeFailure(label + ' did not complete') from None
    if result.returncode:
        raise SmokeFailure(label + ' failed; subprocess output was withheld')
    return result.stdout


def json_output(value, label):
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        raise SmokeFailure(label + ' returned an invalid response') from None


def private_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
    temporary.chmod(0o600)
    os.replace(temporary, path)
    path.chmod(0o600)


def read_secret(path):
    try:
        value = path.read_text().strip()
    except OSError:
        raise SmokeFailure('Required private pilot configuration is not ready') from None
    require(bool(value), 'Required private pilot configuration is empty')
    return value


def http_json(url, *, method='GET', body=None, headers=None, timeout=20, parse_json=True):
    request = urllib.request.Request(url, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Accept': 'application/json', **({'Content-Type': 'application/json'} if body is not None else {}), **(headers or {})})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            return response.status, json_output(response.read().decode(), 'HTTP service') if parse_json else None
    except urllib.error.HTTPError as error:
        # Bodies may contain subjects, workflow inputs, or diagnostic details.
        # Keep only the status for failures; never render the response text.
        return error.code, None
    except (OSError, urllib.error.URLError, TimeoutError):
        raise SmokeFailure('A pilot HTTP exchange did not complete') from None


def operation_path(operation, record_id=None):
    path = operation.get('path')
    require(isinstance(path, str) and path.startswith('/v1/') and not any(value in path for value in ['?', '#', '..', '\\']), 'Metadata did not provide an expected relative Registry route')
    if record_id is not None:
        require(bool(SAFE_ID.fullmatch(record_id)), 'Registry returned an invalid record identifier')
        path = path.replace('{record_id}', record_id)
    require('{' not in path and '}' not in path, 'Metadata requires an unsupported route parameter')
    return path


class Pilot:
    def __init__(self, timeout=180):
        self.timeout = timeout
        self.secrets = RUNTIME / 'openfn/secrets'
        self.project = json_output(read_secret(self.secrets / 'project.json'), 'Pilot project')
        self.webhook_key = read_secret(self.secrets / 'webhook-api-key')
        self.admin_token = read_secret(self.secrets / 'api-token')
        self.state_path = RUNTIME / 'smoke-state.json'
        if self.state_path.exists():
            self.state = json_output(read_secret(self.state_path), 'Retained smoke state')
            require(self.state.get('schema') == 'registry-openfn-smoke/v1', 'Retained smoke state has an unsupported schema')
        else:
            # One fresh identity, persisted before effects. Every operation key and
            # synthetic selector thereafter derives deterministically from it.
            run_id = uuid.uuid4().hex[:16]
            self.state = {'schema': 'registry-openfn-smoke/v1', 'runId': run_id,
                'registration': {'submissionId': 'smoke-registration-' + run_id,
                    'localIdentifier': 'SYNTHETIC-SMOKE-' + run_id,
                    'name': 'Synthetci Smoke Holding ' + run_id},
                'correctedName': 'Synthetic Smoke Holding ' + run_id,
                'supportingReference': 'SYNTHETIC-SMOKE-SUPPORT-' + run_id,
                'reason': 'Synthetic acceptance spelling correction', 'phase': 'prepared'}
            self.save()

    def save(self):
        private_write(self.state_path, self.state)

    def token(self):
        value = captured(COMPOSE + ['run', '--rm', '--no-deps', 'tools', 'mint', 'token',
            '--url', 'http://127.0.0.1:8091/token', '--client-id', PROFILE,
            '--key', '/config/breg/clients/openfn-service/signing-p256-private-jwk'], 'Mint authentication').strip()
        require(value.count('.') == 2 and not any(character.isspace() for character in value), 'Mint did not return one access token')
        return value

    def breg(self, path, method='GET', body=None, headers=None):
        separator = '&' if '?' in path else '?'
        url = 'http://127.0.0.1:4002' + path + separator + urllib.parse.urlencode({'accessProfile': PROFILE})
        status, value = http_json(url, method=method, body=body,
            headers={'Authorization': 'Bearer ' + self.token(), **(headers or {})})
        require(200 <= status < 300, 'Registry acceptance request was refused (HTTP ' + str(status) + ')')
        return value

    def metadata(self):
        return self.breg('/v1/registry')

    def select(self, metadata, entity, kind):
        matches = [value for value in metadata.get('operations', []) if value.get('sourceEntity') == entity
            and value.get('operation') == kind and value.get('accessProfile') == PROFILE]
        require(len(matches) == 1, 'Caller-filtered metadata has no unique required operation')
        return matches[0]

    def farm(self):
        metadata = self.metadata()
        lookup = self.select(metadata, 'farm', 'lookup')
        selectors = [value for value in lookup.get('selectors', []) if value.get('id') == 'by-local-identifier']
        require(len(selectors) == 1 and selectors[0].get('requestFields') == ['localIdentifier'], 'Farm lookup selector differs from the pilot contract')
        return self.breg(operation_path(lookup), 'POST', {'selector': 'by-local-identifier', 'values': {'localIdentifier': self.state['registration']['localIdentifier']}})

    def current_request(self):
        metadata = self.metadata()
        get = self.select(metadata, 'name-correction', 'get')
        return self.breg(operation_path(get, self.state['requestId']))

    def poll_work_order(self, work_order_id, expect_success):
        require(isinstance(work_order_id, str) and bool(SAFE_ID.fullmatch(work_order_id)), 'OpenFn returned an invalid work-order identifier')
        end = time.monotonic() + self.timeout
        while time.monotonic() < end:
            status, value = http_json('http://127.0.0.1:4000/api/work_orders/' + work_order_id,
                headers={'Authorization': 'Bearer ' + self.admin_token})
            require(status == 200, 'OpenFn work-order inspection failed')
            state = value.get('data', {}).get('attributes', {}).get('state')
            if state in ['success', 'completed']:
                require(expect_success, 'Conflicting input unexpectedly succeeded')
                return
            if state in ['failed', 'crashed', 'killed', 'cancelled', 'exception', 'lost']:
                require(not expect_success, 'OpenFn workflow did not succeed')
                return
            time.sleep(1)
        raise SmokeFailure('OpenFn work order did not reach a terminal state within the deadline')

    def webhook(self, name, data, expect_success=True):
        trigger = self.project.get('triggerIds', {}).get(name)
        require(isinstance(trigger, str) and bool(SAFE_ID.fullmatch(trigger)), 'Private project configuration lacks a trigger')
        status, value = http_json('http://127.0.0.1:4000/i/' + trigger, method='POST', body=data,
            headers={'x-api-key': self.webhook_key}, timeout=self.timeout)
        if not expect_success and status == 422:
            return None
        require(200 <= status < 300, 'OpenFn webhook returned an unexpected HTTP status')
        # after_completion returns the final state. before_start returns a
        # work_order_id, whose documented JSONAPI state is polled explicitly.
        if isinstance(value, dict) and 'work_order_id' in value:
            self.poll_work_order(value['work_order_id'], expect_success)
        else:
            require(expect_success, 'Conflicting input unexpectedly succeeded')
        return value

    def destination(self):
        script = "const fs=require('node:fs');fetch('http://127.0.0.1:8082/status',{headers:{'x-destination-key':fs.readFileSync('/config/destination/api-key','utf8')}}).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))"
        return json_output(captured(COMPOSE + ['exec', '-T', 'destination', 'node', '-e', script], 'Destination status'), 'Destination status')

    def wait_destination(self, expected_effects):
        end = time.monotonic() + self.timeout
        while time.monotonic() < end:
            rows = self.destination_rows()
            effects = rows.get('effects')
            require(isinstance(effects, list), 'Destination storage diagnostics have an unexpected shape')
            count = len(effects)
            if count == expected_effects:
                require(len(rows.get('records', [])) == 1, 'Destination has no unique current record for the smoke')
                return rows
            require(count < expected_effects, 'Destination received an unexpected additional event for this smoke record')
            time.sleep(2)
        raise SmokeFailure('Verified destination effect did not arrive within the deadline')

    def destination_rows(self):
        # Private captured inspection proves the stored DTO contains only the
        # verified boolean, references and revision, with one effect per event.
        script = "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/destination.sqlite',{readOnly:true});const id=process.argv[1];process.stdout.write(JSON.stringify({records:d.prepare('SELECT * FROM records WHERE record_id=?').all(id),effects:d.prepare('SELECT * FROM effects WHERE record_id=?').all(id)}));d.close()"
        return json_output(captured(COMPOSE + ['exec', '-T', 'destination', 'node', '--no-warnings', '-e', script, self.state['recordId']], 'Private destination storage inspection'), 'Destination storage')

    def correction(self):
        return {'submissionId': 'smoke-correction-' + self.state['runId'], 'recordId': self.state['recordId'],
            'name': self.state['correctedName'], 'reason': self.state['reason'], 'supportingReference': self.state['supportingReference']}

    def recover_request_id(self, response):
        # Synchronous form workflows return minimal state; accept its documented
        # data wrapper, including the webhook's wrapper around the final state.
        for value in [response.get('data') if isinstance(response, dict) else None,
                      response.get('data', {}).get('data') if isinstance(response, dict) and isinstance(response.get('data'), dict) else None]:
            if isinstance(value, dict) and isinstance(value.get('requestId'), str) and SAFE_ID.fullmatch(value['requestId']):
                return value['requestId']
        # No list grant is added for diagnostics. An exact replay under the same
        # principal, profile, payload and durable key returns the original draft.
        metadata = self.metadata()
        operation = self.select(metadata, 'name-correction', 'create')
        correction = self.correction()
        fields = {'record': correction['recordId'], **{field: correction[field] for field in ['name', 'reason', 'supportingReference']}}
        value = self.breg(operation_path(operation), 'POST', {'data': fields},
            {'Idempotency-Key': 'correction:' + correction['submissionId']})
        identifier = value.get('data', {}).get('recordIdentifier')
        require(isinstance(identifier, str) and bool(SAFE_ID.fullmatch(identifier)), 'Correction replay did not return its original request identifier')
        return identifier

    def inspect_content(self, record):
        current = record.get('data', {}).get('domainData', {})
        expected = {'record': self.state['recordId'], 'name': self.state['correctedName'],
            'reason': self.state['reason'], 'supportingReference': self.state['supportingReference']}
        require(all(current.get(key) == value for key, value in expected.items()), 'Current correction differs from the retained submitted event')

    def review(self, action):
        captured(COMPOSE + ['run', '--rm', '--no-deps', 'tools', 'python3', '/opt/pilot/agriculture/review.py', action, self.state['requestId']], 'Explicit reviewer ' + action)

    def verify_retained(self):
        farm = self.farm()
        require(farm['data']['recordIdentifier'] == self.state['recordId'], 'Registration replay changed record identity')
        require(farm['data']['domainData'].get('name') == self.state['correctedName'], 'Applied correction is not retained')
        current = self.current_request()
        self.inspect_content(current)
        require(current['data'].get('request', {}).get('bregState') == 'applied', 'Reviewed correction is not applied')
        self.wait_destination(2)
        rows = self.destination_rows()
        require(len(rows.get('records', [])) == 1 and len(rows.get('effects', [])) == 2, 'Destination did not retain exactly one effect per farm event')
        require(all(row.get('outcome') == 'applied' for row in rows['effects']), 'Destination accepted an unexpected stale event')
        require(rows['records'][0].get('registered') == 1, 'Destination did not retain the verified boolean')
        require(len({row['event_id'] for row in rows['effects']}) == 2, 'Destination contains a repeated event identity')
        serialized = json.dumps(rows)
        require(self.state['registration']['name'] not in serialized and self.state['correctedName'] not in serialized,
            'Destination contains a raw farm name')

    def run(self):
        if 'baseline' not in self.state:
            self.state['baseline'] = self.destination()
            self.save()
        self.webhook('registration', self.state['registration'])
        farm = self.farm()
        record_id = farm.get('data', {}).get('recordIdentifier')
        require(isinstance(record_id, str) and bool(SAFE_ID.fullmatch(record_id)), 'Registration lookup returned no record identifier')
        if 'recordId' in self.state:
            require(self.state['recordId'] == record_id, 'Retained registration identity changed')
        self.state['recordId'] = record_id
        self.save()
        self.webhook('registration', self.state['registration'])
        self.webhook('registration', {**self.state['registration'], 'name': 'Conflicting synthetic retry'}, expect_success=False)
        if self.state.get('phase') == 'complete':
            self.webhook('correction', self.correction())
            self.verify_retained()
            return
        require(farm['data']['domainData'].get('name') in [self.state['registration']['name'], self.state['correctedName']], 'Farm state differs from the retained smoke input')
        if farm['data']['domainData'].get('name') == self.state['registration']['name']:
            self.wait_destination(1)
        response = self.webhook('correction', self.correction())
        request_id = self.recover_request_id(response)
        if 'requestId' in self.state:
            require(self.state['requestId'] == request_id, 'Correction replay changed request identity')
        self.state['requestId'] = request_id
        self.save()
        self.webhook('correction', self.correction())
        current = self.current_request()
        self.inspect_content(current)
        state = current['data'].get('request', {}).get('bregState')
        require(state in ['submitted', 'approved', 'applied'], 'Correction is not in an expected review state')
        if state == 'submitted':
            require(self.farm()['data']['domainData'].get('name') == self.state['registration']['name'], 'Submission changed the governed farm before approval')
            self.review('inspect')
            self.review('approve')
            require(self.farm()['data']['domainData'].get('name') == self.state['registration']['name'], 'Approval unexpectedly applied the correction')
            self.state['phase'] = 'approved'
            self.save()
            state = 'approved'
        if state == 'approved':
            require(self.farm()['data']['domainData'].get('name') == self.state['registration']['name'], 'Farm changed before explicit application')
            self.review('inspect')
            self.review('apply')
        self.verify_retained()
        self.state['phase'] = 'complete'
        self.save()
        self.webhook('registration', self.state['registration'])
        self.webhook('correction', self.correction())
        self.verify_retained()

    def restart_recovery(self):
        require(self.state.get('phase') == 'complete', 'Complete the main acceptance smoke before restart recovery')
        # Only restart these existing pilot services. Keep databases, Mint's
        # shared network namespace, and every named volume intact.
        captured(COMPOSE + ['restart', 'breg', 'worker', 'bridge', 'destination', 'lightning'], 'Retained-state pilot restart', timeout=180)
        end = time.monotonic() + self.timeout
        while time.monotonic() < end:
            try:
                status, _ = http_json('http://127.0.0.1:4000/health_check', timeout=5, parse_json=False)
                if status == 200:
                    break
            except SmokeFailure:
                pass
            time.sleep(2)
        else:
            raise SmokeFailure('Restarted OpenFn did not become ready')
        self.run()
        self.state['restartRecovery'] = 'passed'
        self.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restart-recovery', action='store_true')
    parser.add_argument('--timeout', type=int, default=180)
    args = parser.parse_args()
    os.umask(0o077)
    require(10 <= args.timeout <= 600, 'Timeout must be between 10 and 600 seconds')
    pilot = Pilot(args.timeout)
    if args.restart_recovery:
        pilot.restart_recovery()
    else:
        pilot.run()
    print(json.dumps({'status': 'passed', 'checks': ['registration', 'exact-replay', 'conflicting-retry',
        'governed-submit', 'separate-approval-and-application', 'verified-event-effects', 'retained-replay'],
        'restartRecovery': pilot.state.get('restartRecovery', 'not-run')}))


if __name__ == '__main__':
    try:
        main()
    except SmokeFailure as error:
        print('Pilot smoke failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('Pilot smoke failed: unexpected response or local configuration; details withheld', file=sys.stderr)
        sys.exit(1)
