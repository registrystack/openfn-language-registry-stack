from __future__ import annotations

import importlib.util
import json
import ipaddress
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
from urllib.parse import urlparse

import yaml


MODULE_PATH = Path(__file__).parents[1] / "agriculture" / "evidence-client.py"


def load_module():
    spec = importlib.util.spec_from_file_location("pilot_evidence_client", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def write_yaml(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(value, sort_keys=False), encoding="utf-8")


class EvidenceClientPreparationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="evidence-client-test-")
        self.root = Path(self.temporary.name)
        self.module = load_module()
        self.package_digest = "sha256:" + "1" * 64
        self.configuration_revision = "sha256:" + "2" * 64
        self.public_jwk = {
            "kty": "EC",
            "crv": "P-256",
            "alg": "ES256",
            "kid": "evidence-key",
            "x": "synthetic-x",
            "y": "synthetic-y",
        }
        self._write_runtime()
        self._write_issuer()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_uses_v045_runtime_by_default(self) -> None:
        self.assertEqual(
            self.module.DEFAULT_ROOT,
            Path("/workspace/pilot/agriculture/.runtime-0.45"),
        )

    def test_production_package_root_is_outside_candidate_build(self) -> None:
        target = yaml.safe_load((MODULE_PATH.parent / 'evidence-starter' / 'production-target.yaml').read_text())
        package_root = Path(target['package']['root'])
        candidate = Path('/config/evidence/candidate')
        self.assertNotEqual(package_root, candidate)
        self.assertNotIn(candidate, package_root.parents)

    def test_production_source_uses_the_private_tls_service_address(self) -> None:
        target = yaml.safe_load((MODULE_PATH.parent / 'evidence-starter' / 'production-target.yaml').read_text())
        source = target['connections']['registry']
        endpoint = source['endpoints']['registry']
        self.assertEqual(urlparse(endpoint['origin']).hostname, 'issuer')
        self.assertEqual(urlparse(endpoint['authentication']['tokenEndpoint']).hostname, 'issuer')
        self.assertEqual(endpoint['authentication']['clientAssertionAudience'], 'https://127.0.0.1:8443')
        networks = [ipaddress.ip_network(value) for value in source['allowedPrivateCidrs']]
        self.assertEqual(networks, [ipaddress.ip_network('10.254.45.0/24')])
        self.assertFalse(any(ipaddress.ip_address('127.0.0.1') in network for network in networks))
        legacy = yaml.safe_load((MODULE_PATH.parent / 'evidence-starter' / 'targets' / 'production' / 'settings.yaml').read_text())
        self.assertEqual(legacy['connections']['registry'], source)
        self.assertEqual(legacy['package']['root'], target['package']['root'])

    def _write_runtime(self) -> None:
        bundle = {
            "apiVersion": "id.registrystack.org/formats/evidence/bundle/v1",
            "kind": "EvidenceBundle",
            "project": "agriculture-holding-evidence",
            "assuranceProfile": "production",
            "service": {
                "providerId": "https://127.0.0.1:8445",
                "publicOrigin": "https://127.0.0.1:8445",
            },
            "issuer": {"uri": "urn:example:issuer:agriculture-holding-evidence"},
            "selectorProfiles": {
                "breg-8-registry-4-farm-19-by-local-identifier": {
                    "fields": {
                        "local-identifier": {
                            "type": "string",
                            "minimumBytes": 1,
                            "maximumBytes": 640,
                        }
                    }
                }
            },
            "requirements": [{
                "handle": "holding-registered",
                "uri": "urn:example:requirement:holding-registered:v1",
                "evidenceType": "urn:example:evidence:holding-registered",
                "purposes": ["holding-verification"],
                "subjectBinding": "audience-scoped",
                "subjectRoles": [{
                    "role": "subject",
                    "cardinality": "one",
                    "selectorProfiles": [
                        "breg-8-registry-4-farm-19-by-local-identifier"
                    ],
                }],
                "concepts": [{
                    "handle": "registered",
                    "uri": "urn:example:concept:holding-registered:registered",
                    "type": "boolean",
                    "required": True,
                    "constraints": {},
                }],
                "validitySeconds": 300,
            }],
            "signing": {
                "algorithm": "ES256",
                "format": "flattened-jws-json",
                "activePublicJwkFile": "public-keys/evidence-key.jwk.json",
                "revokedKeyIds": [],
                "maximumAssertionValiditySeconds": 300,
                "verifierClockSkewSeconds": 30,
            },
        }
        candidate = self.root / "evidence" / "candidate"
        write_yaml(candidate / "bundle" / "evidence.yaml", bundle)
        write_json(candidate / "bundle" / "public-keys" / "evidence-key.jwk.json", self.public_jwk)
        write_yaml(candidate / "runtime.yaml", {
            "apiVersion": "id.registrystack.org/formats/evidence/runtime/v1alpha1",
            "kind": "EvidenceRuntimeConfig",
            "package": {"root": str(candidate / "bundle")},
        })
        write_yaml(candidate / "compiled-authority.yaml", {
            "apiVersion": "id.registrystack.org/formats/evidence/compiled-target-authority/v1alpha1",
            "kind": "EvidenceCompiledTargetAuthority",
            "project": "agriculture-holding-evidence",
            "target": "production",
            "accessProfiles": {
                "holding-verifier": {
                    "kind": "organizational",
                    "actorKind": "service",
                    "requesterTags": ["holding-verifier"],
                    "grants": [{
                        "requirement": "urn:example:requirement:holding-registered:v1",
                        "purpose": "holding-verification",
                        "audienceFrom": "authenticated-requester",
                        "responseFormats": ["signed-jws"],
                        "subjectBindingModes": ["audience-scoped"],
                        "subjects": [{
                            "role": "subject",
                            "selectorProfile": "breg-8-registry-4-farm-19-by-local-identifier",
                            "valueOrigin": "request",
                        }],
                    }],
                }
            },
        })
        write_json(self.root / "evidence" / "package-report.json", {
            "packageDigest": self.package_digest,
            "revision": None,
        })
        write_json(
            self.root / "evidence" / "transit-public" / "evidence-signing.jwk.json",
            self.public_jwk,
        )
        (self.root / "evidence" / "project").mkdir(parents=True)
        (self.root / "evidence" / "target").mkdir(parents=True)

    def _write_issuer(self) -> None:
        private_jwk = {**self.public_jwk, "d": "synthetic-private"}
        private_path = self.root / "issuer" / "keys" / "evidence-client.jwk"
        write_json(private_path, private_jwk)
        private_path.chmod(0o600)
        ca = "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n"
        (self.root / "tls").mkdir(parents=True)
        (self.root / "tls" / "ca.pem").write_text(ca, encoding="utf-8")
        write_json(self.root / "issuer" / "clients.json", {
            "schema": "synthetic-agriculture-thunderid/v1",
            "caBundle": "tls/ca.pem",
            "tokenEndpoint": "https://127.0.0.1:8443/oauth2/token",
            "clientAssertionAudience": "https://127.0.0.1:8443",
            "resource": "urn:example:audience:agriculture-pilot",
            "clients": {
                "openfn-evidence": {
                    "clientId": "openfn-evidence",
                    "privateJwk": "issuer/keys/evidence-client.jwk",
                    "resource": "urn:example:audience:agriculture-pilot",
                    "scopes": ["evidence:request"],
                    "claims": {
                        "evidence_audience": "urn:example:audience:agriculture-pilot"
                    },
                }
            },
        })

    def _completed(self, command: list[str]) -> subprocess.CompletedProcess[str]:
        if command[:2] == ["evidence", "check"]:
            report = {"ok": True, "packageDigest": self.package_digest, "requirements": 1}
        elif command[:2] == ["evidencectl", "check"]:
            report = {
                "ok": True,
                "packageDigest": self.package_digest,
                "definitionRevisions": [{
                    "requirement": "urn:example:requirement:holding-registered:v1",
                    "configurationRevision": self.configuration_revision,
                }],
            }
        else:
            raise AssertionError(f"unexpected command: {command}")
        return subprocess.CompletedProcess(command, 0, json.dumps(report), "")

    def test_prepares_v045_bundle_and_revision_checked_request(self) -> None:
        with mock.patch.object(self.module.subprocess, "run", side_effect=lambda command, **_: self._completed(command)):
            generated = self.module.prepare_client(self.root)

        request = generated["evidence"]["request"]
        self.assertEqual(generated["packageDigest"], self.package_digest)
        self.assertEqual(request["configurationRevision"], self.configuration_revision)
        self.assertEqual(request["expectedAssuranceProfile"], "production")
        self.assertEqual(request["expectedOutputs"], [{
            "handle": "registered",
            "concept": "urn:example:concept:holding-registered:registered",
            "required": True,
            "form": {"type": "boolean"},
        }])
        self.assertEqual(request["maximumAssertionLifetimeSeconds"], 300)
        self.assertEqual(request["subjectExpectations"], "acceptFirstUse")
        self.assertEqual(
            request["subjects"][0]["selectorValues"],
            {"local-identifier": {"valueFrom": "data.values.local-identifier"}},
        )
        self.assertEqual((self.root / "evidence-client" / "generated.json").stat().st_mode & 0o777, 0o600)

    def test_refuses_authoring_report_for_a_different_package(self) -> None:
        def completed(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
            result = self._completed(command)
            if command[:2] == ["evidencectl", "check"]:
                report = json.loads(result.stdout)
                report["packageDigest"] = "sha256:" + "f" * 64
                return subprocess.CompletedProcess(command, 0, json.dumps(report), "")
            return result

        with mock.patch.object(self.module.subprocess, "run", side_effect=completed):
            with self.assertRaisesRegex(RuntimeError, "authored Evidence target differs"):
                self.module.prepare_client(self.root)
        self.assertFalse((self.root / "evidence-client" / "generated.json").exists())


if __name__ == "__main__":
    unittest.main()
