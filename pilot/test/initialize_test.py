"""Exercise resumable package activation with released report shapes."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml


PILOT = Path(__file__).resolve().parents[1] / 'agriculture'
SPEC = importlib.util.spec_from_file_location('pilot_initialize', PILOT / 'initialize.py')
initialize = importlib.util.module_from_spec(SPEC)
with patch.object(sys, 'path', [str(PILOT), *sys.path]):
    SPEC.loader.exec_module(initialize)

DIGEST = 'sha256:' + 'a' * 64


class CaseworkActivationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.casework = self.root / 'casework'
        (self.casework / 'package').mkdir(parents=True)
        (self.casework / 'package-report.json').write_text(json.dumps({'packageDigest': DIGEST}))
        (self.casework / 'runtime-template.yaml').write_text(yaml.safe_dump({
            'package': {'root': '/config/casework/package', 'expectedDigest': 'pending'},
        }))

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def status():
        return json.dumps({'activation': {'active': {'packageDigest': DIGEST}}})

    def test_retained_apply_report_recovers_without_reapplying(self):
        (self.casework / 'apply-report.json').write_text(json.dumps({
            'activation': {'packageDigest': DIGEST},
        }))

        def run(binary, command, *args):
            if (binary, command) == ('caseworkctl', 'status'):
                return self.status()
            raise AssertionError(f'unexpected command: {binary} {command}')

        with patch.object(initialize, 'ROOT', self.root), patch.object(initialize, 'run', side_effect=run):
            initialize.initialize_casework()
        self.assertEqual(json.loads((self.casework / 'initialized.json').read_text()), {'packageDigest': DIGEST})

    def test_initial_apply_uses_nested_activation_digest(self):
        commands = []

        def run(binary, command, *args):
            commands.append(command)
            if command == 'plan':
                return '{}'
            if command == 'apply':
                return json.dumps({'activation': {'packageDigest': DIGEST}})
            if command == 'status':
                return self.status()
            raise AssertionError(f'unexpected command: {binary} {command}')

        with patch.object(initialize, 'ROOT', self.root), patch.object(initialize, 'run', side_effect=run):
            initialize.initialize_casework()
        self.assertEqual(commands, ['plan', 'apply', 'status'])
        self.assertEqual(json.loads((self.casework / 'initialized.json').read_text()), {'packageDigest': DIGEST})


class EvidenceActivationTests(unittest.TestCase):
    def test_matching_active_authority_allows_retained_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / 'evidence'
            evidence.mkdir()
            (evidence / 'initialized.json').write_text('{}')

            def run(binary, command, *args):
                if (binary, command) == ('evidencectl', 'doctor'):
                    return ''
                if (binary, command) == ('evidencectl', 'check'):
                    return json.dumps({'packageDigest': DIGEST, 'authority': {
                        'authorityRevision': 'sha256:' + 'b' * 64,
                        'digest': 'sha256:' + 'c' * 64,
                    }})
                if (binary, command) == ('evidence', 'authority'):
                    return f"1 {'sha256:' + 'b' * 64} {'sha256:' + 'c' * 64} {DIGEST}\n"
                raise AssertionError(f'unexpected command: {binary} {command}')

            with patch.object(initialize, 'ROOT', root), \
                    patch.object(initialize, 'run', side_effect=run), \
                    patch.object(initialize, 'prepare_evidence_client') as prepare:
                initialize.initialize_evidence()
                prepare.assert_called_once()

    def test_retained_restart_refuses_a_different_active_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / 'evidence'
            evidence.mkdir()
            (evidence / 'initialized.json').write_text('{}')

            def run(binary, command, *args):
                if (binary, command) == ('evidencectl', 'doctor'):
                    return ''
                if (binary, command) == ('evidencectl', 'check'):
                    return json.dumps({'packageDigest': DIGEST, 'authority': {
                        'authorityRevision': 'sha256:' + 'b' * 64,
                        'digest': 'sha256:' + 'c' * 64,
                    }})
                if (binary, command) == ('evidence', 'authority'):
                    return f"1 {'sha256:' + 'd' * 64} {'sha256:' + 'c' * 64} {DIGEST}\n"
                raise AssertionError(f'unexpected command: {binary} {command}')

            with patch.object(initialize, 'ROOT', root), \
                    patch.object(initialize, 'run', side_effect=run), \
                    patch.object(initialize, 'prepare_evidence_client') as prepare:
                with self.assertRaisesRegex(RuntimeError, 'active Evidence authority differs'):
                    initialize.initialize_evidence()
                prepare.assert_not_called()


if __name__ == '__main__':
    unittest.main()
