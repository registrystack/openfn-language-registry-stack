#!/usr/bin/env python3
"""Regression checks for the pilot's immutable Registry Stack release tuple."""

from __future__ import annotations

import importlib
import json
from pathlib import Path
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
DEPLOYMENT = ROOT / "deployment"
AGRICULTURE = ROOT / "pilot" / "agriculture"
VERSION = "0.45.0"
RUNTIME = ".runtime-0.45"
PROJECT = "registry-openfn-pilot-045"

IMAGES = {
    "breg": (
        "ghcr.io/registrystack/breg:v0.45.0@"
        "sha256:4e039b26800952c20926a1cdc1b138232c564ed2ec8f73f7b23c3234140fd7d9"
    ),
    "casework": (
        "ghcr.io/registrystack/casework:v0.45.0@"
        "sha256:d0446630798f4f53f291f10f5018eb00cd8883e4383ebb7f9b897a1405eee72d"
    ),
    "evidence": (
        "ghcr.io/registrystack/evidence:v0.45.0@"
        "sha256:8b9229af2308f70d3cbdc8ac8131fc670b929bb3db174c153719de21135447ab"
    ),
}

TOOLS = {
    "breg-v0.45.0-linux-amd64": "659d41fa92d7cdd46c922175013ddfc80c06c030032495ae3a618a37d4f0f86b",
    "bregctl-v0.45.0-linux-amd64": "dd314b50f239135d044ce136804c8782621fb86d335367d5610bafc9424cd3e7",
    "casework-v0.45.0-linux-amd64": "9da02599f5ee83d1b4105f706f944276bbfed91efd19593644b0d9f1c8fc4988",
    "caseworkctl-v0.45.0-linux-amd64": "dfcf16583f369e3191ed447707ed7d1efe831d3e4610b09ac4f53f53b717bb0f",
    "evidence-v0.45.0-linux-amd64": "46149d2ff161bd84175694ff86559c318ce732bf108c1017d5e2598d2c237181",
    "evidencectl-v0.45.0-linux-amd64": "32986a0b01ff97d4b5215df57b53c13c64fa88f10ddcb6414b9ac1d5b47d8926",
}


class ReleaseTupleTests(unittest.TestCase):
    def test_lock_and_compose_use_exact_release_images(self) -> None:
        lock = json.loads((DEPLOYMENT / "images.lock.json").read_text())
        self.assertEqual(lock["registryClientVersion"], VERSION)
        compose = (DEPLOYMENT / "compose.yaml").read_text()
        for product, expected in IMAGES.items():
            self.assertEqual(lock[product], expected)
            self.assertIn(f"image: {expected}", compose)

    def test_linux_tools_use_release_manifest_checksums(self) -> None:
        actual = {}
        for line in (DEPLOYMENT / "tools.sha256").read_text().splitlines():
            checksum, filename = line.split()
            actual[filename] = checksum
        self.assertEqual(actual, TOOLS)
        dockerfile = (DEPLOYMENT / "Tools.Dockerfile").read_text()
        self.assertIn("releases/download/v0.45.0", dockerfile)
        self.assertIn("$tool-v0.45.0-linux-amd64", dockerfile)

    def test_active_deployment_isolated_from_retained_038_state(self) -> None:
        active_files = [
            path
            for path in DEPLOYMENT.rglob("*")
            if path.is_file()
            and path.name not in {"README.md", "test_release_tuple.py"}
            and ".runtime" not in path.parts
            and "__pycache__" not in path.parts
        ] + [
            AGRICULTURE / "prepare.py",
            AGRICULTURE / "initialize.py",
            AGRICULTURE / "issuer.py",
        ]
        stale = {
            str(path.relative_to(ROOT)): marker
            for path in active_files
            for marker in ("0.38", "pilot-038", ".runtime-0.38")
            if marker in path.read_text(encoding="utf-8")
        }
        self.assertEqual(stale, {})
        compose = (DEPLOYMENT / "compose.yaml").read_text()
        pilot = (DEPLOYMENT / "pilot.sh").read_text()
        self.assertIn(f"name: {PROJECT}", compose)
        self.assertIn(f"--network {PROJECT}_default", pilot)
        self.assertIn(RUNTIME, compose)
        self.assertIn(RUNTIME, pilot)
        self.assertIn("10.254.45.0/24", compose)

    def test_generated_workflow_bindings_use_v045_action_contract(self) -> None:
        sys.path.insert(0, str(AGRICULTURE))
        try:
            prepare = importlib.import_module("prepare")
        finally:
            sys.path.pop(0)
        self.assertEqual(prepare.VERSION, VERSION)
        self.assertEqual(
            prepare.workflow_bindings()["breg"],
            {
                "accessProfile": "openfn-service",
                "farmEntity": "farm",
                "farmCreateOperation": "records.farm.create",
                "selector": "by-local-identifier",
                "correctionAction": "correct-farm-name",
                "correctionAccessProfile": "openfn-service",
            },
        )

    def test_preparation_requires_all_six_exact_release_binaries(self) -> None:
        sys.path.insert(0, str(AGRICULTURE))
        try:
            prepare = importlib.import_module("prepare")
        finally:
            sys.path.pop(0)
        with mock.patch.object(prepare, "run", return_value="tool 0.45.0") as run:
            prepare.check_versions(Path("/released-tools"))
        self.assertEqual(run.call_count, 6)
        with mock.patch.object(prepare, "run", return_value="tool 0.45.0-dev"):
            with self.assertRaises(SystemExit):
                prepare.check_versions(Path("/development-tools"))

    def test_deployment_docs_name_new_and_retained_runtimes(self) -> None:
        body = (DEPLOYMENT / "README.md").read_text(encoding="utf-8")
        normalized = " ".join(body.split())
        self.assertIn("Registry Stack **0.45.0**", normalized)
        self.assertIn(RUNTIME, body)
        self.assertIn(".runtime-0.38", body)
        self.assertIn("not reused", normalized)

    def test_ci_acceptance_cleanup_selects_the_new_pilot_only(self) -> None:
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        self.assertIn("Build pinned 0.45 images", workflow)
        self.assertEqual(workflow.count("pilot/agriculture/.runtime-0.45/prepared.json"), 2)
        self.assertNotIn("pilot/agriculture/.runtime-0.38/prepared.json", workflow)


if __name__ == "__main__":
    unittest.main()
