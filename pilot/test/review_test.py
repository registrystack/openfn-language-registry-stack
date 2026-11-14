"""Focused proofs for the native Casework-to-BReg reviewer authority boundary."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('review', Path(__file__).resolve().parents[1] / 'agriculture/review.py')
review = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review)
PROPOSAL = '00000000-0000-4000-8000-000000000001'
REVIEW = '00000000-0000-4000-8000-000000000002'
TASK = '00000000-0000-4000-8000-000000000003'
DIGEST = 'sha256:' + 'a' * 64
POLICY = {'id': 'name-correction', 'version': '2', 'digest': 'sha256:' + 'b' * 64}
CONTRACT = {
    'id': 'urn:registry:breg:review-context:agricultural-holdings:correct-farm-name:farm-name-context',
    'revision': 'sha256:54ec76f0558c42b3e698f3209fb1b8f53d0c9cc4e343edf7d98bbf757c0f2d2b',
    'schemaDigest': 'sha256:0bcdce5b1d3ae5d51328c3fb79d0c86f20b384bfc3cfa5b834bc681a11e7f4f0'}


def snapshot():
    proposal = {'id': PROPOSAL, 'actionId': 'correct-farm-name', 'state': 'submitted',
        'submissionVersion': 1, 'revision': 2, 'effectDigest': DIGEST, 'turn': 'official',
        'input': {'record': '00000000-0000-4000-8000-000000000004', 'name': 'Corrected'}, 'links': {}}
    subject = {'source': 'agricultural-holdings', 'type': 'proposal', 'id': PROPOSAL,
        'version': '1', 'digest': DIGEST}
    return {'breg': proposal,
        'casework': {'task': {'taskId': TASK, 'requestId': REVIEW, 'subject': subject,
            'revision': 1, 'state': 'open'},
            'context': {'taskId': TASK, 'requestId': REVIEW, 'subject': subject,
                'policy': POLICY, 'policyClosure': {'identity': POLICY, 'context': {
                    'mode': 'current-source', 'provider': 'agricultural-holdings', 'contract': CONTRACT}},
                'context': {
                    'reference': 'breg:agricultural-holdings:correct-farm-name:proposal:1',
                    'bindingStatus': 'current', 'projection': {'binding': subject,
                        'display': {'name': 'Corrected'}}}}}}


class ReviewTests(unittest.TestCase):
    def test_approval_claims_exact_task_revision_then_decides_without_registry_mutation(self):
        value = snapshot()
        claimed = {**value['casework']['task'], 'revision': 2,
            'state': {'held': {'holder': {'issuer': 'local', 'subject': 'reviewer'}}}}
        with tempfile.TemporaryDirectory() as directory, patch.object(review, 'ROOT', Path(directory)), \
                patch.object(review, 'proposal', return_value=value['breg']), \
                patch.object(review, 'casework', side_effect=[value['casework']['context'], claimed, None]) as casework, \
                patch.object(review, 'request') as registry_mutation:
            review.decide(PROPOSAL, value, 'synthetic-token', 'approve')
            calls = casework.call_args_list
            self.assertEqual(calls[1].args[:3], (f'/v1/review-tasks/{TASK}/claim', 'synthetic-token', 'POST'))
            self.assertEqual(calls[1].kwargs['headers']['If-Match'], '"1"')
            self.assertEqual(calls[2].args[3], {'decision': {'type': 'approve', 'outcome': 'approved'}})
            self.assertEqual(calls[2].args[4]['If-Match'], '"2"')
            self.assertEqual((Path(directory) / 'review' / f'{PROPOSAL}.json').stat().st_mode & 0o777, 0o600)
            registry_mutation.assert_not_called()

    def test_rejection_and_changes_requested_use_declared_outcomes_and_required_reasons(self):
        for decision, outcome in [('reject', 'rejected'), ('changes-requested', 'changes-requested')]:
            value = snapshot()
            value['casework']['task']['state'] = {'held': {'holder': {'issuer': 'local', 'subject': 'reviewer'}}}
            with patch.object(review, 'proposal', return_value=value['breg']), \
                    patch.object(review, 'casework', side_effect=[value['casework']['context'], None]) as casework:
                review.decide(PROPOSAL, value, 'synthetic-token', decision, 'Public synthetic reason')
                self.assertEqual(casework.call_args_list[-1].args[3], {'decision': {
                    'type': decision, 'outcome': outcome, 'reason': 'Public synthetic reason',
                    'publicReason': 'Public synthetic reason'}})
        with self.assertRaises(RuntimeError):
            review.decision_body('reject')
        with self.assertRaises(RuntimeError):
            review.decision_body('changes-requested', '   ')

    def test_changed_source_policy_or_context_binding_cannot_be_decided(self):
        for field in ['subject', 'policy', 'context', 'projection']:
            value = snapshot()
            changed = copy.deepcopy(value['casework']['context'])
            if field == 'context':
                changed[field]['bindingStatus'] = 'binding-changed'
            elif field == 'projection':
                changed['context']['projection']['binding']['digest'] = 'sha256:' + 'd' * 64
            elif field == 'subject':
                changed[field]['digest'] = 'sha256:' + 'd' * 64
            else:
                changed[field]['id'] = 'other-policy'
            with patch.object(review, 'proposal', return_value=value['breg']), \
                    patch.object(review, 'casework', return_value=changed) as casework:
                with self.assertRaises(RuntimeError):
                    review.decide(PROPOSAL, value, 'synthetic-token', 'approve')
                self.assertEqual(len(casework.call_args_list), 1)

    def test_policy_closure_must_match_authored_provider_and_contract_pins(self):
        mutations = [
            ('identity', 'id', 'other-policy'),
            ('context', 'mode', 'submitted'),
            ('context', 'provider', 'other-provider'),
            ('contract', 'id', 'urn:registry:breg:review-context:other'),
            ('contract', 'revision', 'sha256:' + 'd' * 64),
            ('contract', 'schemaDigest', 'sha256:' + 'e' * 64),
        ]
        for section, field, replacement in mutations:
            with self.subTest(section=section, field=field):
                value = snapshot()
                changed = copy.deepcopy(value['casework']['context'])
                closure = changed['policyClosure']
                target = closure['context']['contract'] if section == 'contract' else closure[section]
                target[field] = replacement
                with patch.object(review, 'proposal', return_value=value['breg']), \
                        patch.object(review, 'casework', return_value=changed):
                    with self.assertRaises(RuntimeError):
                        review.decide(PROPOSAL, value, 'synthetic-token', 'approve')

    def test_changed_proposal_refuses_before_casework_authority_exchange(self):
        value = snapshot()
        changed = copy.deepcopy(value['breg'])
        changed['submissionVersion'] = 2
        with patch.object(review, 'proposal', return_value=changed), patch.object(review, 'casework') as casework:
            with self.assertRaises(RuntimeError):
                review.decide(PROPOSAL, value, 'synthetic-token', 'approve')
            casework.assert_not_called()

    def test_application_requires_reconciled_approval_and_exact_applier_link(self):
        value = snapshot()
        with patch.object(review, 'proposal', return_value=value['breg']), patch.object(review, 'request') as mutation:
            with self.assertRaises(RuntimeError):
                review.apply(PROPOSAL, value, 'synthetic-token')
            mutation.assert_not_called()
        current = copy.deepcopy(value['breg'])
        current['decision'] = {'status': 'approved', 'decidedAt': '2026-11-14T00:00:00Z'}
        current['links'] = {'apply': {'operation': 'apply', 'method': 'POST',
            'path': f'/v1/proposals/{PROPOSAL}/apply', 'accessProfile': 'correction-applier',
            'ifMatch': '"synthetic-lifecycle-etag"',
            'availability': {'available': True, 'observedRevision': 3}}}
        with patch.object(review, 'proposal', return_value=current) as proposal, patch.object(review, 'request') as mutation:
            review.apply(PROPOSAL, value, 'synthetic-token')
            proposal.assert_called_once_with(PROPOSAL, 'synthetic-token', 'correction-applier')
            self.assertEqual(mutation.call_args.args[1], f'/v1/proposals/{PROPOSAL}/apply?accessProfile=correction-applier')
            self.assertEqual(mutation.call_args.args[4], {'submissionVersion': 1, 'effectDigest': DIGEST})
            self.assertEqual(mutation.call_args.args[5]['If-Match'], '"synthetic-lifecycle-etag"')
        for profile in ['reviewer', 'openfn-service']:
            current['links']['apply']['accessProfile'] = profile
            with patch.object(review, 'proposal', return_value=current), patch.object(review, 'request') as mutation:
                with self.assertRaises(RuntimeError):
                    review.apply(PROPOSAL, value, 'synthetic-token')
                mutation.assert_not_called()

    def test_applied_replay_refuses_a_changed_proposal_snapshot(self):
        inspected = snapshot()
        current = copy.deepcopy(inspected['breg'])
        current['state'] = 'applied'
        current['submissionVersion'] = 2
        with patch.object(review, 'proposal', return_value=current), patch.object(review, 'request') as mutation:
            with self.assertRaisesRegex(RuntimeError, 'changed after inspection'):
                review.apply(PROPOSAL, inspected, 'synthetic-token')
            mutation.assert_not_called()

    def test_rejected_or_changes_requested_proposal_cannot_be_applied(self):
        for status in ['rejected', 'changes-requested']:
            value = snapshot()
            current = copy.deepcopy(value['breg'])
            current['state'] = 'rejected' if status == 'rejected' else 'submitted'
            current['decision'] = {'status': status, 'decidedAt': '2026-11-14T00:00:00Z'}
            with patch.object(review, 'proposal', return_value=current), patch.object(review, 'request') as mutation:
                with self.assertRaisesRegex(RuntimeError, status):
                    review.apply(PROPOSAL, value, 'synthetic-token')
                mutation.assert_not_called()

    def test_inspection_uses_exact_current_proposal_subject(self):
        value = snapshot()
        with patch.object(review, 'proposal', return_value=value['breg']), \
                patch.object(review, 'casework', side_effect=[{'items': [value['casework']['task']]}, value['casework']['context']]):
            self.assertEqual(review.inspect(PROPOSAL, 'synthetic-token'), value)

    def test_inspection_reports_a_casework_handoff_refusal_without_waiting(self):
        value = snapshot()['breg']
        value['handoffRefusal'] = {'code': 'review.initiator-required'}
        with patch.object(review, 'proposal', return_value=value), patch.object(review, 'task_for') as tasks:
            with self.assertRaisesRegex(RuntimeError, 'requires a verified human initiator'):
                review.inspect(PROPOSAL, 'synthetic-token')
            tasks.assert_not_called()

    def test_inspection_waits_for_breg_reconciliation_after_casework_decision(self):
        value = snapshot()
        reconciled = copy.deepcopy(value['breg'])
        reconciled['decision'] = {'status': 'approved', 'decidedAt': '2026-11-14T00:00:00Z'}
        decided = {**value['casework']['task'], 'state': 'decided'}
        with patch.object(review, 'proposal', side_effect=[value['breg'], reconciled]), \
                patch.object(review, 'casework', return_value={'items': [decided]}) as casework, \
                patch.object(review.time, 'sleep'):
            self.assertEqual(review.inspect(PROPOSAL, 'synthetic-token'), {'breg': reconciled})
            self.assertEqual(len(casework.call_args_list), 1)


if __name__ == '__main__':
    unittest.main()
