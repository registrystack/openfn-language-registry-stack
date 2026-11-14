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
        self.review_result = None

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
        return {'data': {'proposalId': REQUEST}}

    def farm(self):
        return {'data': {'recordIdentifier': RECORD, 'domainData': {'name': self.current_name}}}

    def current_request(self):
        return {'id': REQUEST, 'actionId': 'correct-farm-name', 'state': self.request_state,
            'submissionVersion': 1, 'effectDigest': 'sha256:' + 'a' * 64,
            'decision': None if self.review_result is None else {'status': self.review_result},
            'input': {'record': RECORD, 'name': self.state['correctedName'],
                'reason': self.state['reason'], 'supportingReference': self.state['supportingReference']}}

    def review(self, action):
        self.calls.append(('review', action))
        if action == 'approve':
            assert self.calls[-2] == ('review', 'inspect')
            assert self.current_name == self.state['registration']['name']
            assert self.events == 1
            self.review_result = 'approved'
        if action == 'apply':
            assert self.calls[-2] == ('review', 'inspect')
            assert self.request_state == 'submitted'
            assert self.review_result == 'approved'
            assert self.events == 1
            self.request_state = 'applied'
            self.current_name = self.state['correctedName']
            self.events += 1

    def destination_rows(self):
        return {'records': [{'registered': 1, 'record_id': RECORD, 'revision': 2}],
            'effects': [{'event_id': 'event1', 'outcome': 'applied'}, {'event_id': 'event2', 'outcome': 'applied'}][:self.events]}


class SmokeTests(unittest.TestCase):
    def test_lookup_selection_uses_current_record_type_metadata(self):
        lookup = {'id': 'records.farm.lookup', 'operation': 'lookup',
            'sourceRecordType': 'farm', 'accessProfile': 'openfn-service',
            'path': '/v1/records/farms:lookup'}
        self.assertIs(smoke.Pilot.select(None, {'operations': [lookup]}, 'farm', 'lookup'), lookup)

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
            pilot.state.update(recordId=RECORD, proposalId=REQUEST, baseline={'acceptedEvents': 0}, phase='approved')
            pilot.current_name = 'Old Name'
            pilot.request_state = 'submitted'
            pilot.review_result = 'approved'
            pilot.events = 1
            pilot.run()
            self.assertEqual(pilot.events, 2)
            self.assertNotIn(('review', 'approve'), pilot.calls)
            self.assertIn(('review', 'apply'), pilot.calls)

    def test_rejected_or_changes_requested_correction_is_not_applied(self):
        for result in ['rejected', 'changes-requested']:
            with self.subTest(result=result), tempfile.TemporaryDirectory() as directory:
                pilot = FakePilot(Path(directory) / 'state.json')
                pilot.state.update(recordId=RECORD, proposalId=REQUEST, baseline={'acceptedEvents': 0})
                pilot.current_name = 'Old Name'
                pilot.request_state = 'rejected' if result == 'rejected' else 'submitted'
                pilot.review_result = result
                pilot.events = 1
                with self.assertRaisesRegex(smoke.SmokeFailure, result):
                    pilot.run()
                self.assertNotIn(('review', 'apply'), pilot.calls)
                self.assertEqual(pilot.events, 1)

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
                self.assertEqual(command.call_args.args[0][-7:], ['restart', 'breg', 'casework', 'worker', 'bridge', 'destination', 'lightning'])
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

    def test_proposal_id_recovery_accepts_sync_output_without_replaying(self):
        with tempfile.TemporaryDirectory() as directory:
            pilot = FakePilot(Path(directory) / 'state.json')
            for output in [{'data': {'proposalId': REQUEST}}, {'data': {'data': {'proposalId': REQUEST}}}]:
                with patch.object(pilot, 'metadata', side_effect=AssertionError('Unexpected replay')):
                    self.assertEqual(pilot.recover_proposal_id(output), REQUEST)

    def test_changed_current_request_refuses_review(self):
        with tempfile.TemporaryDirectory() as directory:
            pilot = FakePilot(Path(directory) / 'state.json')
            pilot.state['recordId'] = RECORD
            pilot.state['proposalId'] = REQUEST
            current = pilot.current_request()
            current['input']['supportingReference'] = 'other-submission'
            with self.assertRaises(smoke.SmokeFailure):
                pilot.inspect_content(current)


if __name__ == '__main__':
    unittest.main()
