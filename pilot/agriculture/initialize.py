#!/usr/bin/env python3
"""Activate the fresh 0.45 core, then package the Transit-bound Evidence service."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import urllib.error
import urllib.request

import yaml

from issuer import token as issue_token


ROOT = Path(os.environ.get("PILOT_RUNTIME_ROOT", "/config"))
HERE = Path(__file__).resolve().parent


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, url):
        return None


DIRECTORY_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), NoRedirect()
)


def issuer_jwks() -> dict:
    bindings = json.loads(
        (ROOT / "issuer-bindings.json").read_text(encoding="utf-8")
    )
    uri = bindings.get("jwksUri")
    if uri != "https://127.0.0.1:8443/oauth2/jwks":
        raise RuntimeError("issuer JWKS endpoint differs from the fixed pilot endpoint")
    context = ssl.create_default_context(cafile=str(ROOT / "tls" / "ca.pem"))
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=context),
        NoRedirect(),
    )
    request = urllib.request.Request(uri, headers={"Accept": "application/json"})
    try:
        with opener.open(request, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError(
                    f"issuer JWKS request was refused (HTTP {response.status})"
                )
            body = response.read(65537)
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            f"issuer JWKS request was refused (HTTP {error.code})"
        ) from None
    except (OSError, urllib.error.URLError):
        raise RuntimeError("issuer JWKS request did not complete") from None
    if len(body) > 65536:
        raise RuntimeError("issuer JWKS document exceeds the pilot size limit")
    try:
        document = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RuntimeError("issuer returned an invalid JWKS document") from None
    keys = document.get("keys") if isinstance(document, dict) else None
    if not isinstance(keys, list) or not keys:
        raise RuntimeError("issuer JWKS document has no public keys")
    kids: set[str] = set()
    compatible_keys: list[dict] = []
    private_fields = {"d", "p", "q", "dp", "dq", "qi", "oth", "k"}
    public_fields = {"kty", "kid", "alg", "use", "key_ops", "n", "e"}
    for key in keys:
        if not isinstance(key, dict) or key.get("kty") not in {"RSA", "EC", "OKP"}:
            raise RuntimeError("issuer JWKS document contains an unsupported key")
        kid = key.get("kid")
        if not isinstance(kid, str) or not kid or kid in kids:
            raise RuntimeError("issuer JWKS document has invalid key identifiers")
        if private_fields.intersection(key):
            raise RuntimeError("issuer JWKS document contains private key material")
        if (
            key.get("kty") == "RSA"
            and key.get("alg") == "RS256"
            and key.get("use") in {None, "sig"}
            and key.get("key_ops") in (None, ["verify"])
            and isinstance(key.get("n"), str)
            and isinstance(key.get("e"), str)
        ):
            compatible_keys.append({
                name: value for name, value in key.items()
                if name in public_fields
            })
        kids.add(kid)
    if not compatible_keys:
        raise RuntimeError("issuer JWKS has no RS256 signing key for the pilot")
    return {"keys": compatible_keys}


def initialize_issuer_jwks() -> None:
    document = issuer_jwks()
    destinations = (
        ROOT / "breg" / "secrets" / "issuer-jwks",
        ROOT / "casework" / "secrets" / "issuer-jwks",
    )
    for destination in destinations:
        if destination.exists():
            try:
                retained = json.loads(destination.read_text(encoding="utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise RuntimeError("retained issuer JWKS document is invalid") from None
            if retained != document:
                raise RuntimeError(
                    "live issuer keys differ from the retained pilot trust document"
                )
        else:
            save(destination, document)


def run(binary: str, *args: object) -> str:
    result = subprocess.run(
        [binary, *map(str, args)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode:
        raise RuntimeError(
            f"{Path(binary).name} command failed (exit {result.returncode}); "
            "raw output was withheld"
        )
    return result.stdout


def activate_evidence_authority(runtime: Path, document: Path) -> str:
    result = subprocess.run(
        [
            "evidence", "authority", "activate",
            "--runtime-config", str(runtime),
            "--document", str(document),
            "--operator-reference", "agriculture-openfn-pilot-0.45.0",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode == 0:
        return "applied"
    if "is already active for this package as sequence" in result.stderr:
        return "already-active"
    raise RuntimeError(
        f"evidence authority activate failed (exit {result.returncode}); "
        "raw output was withheld"
    )


def save(path: Path, value: object) -> None:
    temporary = path.with_name(path.name + ".tmp")
    if isinstance(value, str):
        body = value
    elif path.suffix in {".yaml", ".yml"}:
        body = yaml.safe_dump(value, sort_keys=False)
    else:
        body = json.dumps(value, indent=2, sort_keys=True) + "\n"
    temporary.write_text(body, encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def initialize_breg() -> None:
    breg = ROOT / "breg"
    runtime = breg / "runtime.yaml"
    if (breg / "initialized.json").exists():
        run("bregctl", "verify", "--runtime-config", runtime)
        return

    for profile, client, scopes in (
        ("reader", "reader", None),
        ("editor", "editor", None),
        ("reviewer", "reviewer", ["starter:reviewer"]),
    ):
        bearer = issue_token(ROOT, client, scopes)
        if bearer.count(".") != 2 or any(char.isspace() for char in bearer):
            raise RuntimeError("issuer returned an invalid access token")
        save(breg / "secrets" / f"token-{profile}", bearer)

    receipt = breg / "schema-test-receipt.json"
    if not receipt.exists():
        report = run(
            "bregctl", "--format", "json", "test", breg / "registry",
            "--runtime-config", breg / "test-runtime.yaml",
            "--credentials", breg / "schema-test-credentials.json",
            "--output", receipt,
        )
        save(breg / "schema-test-report.json", report)

    build = breg / "build"
    if not (build / "package").exists():
        if build.exists():
            raise RuntimeError(
                "incomplete BReg package build exists; inspect it before retrying"
            )
        report = run(
            "bregctl", "--format", "json", "package", breg / "registry",
            "--test-receipt", receipt,
            "--revision", "agriculture-openfn-pilot-0.45.0",
            "--output", build,
        )
        save(breg / "package-report.json", report)
    package_report = json.loads(
        (breg / "package-report.json").read_text(encoding="utf-8")
    )
    configuration = yaml.safe_load(
        (breg / "runtime-template.yaml").read_text(encoding="utf-8")
    )
    configuration["package"]["expectedDigest"] = package_report["packageDigest"]
    save(runtime, configuration)
    run(
        "bregctl", "apply", "--runtime-config", runtime,
        "--package", build / "package", "--initial",
    )
    run("bregctl", "verify", "--runtime-config", runtime)
    save(
        breg / "initialized.json",
        {"packageDigest": package_report["packageDigest"]},
    )


def initialize_casework() -> None:
    casework = ROOT / "casework"
    project = casework / "project"
    runtime = casework / "runtime.yaml"
    if (casework / "initialized.json").exists():
        marker = json.loads((casework / "initialized.json").read_text(encoding="utf-8"))
        status = json.loads(run(
            "caseworkctl", "status", "--runtime-config", runtime, "--format", "json"
        ))
        active = (status.get("activation") or {}).get("active") or {}
        if active.get("packageDigest") != marker.get("packageDigest"):
            raise RuntimeError("active Casework package differs from the retained pilot package")
        return
    package = casework / "package"
    breg_package = ROOT / "breg" / "build" / "package"
    if not package.exists():
        paired = run(
            "caseworkctl", "--format", "json", "provider", "pair", project,
            "--provider-id", "agricultural-holdings",
            "--breg-package", breg_package,
            "--action-id", "correct-farm-name",
            "--apply",
        )
        save(casework / "provider-pair-report.json", paired)
        checked = run(
            "caseworkctl", "check", project,
            "--production",
            "--against-breg-package", breg_package,
            "--provider-id", "agricultural-holdings",
            "--format", "json",
        )
        save(casework / "check-report.json", checked)
        tested = run("caseworkctl", "test", project, "--format", "json")
        save(casework / "test-report.json", tested)
        packaged = run(
            "caseworkctl", "package", project,
            "--output", package,
            "--revision", "agriculture-openfn-pilot-0.45.0-policy-2",
            "--format", "json",
        )
        save(casework / "package-report.json", packaged)
    package_report = json.loads(
        (casework / "package-report.json").read_text(encoding="utf-8")
    )
    configuration = yaml.safe_load(
        (casework / "runtime-template.yaml").read_text(encoding="utf-8")
    )
    configuration["package"]["expectedDigest"] = package_report["packageDigest"]
    save(runtime, configuration)
    if (casework / "apply-report.json").exists():
        report = json.loads((casework / "apply-report.json").read_text(encoding="utf-8"))
    else:
        plan = run(
            "caseworkctl", "plan", "--runtime-config", runtime, "--format", "json"
        )
        save(casework / "plan-report.json", plan)
        applied = run(
            "caseworkctl", "apply", "--runtime-config", runtime,
            "--operator-reference", "agriculture-openfn-pilot-0.45.0-policy-2",
            "--format", "json",
        )
        report = json.loads(applied)
        save(casework / "apply-report.json", report)
    applied_digest = (report.get("activation") or {}).get("packageDigest")
    if applied_digest != package_report["packageDigest"]:
        raise RuntimeError("Casework applied package differs from the rehearsed package")
    status = json.loads(run(
        "caseworkctl", "status", "--runtime-config", runtime, "--format", "json"
    ))
    active = (status.get("activation") or {}).get("active") or {}
    if active.get("packageDigest") != applied_digest:
        raise RuntimeError("active Casework package differs from the rehearsed package")
    save(
        casework / "initialized.json",
        {"packageDigest": applied_digest},
    )


def initialize_core() -> None:
    os.environ["SSL_CERT_FILE"] = str(ROOT / "breg" / "secrets" / "trust-bundle.pem")
    initialize_issuer_jwks()
    initialize_breg()
    initialize_casework()
    print("BReg and Casework packages activated in their fresh databases.")


def casework_directory_request(
    path: str,
    bearer: str,
    *,
    method: str = "GET",
    body: dict | None = None,
    headers: dict[str, str] | None = None,
) -> dict:
    if not path.startswith("/v1/directory") or path.startswith("//"):
        raise RuntimeError("unexpected Casework directory path")
    request_headers = {
        "Authorization": "Bearer " + bearer,
        "Accept": "application/json",
        "Registry-Casework-Profile": "administrator",
        **(headers or {}),
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        "http://127.0.0.1:8092" + path,
        method=method,
        data=data,
        headers=request_headers,
    )
    try:
        with DIRECTORY_OPENER.open(request, timeout=10) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            f"Casework directory request was refused (HTTP {error.code})"
        ) from None
    except (OSError, urllib.error.URLError, ValueError):
        raise RuntimeError("Casework directory request did not complete") from None


def initialize_directory() -> None:
    os.environ["SSL_CERT_FILE"] = str(ROOT / "tls" / "ca.pem")
    bindings = json.loads(
        (ROOT / "issuer-bindings.json").read_text(encoding="utf-8")
    )
    issuer = bindings["issuer"]
    administrator = issue_token(ROOT, "casework-admin")
    member = {"issuer": issuer, "subject": "synthetic-reviewer"}
    expected = {
        "id": "agriculture-reviewers",
        "members": [member],
        "supervisors": [],
        "servedQueues": ["corrections"],
    }

    def verify(directory: dict) -> int:
        revision = directory.get("revision")
        teams = directory.get("teams")
        if not isinstance(revision, int) or not isinstance(teams, list):
            raise RuntimeError("Casework returned an invalid directory response")
        comparable = [
            {key: team.get(key) for key in expected}
            for team in teams
            if isinstance(team, dict)
        ]
        if comparable != [expected]:
            raise RuntimeError(
                "Casework directory differs from the fixed pilot authority"
            )
        return revision

    current = casework_directory_request("/v1/directory", administrator)
    if current.get("revision") == 0 and current.get("teams") == []:
        current = casework_directory_request(
            "/v1/directory/bootstrap",
            administrator,
            method="POST",
            body={
                "teamId": expected["id"],
                "staff": [member],
                "supervisors": [],
                "queueId": "corrections",
            },
            headers={
                "If-Match": '"0"',
                "Idempotency-Key": "agriculture-pilot-directory-v1",
            },
        )
    revision = verify(current)
    save(
        ROOT / "casework" / "directory-initialized.json",
        {
            "revision": revision,
            "team": expected["id"],
            "queue": "corrections",
            "staff": member,
        },
    )
    print("Casework reviewer directory is ready.")


def prepare_evidence_client() -> None:
    run(sys.executable, HERE / "evidence-client.py", "--root", ROOT)
    generated = json.loads(
        (ROOT / "evidence-client" / "generated.json").read_text(encoding="utf-8")
    )
    evidence = generated.get("evidence") if isinstance(generated, dict) else None
    request = evidence.get("request") if isinstance(evidence, dict) else None
    if not isinstance(request, dict):
        raise RuntimeError("explicit Evidence client binding has no request policy")
    bindings_path = ROOT / "workflow-bindings.json"
    bindings = json.loads(bindings_path.read_text(encoding="utf-8"))
    if not isinstance(bindings, dict) or not isinstance(bindings.get("evidence"), dict):
        raise RuntimeError("pilot workflow bindings are invalid")
    bindings["evidence"]["request"] = request
    save(bindings_path, bindings)


def verify_evidence_authority(runtime: Path, project: Path, target: Path) -> None:
    authored = json.loads(run(
        "evidencectl", "check", project, "--target", target,
        "--production", "--format", "json",
    ))
    authority = authored.get("authority") or {}
    expected = (
        authority.get("authorityRevision"),
        authority.get("digest"),
        authored.get("packageDigest"),
    )
    if any(not isinstance(value, str) or not value.startswith("sha256:")
           for value in expected):
        raise RuntimeError("Evidence authoring report has no exact authority identity")
    history = run(
        "evidence", "authority", "history", "--runtime-config", runtime,
    ).strip().splitlines()
    if not history:
        raise RuntimeError("Evidence has no active target authority")
    latest = history[-1].split()
    if len(latest) != 4 or not latest[0].isdigit() or tuple(latest[1:]) != expected:
        raise RuntimeError("active Evidence authority differs from the authored pilot target")


def initialize_evidence() -> None:
    evidence = ROOT / "evidence"
    deployed = Path("/config/evidence")
    runtime = evidence / "runtime.yaml"
    os.environ["SSL_CERT_FILE"] = str(ROOT / "tls" / "ca.pem")
    if (evidence / "initialized.json").exists():
        run("evidencectl", "doctor", "--runtime-config", runtime)
        verify_evidence_authority(runtime, evidence / "project", evidence / "target")
        prepare_evidence_client()
        print("Transit-bound Evidence package verified.")
        return
    public_key = (
        evidence / "transit-public" / "evidence-signing.jwk.json"
    )
    if not public_key.is_file():
        raise RuntimeError(
            "OpenBao has not exported the pinned Transit version 1 public JWK"
        )
    project_public_key = (
        evidence / "project" / "public-keys" / "evidence-signing.jwk.json"
    )
    project_public_key.parent.mkdir(mode=0o700, exist_ok=True)
    shutil.copyfile(public_key, project_public_key)
    project_public_key.chmod(0o600)
    target = evidence / "target"
    if not target.exists():
        run(
            "evidencectl", "target", "new", deployed / "target",
            "--settings", deployed / "project" / "production-target.yaml",
        )
    run(
        "evidencectl", "check", deployed / "project",
        "--target", deployed / "target", "--production",
    )
    fixtures = run(
        "evidencectl", "test", deployed / "project",
        "--target", deployed / "target", "--format", "json",
    )
    save(evidence / "transit-fixture-report.json", fixtures)
    candidate = evidence / "candidate"
    if not (candidate / "bundle").is_dir():
        if candidate.exists():
            raise RuntimeError(
                "incomplete Evidence candidate exists; inspect it before retrying"
            )
        package = run(
            "evidencectl", "package", deployed / "project",
            "--target", deployed / "target",
            "--output", deployed / "candidate",
            "--format", "json",
        )
        save(evidence / "package-report.json", package)
    compiled_bundle = candidate / "bundle"
    installed_bundle = evidence / "package"
    if installed_bundle.exists():
        if not installed_bundle.is_dir():
            raise RuntimeError("retained Evidence package path is not a directory")
        compiled_files = {
            path.relative_to(compiled_bundle): path.read_bytes()
            for path in compiled_bundle.rglob("*") if path.is_file()
        }
        installed_files = {
            path.relative_to(installed_bundle): path.read_bytes()
            for path in installed_bundle.rglob("*") if path.is_file()
        }
        if installed_files != compiled_files:
            raise RuntimeError("installed Evidence package differs from the compiled candidate")
    else:
        shutil.copytree(compiled_bundle, installed_bundle)
    target_runtime = candidate / "runtime.yaml"
    if runtime.exists():
        if runtime.read_bytes() != target_runtime.read_bytes():
            raise RuntimeError(
                "retained Evidence runtime differs from the packaged candidate"
            )
    else:
        shutil.copyfile(target_runtime, runtime)
        runtime.chmod(0o400)
    activation = activate_evidence_authority(
        deployed / "runtime.yaml",
        deployed / "candidate" / "compiled-authority.yaml",
    )
    save(evidence / "authority-activation.json", {"outcome": activation})
    checked = run(
        "evidence", "check", "--runtime-config", deployed / "runtime.yaml",
        "--format", "json",
    )
    save(evidence / "runtime-check-report.json", checked)
    run("evidencectl", "doctor", "--runtime-config", deployed / "runtime.yaml")
    verify_evidence_authority(runtime, evidence / "project", evidence / "target")
    prepare_evidence_client()
    package_report = json.loads(
        (evidence / "package-report.json").read_text(encoding="utf-8")
    )
    save(
        evidence / "initialized.json",
        {"packageDigest": package_report["packageDigest"]},
    )
    prepared = json.loads(
        (ROOT / "prepared.json").read_text(encoding="utf-8")
    )
    evaluated_cases = json.loads(fixtures).get("evaluatedCases")
    if not isinstance(evaluated_cases, int) or evaluated_cases < 1:
        raise RuntimeError("Evidence fixture report has no evaluated cases")
    prepared["fixtures"] = evaluated_cases
    prepared["evidencePackage"] = "transit-version-1"
    save(ROOT / "prepared.json", prepared)
    print("Evidence production package compiled against Transit key version 1.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "component", choices=("core", "directory", "evidence", "all")
    )
    arguments = parser.parse_args()
    os.umask(0o077)
    if arguments.component in {"core", "all"}:
        initialize_core()
    if arguments.component == "directory":
        initialize_directory()
    if arguments.component in {"evidence", "all"}:
        initialize_evidence()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Initialization stopped: {error}", file=sys.stderr)
        sys.exit(1)
