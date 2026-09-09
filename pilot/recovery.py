#!/usr/bin/env python3
"""Bounded live failure/recovery acceptance for the dedicated synthetic pilot.

Run --retry-smoke after repairing a failed accepted smoke work order.
Run --replay-smoke after its destination effects are verified, if BREG retained
the same event as a dead letter because its earlier acknowledgement was lost.
Run --scenario before-accept|after-accept|pending-restart|all only while the
dedicated pilot is idle. These scenarios briefly stop their named services,
create three separate retained synthetic identities, and restore service
availability in finally blocks. No volume, record, dataclip, or event is erased.
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

from smoke import (COMPOSE, REPO, RUNTIME, SAFE_ID, Pilot, SmokeFailure, captured,
    http_json, json_output, operation_path, private_write, read_secret, require)

FAILURES = {'failed', 'crashed', 'killed', 'cancelled', 'exception', 'lost'}
SUCCESS = {'success', 'completed'}


def rpc(record_id, action='inspect', **arguments):
    require(isinstance(record_id, str) and bool(SAFE_ID.fullmatch(record_id)), 'Invalid recovery record identity')
    document = json.dumps({'action': action, 'recordId': record_id, **arguments}, separators=(',', ':'))
    encoded = base64.urlsafe_b64encode(document.encode()).decode('ascii')
    expression = 'Code.eval_string(File.read!("/opt/pilot/lightning/recovery.exs"), [pilot_recovery_request: Base.url_decode64!("' + encoded + '")], file: "/opt/pilot/lightning/recovery.exs"); :ok'
    output = captured(COMPOSE + ['exec', '-T', 'lightning', '/app/bin/lightning', 'rpc', expression],
        'Scoped OpenFn recovery ' + action)
    lines = [line.removeprefix('PILOT_RECOVERY_JSON:') for line in output.splitlines() if line.startswith('PILOT_RECOVERY_JSON:')]
    require(len(lines) == 1, 'Scoped OpenFn recovery did not return one report')
    return json_output(lines[0], 'Scoped OpenFn recovery')


def database(query):
    # SQL is authored here and contains only validated UUIDs. Credentials remain
    # in the existing database container environment, and output stays captured.
    command = COMPOSE + ['exec', '-T', 'breg-db', 'sh', '-c',
        'exec psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d agriculture']
    try:
        result = subprocess.run(command, cwd=REPO, input='BEGIN READ ONLY;\n' + query + '\nROLLBACK;\n',
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise SmokeFailure('Read-only delivery inspection did not complete') from None
    require(result.returncode == 0, 'Read-only delivery inspection failed; output withheld')
    lines = [line for line in result.stdout.splitlines() if line and line not in ['BEGIN', 'ROLLBACK']]
    require(len(lines) == 1, 'Delivery inspection returned an unexpected shape')
    return json_output(lines[0], 'Delivery inspection')


def event_for_record(record_id):
    require(bool(SAFE_ID.fullmatch(record_id)), 'Invalid recovery record identity')
    return database("SELECT coalesce(json_agg(event_id), '[]'::json) FROM registry_internal.registry_outbox "
        "WHERE entity_id='farm' AND payload IS NOT NULL AND "
        "convert_from(payload,'UTF8')::jsonb->>'recordId'='" + record_id + "';")


def delivery(event_id):
    require(isinstance(event_id, str) and bool(SAFE_ID.fullmatch(event_id)), 'Invalid recovery event identity')
    rows = database("SELECT coalesce(json_agg(json_build_object('eventId',s.event_id,'deliveryId',s.compiled_delivery_id,"
        "'generation',s.generation,'state',s.state,'attempt',s.attempt,'payloadAvailable',o.payload IS NOT NULL)), '[]'::json) "
        "FROM registry_internal.registry_webhook_delivery_state s JOIN registry_internal.registry_outbox o USING(event_id) "
        "WHERE s.event_id='" + event_id + "';")
    require(isinstance(rows, list) and len(rows) == 1, 'Expected one scoped BREG delivery')
    return rows[0]


class Recovery:
    def __init__(self, timeout=180):
        self.timeout = timeout
        self.pilot = Pilot(timeout)
        self.path = RUNTIME / 'recovery-state.json'
        if self.path.exists():
            self.state = json_output(read_secret(self.path), 'Retained recovery state')
            require(self.state.get('schema') == 'registry-openfn-recovery/v1', 'Unsupported recovery state')
        else:
            self.state = {'schema': 'registry-openfn-recovery/v1', 'runId': uuid.uuid4().hex[:16], 'scenarios': {}}
            self.save()

    def save(self):
        private_write(self.path, self.state)

    def poll(self, function, condition, label):
        end = time.monotonic() + self.timeout
        while time.monotonic() < end:
            try:
                # Only read-only observations are passed here. Service restart
                # can interrupt one RPC without invalidating accepted work.
                value = function()
            except SmokeFailure:
                time.sleep(2)
                continue
            if condition(value):
                return value
            time.sleep(2)
        raise SmokeFailure(label + ' did not complete within the deadline')

    def service(self, command, *services):
        allowed = {'lightning', 'bridge', 'breg', 'worker', 'destination'}
        require(command in {'stop', 'start', 'restart'} and set(services) <= allowed, 'Unsupported recovery service operation')
        captured(COMPOSE + [command, *services], 'Pilot recovery service ' + command, timeout=180)

    def ready(self):
        def probe():
            try:
                return http_json('http://127.0.0.1:4000/health_check', timeout=5, parse_json=False)[0]
            except SmokeFailure:
                return None
        self.poll(probe, lambda status: status == 200, 'OpenFn readiness')

    def destination_ready(self):
        def probe():
            try:
                return self.pilot.destination()
            except SmokeFailure:
                return None
        self.poll(probe, lambda status: isinstance(status, dict), 'Destination readiness')

    def registry_ready(self):
        def probe():
            try:
                return self.pilot.metadata()
            except SmokeFailure:
                return None
        self.poll(probe, lambda value: isinstance(value, dict), 'Registry readiness')

    def scenario(self, name):
        if name not in self.state['scenarios']:
            self.state['scenarios'][name] = {'phase': 'prepared', 'submissionId': 'recovery-' + name + '-' + self.state['runId'],
                'localIdentifier': 'SYNTHETIC-RECOVERY-' + name.upper() + '-' + self.state['runId']}
            self.save()
        return self.state['scenarios'][name]

    def create(self, scenario):
        metadata = self.pilot.metadata()
        operation = self.pilot.select(metadata, 'farm', 'create')
        body = {'data': {'localIdentifier': scenario['localIdentifier'], 'name': 'Synthetic Recovery Holding'}}
        response = self.pilot.breg(operation_path(operation), 'POST', body,
            {'Idempotency-Key': 'recovery:' + scenario['submissionId']})
        record_id = response.get('data', {}).get('recordIdentifier')
        require(isinstance(record_id, str) and bool(SAFE_ID.fullmatch(record_id)), 'Recovery create returned no record identity')
        require('recordId' not in scenario or scenario['recordId'] == record_id, 'Retained recovery record changed')
        scenario['recordId'] = record_id
        self.save()

    def orders(self, record_id):
        return rpc(record_id).get('workOrders', [])

    def accepted(self, scenario):
        orders = self.poll(lambda: self.orders(scenario['recordId']), lambda items: len(items) >= 1, 'OpenFn work-order acceptance')
        require(len({order['eventId'] for order in orders}) == 1, 'Unexpected recovery event multiplicity')
        scenario['eventId'] = orders[0]['eventId']
        self.save()
        observed = self.poll(lambda: delivery(scenario['eventId']), lambda item: item['state'] == 'delivered', 'BREG acceptance acknowledgement')
        require(observed['payloadAvailable'] is False, 'Delivered BREG event retained its payload unexpectedly')
        return orders

    def effects(self, record_id):
        original = self.pilot.state.get('recordId')
        self.pilot.state['recordId'] = record_id
        try:
            return self.pilot.destination_rows()
        finally:
            if original is None:
                self.pilot.state.pop('recordId', None)
            else:
                self.pilot.state['recordId'] = original

    def verify_effect(self, scenario):
        rows = self.poll(lambda: self.effects(scenario['recordId']), lambda value: len(value.get('effects', [])) == 1,
            'Recovered destination effect')
        require(len(rows.get('records', [])) == 1 and rows['records'][0]['registered'] == 1 and
            rows['records'][0]['revision'] == 1 and rows['effects'][0]['outcome'] == 'applied' and
            rows['effects'][0]['event_id'] == scenario['eventId'], 'Recovered effect differs from the retained event')
        self.poll(lambda: self.orders(scenario['recordId']),
            lambda orders: any(order['state'] in SUCCESS for order in orders), 'Recovered OpenFn completion')

    def retry_failed(self, record_id):
        orders = self.orders(record_id)
        require(bool(orders), 'No retained committed work order matches the record')
        results = []
        for order in orders:
            if order['state'] in FAILURES:
                require(bool(order.get('runs')), 'Failed work order has no retained run')
                results.append(rpc(record_id, 'retry', workOrderId=order['id'], expectedRunId=order['runs'][-1]['id']))
        self.poll(lambda: self.orders(record_id), lambda items: all(order['state'] in SUCCESS for order in items),
            'Retried OpenFn work order')
        return results

    def replay_smoke(self):
        record_id = self.pilot.state['recordId']
        orders = self.orders(record_id)
        require(bool(orders) and all(order['state'] in SUCCESS for order in orders),
            'Complete retained OpenFn retries before replaying its BREG event')
        before = self.effects(record_id)
        expected_events = {order['eventId'] for order in orders}
        require({row['event_id'] for row in before['effects']} == expected_events,
            'Verify destination effects before replaying BREG dead letters')
        replayed = 0
        for event_id in sorted(expected_events):
            observed = delivery(event_id)
            if observed['state'] == 'delivered':
                continue
            require(observed['state'] == 'dead_lettered' and observed['payloadAvailable'],
                'Smoke event is not a retained replayable dead letter')
            require(observed['deliveryId'] in ['events.farm.farm-created-v1.webhook', 'events.farm.farm-patched-v1.webhook'],
                'Unexpected compiled smoke delivery')
            captured(COMPOSE + ['run', '--rm', '--no-deps', 'tools', 'bregctl', '--format', 'json', 'webhook', 'replay',
                '--runtime-config', '/config/breg/runtime.json', '--event-id', event_id,
                '--delivery-id', observed['deliveryId'], '--expected-generation', str(observed['generation'])],
                'Explicit retained smoke BREG replay')
            settled = self.poll(lambda: delivery(event_id), lambda value: value['state'] == 'delivered',
                'Replayed smoke acknowledgement')
            require(settled['generation'] == observed['generation'] + 1 and settled['payloadAvailable'] is False,
                'Replayed smoke event did not retain its identity and advance one generation')
            replayed += 1
        self.poll(lambda: self.orders(record_id), lambda items: bool(items) and all(order['state'] in SUCCESS for order in items),
            'Replayed smoke work-order completion')
        after = self.effects(record_id)
        require(before == after, 'Replayed smoke event changed an already committed destination effect')
        self.state['smokeReplay'] = {'status': 'passed', 'recordId': record_id, 'events': sorted(expected_events)}
        self.save()
        return replayed

    def before_accept(self):
        scenario = self.scenario('before-accept')
        if scenario['phase'] == 'complete':
            return self.verify_effect(scenario)
        if 'eventId' not in scenario:
            self.service('stop', 'lightning')
            try:
                self.create(scenario)
                events = event_for_record(scenario['recordId'])
                require(len(events) == 1, 'Expected one retained failure event')
                scenario['eventId'] = events[0]
                scenario['phase'] = 'forwarding-failure'
                self.save()
                observed = self.poll(lambda: delivery(scenario['eventId']), lambda value: value['state'] == 'dead_lettered', 'BREG dead letter')
                require(observed['payloadAvailable'] and observed['attempt'] == 5, 'Expected exhausted retained BREG delivery')
                scenario['deadLetterGeneration'] = observed['generation']
                self.save()
            finally:
                self.service('start', 'lightning')
                self.ready()
        observed = delivery(scenario['eventId'])
        require('deadLetterGeneration' in scenario, 'Interrupted failure injection did not prove a dead letter; retained identity was preserved')
        if observed['state'] == 'dead_lettered':
            require(observed['payloadAvailable'], 'Dead letter payload expired before replay')
            require(observed['deliveryId'] == 'events.farm.farm-created-v1.webhook', 'Unexpected compiled recovery delivery')
            captured(COMPOSE + ['run', '--rm', '--no-deps', 'tools', 'bregctl', '--format', 'json', 'webhook', 'replay',
                '--runtime-config', '/config/breg/runtime.json', '--event-id', scenario['eventId'],
                '--delivery-id', observed['deliveryId'], '--expected-generation', str(observed['generation'])], 'Explicit BREG dead-letter replay')
        self.accepted(scenario)
        require(delivery(scenario['eventId'])['generation'] > scenario.get('deadLetterGeneration', 0), 'Replay did not advance generation')
        self.verify_effect(scenario)
        scenario['phase'] = 'complete'
        self.save()

    def after_accept(self):
        scenario = self.scenario('after-accept')
        if scenario['phase'] == 'complete':
            return self.verify_effect(scenario)
        if scenario['phase'] == 'prepared':
            self.service('stop', 'destination')
            try:
                self.create(scenario)
                self.accepted(scenario)
                orders = self.poll(lambda: self.orders(scenario['recordId']),
                    lambda items: bool(items) and all(order['state'] in FAILURES for order in items), 'Post-acceptance workflow failure')
                require(all(any(step['job'] == 'record-update' and step['exitReason'] != 'success'
                    for step in order['runs'][-1]['steps']) for order in orders), 'Failure did not occur at the synthetic destination')
                scenario['phase'] = 'worker-failed'
                self.save()
            finally:
                self.service('start', 'destination')
                self.destination_ready()
        if len(self.effects(scenario['recordId'])['effects']) == 1:
            self.verify_effect(scenario)
            scenario['phase'] = 'complete'
            self.save()
            return
        require(len(self.effects(scenario['recordId'])['effects']) == 0, 'Destination changed during the forced failure')
        retried = self.retry_failed(scenario['recordId'])
        require(all(item['retriedJob'] == 'record-update' for item in retried), 'Retry unexpectedly reran evidence acquisition')
        self.verify_effect(scenario)
        scenario['phase'] = 'complete'
        self.save()

    def pending_restart(self):
        scenario = self.scenario('pending-restart')
        if scenario['phase'] == 'complete':
            return self.verify_effect(scenario)
        if scenario.get('restartCompleted') and len(self.effects(scenario['recordId'])['effects']) == 1:
            self.verify_effect(scenario)
            scenario['phase'] = 'complete'
            self.save()
            return
        self.service('stop', 'worker')
        try:
            self.create(scenario)
            orders = self.accepted(scenario)
            require(all(order['state'] not in SUCCESS | FAILURES for order in orders), 'Pending test had already executed')
            require(len(self.effects(scenario['recordId'])['effects']) == 0, 'Pending work unexpectedly changed destination')
            scenario['phase'] = 'accepted-pending'
            self.save()
            self.service('restart', 'lightning', 'bridge', 'breg', 'destination')
            self.ready()
            self.destination_ready()
            self.registry_ready()
            require(len(self.effects(scenario['recordId'])['effects']) == 0, 'Restart executed work without the worker')
            scenario['restartCompleted'] = True
            self.save()
        finally:
            self.service('start', 'worker')
        self.verify_effect(scenario)
        scenario['phase'] = 'complete'
        self.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--retry-smoke', action='store_true')
    actions.add_argument('--inspect-smoke', action='store_true')
    actions.add_argument('--replay-smoke', action='store_true')
    actions.add_argument('--scenario', choices=['before-accept', 'after-accept', 'pending-restart', 'all'])
    parser.add_argument('--timeout', type=int, default=180)
    arguments = parser.parse_args()
    require(10 <= arguments.timeout <= 600, 'Timeout must be between 10 and 600 seconds')
    os.umask(0o077)
    recovery = Recovery(arguments.timeout)
    if arguments.inspect_smoke:
        orders = recovery.orders(recovery.pilot.state['recordId'])
        print(json.dumps({'status': 'inspected', 'workOrders': len(orders), 'states': [order['state'] for order in orders],
            'runs': sum(len(order['runs']) for order in orders),
            'latestRunStates': [order['runs'][-1]['state'] for order in orders if order['runs']],
            'latestQueues': [order['runs'][-1]['queue'] for order in orders if order['runs']]}))
    elif arguments.retry_smoke:
        results = recovery.retry_failed(recovery.pilot.state['recordId'])
        print(json.dumps({'status': 'passed', 'retriedRuns': len(results)}))
    elif arguments.replay_smoke:
        print(json.dumps({'status': 'passed', 'replayedEvents': recovery.replay_smoke(), 'additionalDestinationEffects': 0}))
    else:
        scenarios = ['before-accept', 'after-accept', 'pending-restart'] if arguments.scenario == 'all' else [arguments.scenario]
        for scenario in scenarios:
            getattr(recovery, scenario.replace('-', '_'))()
        print(json.dumps({'status': 'passed', 'checks': scenarios}))


if __name__ == '__main__':
    try:
        main()
    except SmokeFailure as error:
        print('Pilot recovery failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('Pilot recovery failed: unexpected response or configuration; details withheld', file=sys.stderr)
        sys.exit(1)
