"""Prove that lifecycle commands select only the marked 0.45 pilot."""
import json
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml

REPO = Path(__file__).resolve().parents[2]
PREPARE_SPEC = importlib.util.spec_from_file_location('prepare', REPO / 'pilot/agriculture/prepare.py')
prepare = importlib.util.module_from_spec(PREPARE_SPEC)
with patch.object(sys, 'path', [str(REPO / 'pilot/agriculture'), *sys.path]):
    PREPARE_SPEC.loader.exec_module(prepare)
issuer = sys.modules['issuer']


class DeploymentIsolationTests(unittest.TestCase):
    def test_selected_subnet_is_bound_to_both_evidence_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory) / 'project'
            shutil.copytree(REPO / 'pilot/agriculture/evidence-starter', project)
            prepare.bind_evidence_subnet(project, '10.254.46.0/24')
            for relative in ('production-target.yaml', 'targets/production/settings.yaml'):
                target = yaml.safe_load((project / relative).read_text())
                self.assertEqual(target['connections']['registry']['allowedPrivateCidrs'], ['10.254.46.0/24'])
            with self.assertRaisesRegex(ValueError, 'inside 10.254.0.0/16'):
                prepare.validate_pilot_subnet('10.255.46.0/24')
            with self.assertRaisesRegex(ValueError, 'a /24'):
                prepare.validate_pilot_subnet('10.254.0.0/16')

    def test_pilot_tls_certificate_covers_private_service_and_loopback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            issuer._prepare_tls(root)
            result = subprocess.run([
                'openssl', 'x509', '-in', str(root / 'tls/server.crt'),
                '-noout', '-ext', 'subjectAltName',
            ], check=True, capture_output=True, text=True)
        self.assertIn('DNS:issuer', result.stdout)
        self.assertIn('IP Address:127.0.0.1', result.stdout)

    def test_automated_openfn_client_and_registry_profile_identify_a_service(self):
        with tempfile.TemporaryDirectory() as directory:
            clients = prepare.client_descriptors(Path(directory))
        openfn = next(client for client in clients if client['logicalId'] == 'openfn-service')
        self.assertEqual(openfn['claims']['registry_actor_kind'], 'service')
        self.assertNotIn('allowHumanFixture', openfn)
        project = yaml.safe_load((REPO / 'pilot/agriculture/registry/registry.yaml').read_text())
        profile = next(profile for profile in project['accessProfiles'] if profile['id'] == 'openfn-service')
        self.assertEqual(profile['actorKind'], 'service')

    def test_service_initiated_correction_requires_an_independent_staff_review(self):
        project = yaml.safe_load((REPO / 'pilot/agriculture/casework/casework.yaml').read_text())
        policy = project['reviewPolicies']['name-correction']
        stage = policy['stages'][0]
        self.assertEqual(project['project']['version'], '2')
        self.assertEqual(policy['version'], '2')
        self.assertFalse(stage['excludeInitiator'])
        self.assertEqual(stage['decidingProfiles'], ['reviewer'])
        self.assertEqual(stage['requiredApprovals'], 1)
        self.assertEqual(project['accessProfiles']['reviewer']['role'], 'staff')
        self.assertEqual(project['accessProfiles']['reviewer']['requiredScopes'], ['casework:staff'])
        self.assertNotIn('trustedInitiatorIssuer', project['trustedProducers']['registry-breg'])

    def test_compose_uses_separate_project_and_operator_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deployment = root / 'deployment'
            deployment.mkdir()
            shutil.copy2(REPO / 'deployment/compose.sh', deployment / 'compose.sh')
            legacy = deployment / '.env'
            legacy.write_text('legacy operator configuration\n')
            binary = root / 'bin'
            binary.mkdir()
            capture = root / 'docker-arguments'
            (binary / 'docker').write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$PILOT_TEST_CAPTURE"\n')
            (binary / 'docker').chmod(0o755)
            result = subprocess.run([str(deployment / 'compose.sh'), 'ps'], capture_output=True, text=True,
                env={**os.environ, 'PATH': str(binary) + os.pathsep + os.environ['PATH'],
                    'PILOT_TEST_CAPTURE': str(capture)})
            self.assertEqual(result.returncode, 0, result.stderr)
            arguments = capture.read_text().splitlines()
            self.assertEqual(arguments[:3], ['compose', '--project-name', 'registry-openfn-pilot-045'])
            self.assertEqual(arguments[arguments.index('--env-file') + 1], str(deployment / '.env-0.45'))
            self.assertEqual(legacy.read_text(), 'legacy operator configuration\n')
            self.assertEqual((deployment / '.env-0.45').stat().st_mode & 0o777, 0o600)

    def test_start_and_reset_refuse_legacy_marker_before_any_docker_action(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deployment = root / 'deployment'
            deployment.mkdir()
            shutil.copy2(REPO / 'deployment/pilot.sh', deployment / 'pilot.sh')
            capture = root / 'compose-was-invoked'
            (deployment / 'compose.sh').write_text('#!/bin/sh\ntouch "$PILOT_TEST_CAPTURE"\n')
            (deployment / 'compose.sh').chmod(0o755)
            runtime = root / 'pilot/agriculture/.runtime-0.45'
            runtime.mkdir(parents=True)
            marker = runtime / 'prepared.json'
            marker.write_text(json.dumps({'schema': 'synthetic-agriculture-pilot/v1', 'version': '0.38.0'}))
            legacy = root / 'pilot/agriculture/.runtime-0.38'
            legacy.mkdir()
            sentinel = legacy / 'retained-data'
            sentinel.write_text('keep')
            for arguments in [['start'], ['reset', '--confirm-delete-synthetic-data']]:
                result = subprocess.run([str(deployment / 'pilot.sh'), *arguments], capture_output=True, text=True,
                    env={**os.environ, 'PILOT_TEST_CAPTURE': str(capture)})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('not the isolated 0.45', result.stderr)
                self.assertFalse(capture.exists())
                self.assertTrue(marker.exists())
                self.assertEqual(sentinel.read_text(), 'keep')

    def test_start_refuses_subnet_changed_since_preparation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deployment = root / 'deployment'
            deployment.mkdir()
            shutil.copy2(REPO / 'deployment/pilot.sh', deployment / 'pilot.sh')
            capture = root / 'compose-was-invoked'
            (deployment / 'compose.sh').write_text('#!/bin/sh\ntouch "$PILOT_TEST_CAPTURE"\n')
            (deployment / 'compose.sh').chmod(0o755)
            runtime = root / 'pilot/agriculture/.runtime-0.45'
            runtime.mkdir(parents=True)
            (runtime / 'prepared.json').write_text(json.dumps({
                'schema': 'synthetic-agriculture-pilot/v1',
                'version': '0.45.0',
                'pilotSubnet': '10.254.45.0/24',
            }))
            result = subprocess.run([str(deployment / 'pilot.sh'), 'start'], capture_output=True, text=True,
                env={**os.environ, 'PILOT_SUBNET': '10.254.46.0/24',
                    'PILOT_TEST_CAPTURE': str(capture)})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('subnet differs', result.stderr)
            self.assertFalse(capture.exists())


if __name__ == '__main__':
    unittest.main()
