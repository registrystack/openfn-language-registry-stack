"""Offline proofs for smoke-driver recovery, review ordering, and safe diagnostics."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('smoke', Path(__file__).resolve().parents[1] / 'smoke.py')
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)
RECORD = '00000000-0000-4000-8000-000000000001'
REQUEST = '00000000-0000-4000-8000-000000000002'


class FakePilot(smoke.Pilot):
    def __init__(self, path):
        self.state_path = path
        self.timeout = 10
        self.state = {'schema': 'registry-openfn-smoke/v1', 'runId': 'synthetic-test',
            'registration': {'submissionId': 'registration-test', 'localIdentifier': 'TEST', 'name': 'Old Name'},
            'correctedName': 'Correct Name', 'supportingReference': 'SYNTHETIC-TEST', 'reason': 'Correction', 'phase': 'prepared'}
        self.events = 0
        self.calls = []
        self.current_name = None
        self.request_state = None

    def destination(self):
        return {'acceptedEvents': self.events + 100, 'appliedEffects': self.events + 100, 'records': int(self.events > 0) + 25}

    def webhook(self, name, data, expect_success=True):
        self.calls.append(('webhook', name, expect_success))
        if name == 'registration':
            if not expect_success:
                assert self.current_name is not None
                return None
            if self.current_name is None:
                self.current_name = data['name']
                self.events += 1
            return {'data': {'recordId': RECORD}}
        if self.request_state is None:
            self.request_state = 'submitted'
        return {'data': {'requestId': REQUEST}}

    def farm(self):
        return {'data': {'recordIdentifier': RECORD, 'domainData': {'name': self.current_name}}}

    def current_request(self):
        return {'data': {'recordIdentifier': REQUEST, 'request': {'bregState': self.request_state},
            'domainData': {'record': RECORD, 'name': self.state['correctedName'], 'reason': self.state['reason'], 'supportingReference': self.state['supportingReference']}}}

    def review(self, action):
        self.calls.append(('review', action))
        if action == 'approve':
            assert self.calls[-2] == ('review', 'inspect')
            assert self.current_name == self.state['registration']['name']
            self.request_state = 'approved'
        if action == 'apply':
            assert self.calls[-2] == ('review', 'inspect')
            assert self.request_state == 'approved'
            self.request_state = 'applied'
            self.current_name = self.state['correctedName']
            self.events += 1

    def destination_rows(self):
        return {'records': [{'registered': 1, 'record_id': RECORD, 'revision': 2}],
            'effects': [{'event_id': 'event1', 'outcome': 'applied'}, {'event_id': 'event2', 'outcome': 'applied'}][:self.events]}


class SmokeTests(unittest.TestCase):
    def test_main_and_retained_replay_keep_review_order_and_event_count(self):
        with tempfile.TemporaryDirectory() as directory:
            pilot = FakePilot(Path(directory) / 'state.json')
            pilot.run()
            self.assertEqual(pilot.state['phase'], 'complete')
            self.assertEqual(pilot.events, 2)
            self.assertEqual([call for call in pilot.calls if call[0] == 'review'],
                [('review', 'inspect'), ('review', 'approve'), ('review', 'inspect'), ('review', 'apply')])
            pilot.run()
            self.assertEqual(pilot.events, 2)
            self.assertEqual(len([call for call in pilot.calls if call == ('review', 'apply')]), 1)
            self.assertEqual(pilot.state_path.stat().st_mode & 0o777, 0o600)

    def test_partial_approval_recovers_without_approving_again(self):
        with tempfile.TemporaryDirectory() as directory:
            pilot = FakePilot(Path(directory) / 'state.json')
            pilot.state.update(recordId=RECORD, requestId=REQUEST, baseline={'acceptedEvents': 0}, phase='approved')
            pilot.current_name = 'Old Name'
            pilot.request_state = 'approved'
            pilot.events = 1
            pilot.run()
            self.assertEqual(pilot.events, 2)
            self.assertNotIn(('review', 'approve'), pilot.calls)
            self.assertIn(('review', 'apply'), pilot.calls)

    def test_restart_requires_completed_main_and_only_restarts_retained_services(self):
        with tempfile.TemporaryDirectory() as directory:
            pilot = FakePilot(Path(directory) / 'state.json')
            with patch.object(smoke, 'captured') as command:
                with self.assertRaises(smoke.SmokeFailure):
                    pilot.restart_recovery()
                command.assert_not_called()
            pilot.run()
            with patch.object(smoke, 'captured', return_value='') as command, patch.object(smoke, 'http_json', return_value=(200, None)):
                pilot.restart_recovery()
                self.assertEqual(command.call_args.args[0][-6:], ['restart', 'breg', 'worker', 'bridge', 'destination', 'lightning'])
                self.assertEqual(pilot.state['restartRecovery'], 'passed')
                self.assertEqual(pilot.events, 2)

    def test_subprocess_failures_withhold_secret_outputs(self):
        result = subprocess.CompletedProcess(['synthetic'], 1, stdout='secret-token-canary', stderr='secret-record-canary')
        with patch.object(smoke.subprocess, 'run', return_value=result):
            with self.assertRaises(smoke.SmokeFailure) as refusal:
                smoke.captured(['synthetic'], 'Synthetic command')
            self.assertNotIn('canary', str(refusal.exception))

    def test_metadata_path_rejects_foreign_or_unsubstituted_routes(self):
        self.assertEqual(smoke.operation_path({'path': '/v1/records/farms/{record_id}'}, RECORD), '/v1/records/farms/' + RECORD)
        for path in ['https://attacker.invalid/write', '/v1/../secret', '/v1/records/{other}', '/v1/records?token=secret']:
            with self.assertRaises(smoke.SmokeFailure):
                smoke.operation_path({'path': path})

    def test_request_id_recovery_accepts_sync_output_without_replaying(self):
        with tempfile.TemporaryDirectory() as directory:
            pilot = FakePilot(Path(directory) / 'state.json')
            for output in [{'data': {'requestId': REQUEST}}, {'data': {'data': {'requestId': REQUEST}}}]:
                with patch.object(pilot, 'metadata', side_effect=AssertionError('Unexpected replay')):
                    self.assertEqual(pilot.recover_request_id(output), REQUEST)

    def test_changed_current_request_refuses_review(self):
        with tempfile.TemporaryDirectory() as directory:
            pilot = FakePilot(Path(directory) / 'state.json')
            pilot.state['recordId'] = RECORD
            current = pilot.current_request()
            current['data']['domainData']['supportingReference'] = 'other-submission'
            with self.assertRaises(smoke.SmokeFailure):
                pilot.inspect_content(current)


if __name__ == '__main__':
    unittest.main()
