"""Offline guard and recovery checks for the live fault-injection driver."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PILOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PILOT))
SPEC = importlib.util.spec_from_file_location('recovery', PILOT / 'recovery.py')
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)
RECORD = '11111111-1111-4111-8111-111111111111'
EVENT = '22222222-2222-4222-8222-222222222222'


class RecoveryTests(unittest.TestCase):
    def test_rpc_scope_and_sanitized_report(self):
        report = {'workOrders': []}
        with patch.object(recovery, 'captured', return_value='Unrelated console output\nPILOT_RECOVERY_JSON:' + json.dumps(report) + '\n:ok') as command:
            self.assertEqual(recovery.rpc(RECORD), report)
            self.assertIn('pilot_recovery_request: Base.url_decode64!', command.call_args.args[0][-1])
            self.assertNotIn('-e', command.call_args.args[0])
        with patch.object(recovery, 'captured') as command:
            with self.assertRaises(recovery.SmokeFailure):
                recovery.rpc("bad' OR true")
            command.assert_not_called()

    def test_database_read_only_and_failure_output_withheld(self):
        result = subprocess.CompletedProcess([], 0, stdout='BEGIN\n[]\nROLLBACK\n', stderr='')
        with patch.object(recovery.subprocess, 'run', return_value=result) as command:
            self.assertEqual(recovery.event_for_record(RECORD), [])
            sql = command.call_args.kwargs['input']
            self.assertTrue(sql.startswith('BEGIN READ ONLY;'))
            self.assertTrue(sql.endswith('ROLLBACK;\n'))
            self.assertIn('-d agriculture', command.call_args.args[0][-1])
        result = subprocess.CompletedProcess([], 1, stdout='SYNTHETIC-SECRET-CANARY', stderr='SYNTHETIC-PAYLOAD-CANARY')
        with patch.object(recovery.subprocess, 'run', return_value=result):
            with self.assertRaises(recovery.SmokeFailure) as refusal:
                recovery.delivery(EVENT)
            self.assertNotIn('CANARY', str(refusal.exception))

    def test_service_scope_disallows_database_or_volume_operations(self):
        driver = recovery.Recovery.__new__(recovery.Recovery)
        with patch.object(recovery, 'captured') as command:
            for operation, services in [('down', ['worker']), ('stop', ['breg-db']), ('restart', ['mint'])]:
                with self.assertRaises(recovery.SmokeFailure):
                    driver.service(operation, *services)
            command.assert_not_called()

    def test_forwarding_failure_restores_lightning_even_if_create_fails(self):
        driver = recovery.Recovery.__new__(recovery.Recovery)
        scenario = {'phase': 'prepared'}
        with patch.object(driver, 'scenario', return_value=scenario), patch.object(driver, 'service') as service, \
            patch.object(driver, 'ready') as ready, patch.object(driver, 'create', side_effect=recovery.SmokeFailure('injected')):
            with self.assertRaises(recovery.SmokeFailure):
                driver.before_accept()
            self.assertEqual([call.args for call in service.call_args_list], [('stop', 'lightning'), ('start', 'lightning')])
            ready.assert_called_once()

    def test_downstream_failure_restores_destination_even_if_create_fails(self):
        driver = recovery.Recovery.__new__(recovery.Recovery)
        with patch.object(driver, 'scenario', return_value={'phase': 'prepared'}), patch.object(driver, 'service') as service, \
            patch.object(driver, 'destination_ready') as ready, patch.object(driver, 'create', side_effect=recovery.SmokeFailure('injected')):
            with self.assertRaises(recovery.SmokeFailure):
                driver.after_accept()
            self.assertEqual([call.args for call in service.call_args_list], [('stop', 'destination'), ('start', 'destination')])
            ready.assert_called_once()

    def test_pending_failure_restores_worker(self):
        driver = recovery.Recovery.__new__(recovery.Recovery)
        with patch.object(driver, 'scenario', return_value={'phase': 'prepared'}), patch.object(driver, 'service') as service, \
            patch.object(driver, 'create', side_effect=recovery.SmokeFailure('injected')):
            with self.assertRaises(recovery.SmokeFailure):
                driver.pending_restart()
            self.assertEqual([call.args for call in service.call_args_list], [('stop', 'worker'), ('start', 'worker')])

    def test_retry_uses_existing_order_and_latest_failed_run_only(self):
        driver = recovery.Recovery.__new__(recovery.Recovery)
        orders = [{'id': 'order-1', 'state': 'failed', 'runs': [{'id': 'run-1'}, {'id': 'run-2'}]},
                  {'id': 'order-2', 'state': 'success', 'runs': [{'id': 'run-3'}]}]
        with patch.object(driver, 'orders', return_value=orders), patch.object(driver, 'poll'), \
            patch.object(recovery, 'rpc', return_value={'runId': 'run-4'}) as rpc:
            self.assertEqual(driver.retry_failed(RECORD), [{'runId': 'run-4'}])
            rpc.assert_called_once_with(RECORD, 'retry', workOrderId='order-1', expectedRunId='run-2')

    def test_unproved_dead_letter_does_not_claim_complete(self):
        driver = recovery.Recovery.__new__(recovery.Recovery)
        scenario = {'phase': 'forwarding-failure', 'eventId': EVENT}
        with patch.object(driver, 'scenario', return_value=scenario), \
            patch.object(recovery, 'delivery', return_value={'state': 'delivered'}), patch.object(driver, 'accepted') as accepted:
            with self.assertRaises(recovery.SmokeFailure):
                driver.before_accept()
            accepted.assert_not_called()

    def test_smoke_replay_waits_for_success_and_preserves_existing_effect(self):
        driver = recovery.Recovery.__new__(recovery.Recovery)
        driver.pilot = SimpleNamespace(state={'recordId': RECORD})
        driver.state = {}
        orders = [{'eventId': EVENT, 'state': 'success'}]
        rows = {'effects': [{'event_id': EVENT}], 'records': [{'revision': 1}]}
        dead = {'state': 'dead_lettered', 'payloadAvailable': True, 'generation': 1,
            'deliveryId': 'events.farm.farm-created-v1.webhook'}
        settled = {'state': 'delivered', 'payloadAvailable': False, 'generation': 2}
        with patch.object(driver, 'orders', return_value=orders), patch.object(driver, 'effects', return_value=rows), \
            patch.object(recovery, 'delivery', return_value=dead), patch.object(driver, 'poll', side_effect=[settled, orders]), \
            patch.object(recovery, 'captured') as command, patch.object(driver, 'save'):
            self.assertEqual(driver.replay_smoke(), 1)
            args = command.call_args.args[0]
            self.assertIn(EVENT, args)
            self.assertEqual(args[-2:], ['--expected-generation', '1'])
        with patch.object(driver, 'orders', return_value=[{'state': 'pending'}]), patch.object(recovery, 'captured') as command:
            with self.assertRaises(recovery.SmokeFailure):
                driver.replay_smoke()
            command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
