#!/usr/bin/env python3
"""Generate the private explicit Evidence client binding from its governed bundle."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

import yaml


DEFAULT_ROOT = Path("/workspace/pilot/agriculture/.runtime-0.45")
SCHEMA = "synthetic-agriculture-evidence-client/v1"
PRIVATE_JWK_FIELDS = {"d", "p", "q", "dp", "dq", "qi", "oth", "k"}
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


def _load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"invalid pilot JSON document: {path.name}") from error


def _load_yaml(path: Path) -> object:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as error:
        raise RuntimeError(f"invalid governed Evidence document: {path.name}") from error


def _one(items: object, label: str) -> dict:
    if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
        raise RuntimeError(f"the governed Evidence bundle must define one {label}")
    return items[0]


def _sole(items: object, label: str) -> object:
    if not isinstance(items, list) or len(items) != 1:
        raise RuntimeError(f"the governed Evidence bundle must define one {label}")
    return items[0]


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise RuntimeError(f"the governed Evidence bundle has an invalid {label}")
    return value


def _relative_file(root: Path, value: object, label: str) -> Path:
    relative = PurePosixPath(_string(value, label))
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"{label} must be a runtime-relative file")
    unresolved = root / Path(*relative.parts)
    if unresolved.is_symlink():
        raise RuntimeError(f"{label} must not be a symbolic link")
    path = unresolved.resolve(strict=True)
    if root != path.parent and root not in path.parents:
        raise RuntimeError(f"{label} leaves the selected runtime")
    if not path.is_file() or path.is_symlink():
        raise RuntimeError(f"{label} must name a regular runtime file")
    return path


def _atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    body = json.dumps(value, indent=2, sort_keys=True) + "\n"
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _checked_report(command: list[str], label: str) -> dict:
    try:
        result = subprocess.run(
            command,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
            env={key: value for key, value in os.environ.items() if key != "REGISTRY_EVIDENCE_RUNTIME"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"the released {label} validator did not complete") from error
    if result.returncode:
        raise RuntimeError(f"the released {label} validator rejected the governed deployment")
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"the released {label} validator returned an invalid report") from error
    if (
        not isinstance(report, dict)
        or report.get("ok") is not True
        or not DIGEST.fullmatch(str(report.get("packageDigest", "")))
    ):
        raise RuntimeError(f"the {label} report has an invalid package digest")
    return report


def _runtime_check(runtime: Path) -> dict:
    return _checked_report(
        ["evidence", "check", "--runtime-config", str(runtime), "--format", "json"],
        "Evidence runtime",
    )


def _authoring_check(project: Path, target: Path) -> dict:
    return _checked_report(
        [
            "evidencectl", "check", str(project), "--target", str(target),
            "--production", "--format", "json",
        ],
        "Evidence authoring",
    )


def _public_jwk(value: object, label: str) -> dict:
    if not isinstance(value, dict) or PRIVATE_JWK_FIELDS.intersection(value):
        raise RuntimeError(f"{label} is not a public JWK")
    if (
        value.get("kty") != "EC"
        or value.get("crv") != "P-256"
        or value.get("alg") not in (None, "ES256")
        or not isinstance(value.get("kid"), str)
        or not isinstance(value.get("x"), str)
        or not isinstance(value.get("y"), str)
    ):
        raise RuntimeError(f"{label} is not the expected ES256 public JWK")
    return value


def prepare_client(runtime_root: Path) -> dict:
    """Write the exact explicit Node client configuration and request policy."""
    root = Path(runtime_root).resolve(strict=True)
    candidate = root / "evidence" / "candidate"
    bundle_root = candidate / "bundle"
    bundle = _load_yaml(bundle_root / "evidence.yaml")
    if (
        not isinstance(bundle, dict)
        or bundle.get("apiVersion") != "id.registrystack.org/formats/evidence/bundle/v1"
        or bundle.get("kind") != "EvidenceBundle"
    ):
        raise RuntimeError("the governed Evidence bundle has an unsupported version")
    if bundle.get("assuranceProfile") != "production":
        raise RuntimeError("the pilot requires the production Evidence assurance profile")

    runtime = root / "evidence" / "runtime.yaml"
    if not runtime.is_file():
        runtime = candidate / "runtime.yaml"
    runtime_report = _runtime_check(runtime)
    authoring_report = _authoring_check(
        root / "evidence" / "project",
        root / "evidence" / "target",
    )
    package_report = _load_json(root / "evidence" / "package-report.json")
    if (
        not isinstance(package_report, dict)
        or package_report.get("packageDigest") != runtime_report["packageDigest"]
        or package_report.get("revision") is not None
    ):
        raise RuntimeError("the retained Evidence package report differs from the activated package")
    if authoring_report["packageDigest"] != runtime_report["packageDigest"]:
        raise RuntimeError("the authored Evidence target differs from the activated package")
    if runtime_report.get("requirements") != 1:
        raise RuntimeError("the activated Evidence package must define one requirement")

    requirement = _one(bundle.get("requirements"), "requirement")
    requirement_id = _string(requirement.get("uri"), "requirement id")
    requirement_handle = _string(requirement.get("handle"), "requirement handle")
    purpose = _string(_sole(requirement.get("purposes"), "requirement purpose"), "purpose")
    evidence_type = _string(requirement.get("evidenceType"), "evidence type")
    subject_role = _one(requirement.get("subjectRoles"), "subject role")
    if subject_role.get("cardinality") != "one":
        raise RuntimeError("the pilot Evidence subject role must have cardinality one")
    role = _string(subject_role.get("role"), "subject role")
    selector_profile = _string(
        _sole(subject_role.get("selectorProfiles"), "subject selector profile"),
        "subject selector profile",
    )
    selector_profiles = bundle.get("selectorProfiles")
    if not isinstance(selector_profiles, dict) or not isinstance(selector_profiles.get(selector_profile), dict):
        raise RuntimeError("the governed Evidence selector profile is missing")
    selector_fields = selector_profiles[selector_profile].get("fields")
    if not isinstance(selector_fields, dict) or list(selector_fields) != ["local-identifier"]:
        raise RuntimeError("the pilot requires the governed local-identifier selector")

    issuer = _string((bundle.get("issuer") or {}).get("uri"), "issuer")
    provider = _string((bundle.get("service") or {}).get("providerId"), "provider")
    base_url = _string((bundle.get("service") or {}).get("publicOrigin"), "public origin")
    if base_url != provider or base_url != "https://127.0.0.1:8445":
        raise RuntimeError("the Evidence provider and public origin must be the fixed HTTPS pilot endpoint")

    signing = bundle.get("signing")
    if not isinstance(signing, dict) or signing.get("algorithm") != "ES256":
        raise RuntimeError("the governed Evidence bundle must use ES256")
    if signing.get("format") != "flattened-jws-json":
        raise RuntimeError("the governed Evidence bundle must use flattened JWS JSON")
    active_path = _relative_file(bundle_root, signing.get("activePublicJwkFile"), "active public JWK")
    active_jwk = _public_jwk(_load_json(active_path), "active public JWK")
    transit_jwk = _public_jwk(
        _load_json(root / "evidence" / "transit-public" / "evidence-signing.jwk.json"),
        "Transit public JWK",
    )
    if active_jwk != transit_jwk:
        raise RuntimeError("the governed Evidence key differs from the retained Transit public key")
    revoked = signing.get("revokedKeyIds")
    if not isinstance(revoked, list) or not all(isinstance(value, str) and value for value in revoked):
        raise RuntimeError("the governed Evidence revoked-key list is invalid")

    authority = _load_yaml(candidate / "compiled-authority.yaml")
    if (
        not isinstance(authority, dict)
        or authority.get("apiVersion")
        != "id.registrystack.org/formats/evidence/compiled-target-authority/v1alpha1"
        or authority.get("kind") != "EvidenceCompiledTargetAuthority"
        or authority.get("project") != bundle.get("project")
        or authority.get("target") != "production"
    ):
        raise RuntimeError("the governed Evidence target authority is invalid")
    grant_profiles = authority.get("accessProfiles")
    if not isinstance(grant_profiles, dict) or len(grant_profiles) != 1:
        raise RuntimeError("the governed Evidence bundle must define one authority profile")
    profile = next(iter(grant_profiles.values()))
    if (
        not isinstance(profile, dict)
        or profile.get("kind") != "organizational"
        or profile.get("actorKind") != "service"
    ):
        raise RuntimeError("the governed Evidence authority must identify one service requester")
    grant = _one(profile.get("grants"), "authority grant")
    granted_subject = _one(grant.get("subjects"), "grant subject")
    if (
        grant.get("requirement") != requirement_id
        or grant.get("purpose") != purpose
        or grant.get("audienceFrom") != "authenticated-requester"
        or grant.get("responseFormats") != ["signed-jws"]
        or grant.get("subjectBindingModes") != ["audience-scoped"]
        or granted_subject.get("role") != role
        or granted_subject.get("selectorProfile") != selector_profile
        or granted_subject.get("valueOrigin") != "request"
    ):
        raise RuntimeError("the governed Evidence authority grant differs from the request policy")

    revisions = authoring_report.get("definitionRevisions")
    if not isinstance(revisions, list):
        raise RuntimeError("the Evidence authoring report has no definition revisions")
    matching_revisions = [
        item for item in revisions
        if isinstance(item, dict) and item.get("requirement") == requirement_id
    ]
    revision_entry = _one(matching_revisions, "configuration revision")
    revision = revision_entry.get("configurationRevision")
    if not isinstance(revision, str) or not DIGEST.fullmatch(revision):
        raise RuntimeError("the Evidence bundle report does not bind the governed requirement")

    expected_outputs = []
    for concept in requirement.get("concepts", []):
        if not isinstance(concept, dict):
            raise RuntimeError("the governed Evidence concept is invalid")
        expected_outputs.append({
            "handle": _string(concept.get("handle"), "concept handle"),
            "concept": _string(concept.get("uri"), "concept id"),
            "required": concept.get("required"),
            "form": {"type": concept.get("type")},
        })
    if not expected_outputs or any(
        output["required"] is not True or not isinstance(output["form"], dict)
        or output["form"].get("type") != "boolean"
        for output in expected_outputs
    ):
        raise RuntimeError("the governed Evidence output is not the pilot boolean")

    index = _load_json(root / "issuer" / "clients.json")
    if not isinstance(index, dict) or index.get("schema") != "synthetic-agriculture-thunderid/v1":
        raise RuntimeError("the retained issuer client index is invalid")
    clients = index.get("clients")
    client = clients.get("openfn-evidence") if isinstance(clients, dict) else None
    if not isinstance(client, dict):
        raise RuntimeError("the retained Evidence OAuth client is missing")
    scopes = client.get("scopes")
    claims = client.get("claims")
    if scopes != ["evidence:request"] or not isinstance(claims, dict):
        raise RuntimeError("the retained Evidence OAuth client has unexpected permissions")
    audience = _string(claims.get("evidence_audience"), "Evidence audience")
    private_key_path = _relative_file(root, client.get("privateJwk"), "Evidence client private JWK")
    if private_key_path.stat().st_mode & 0o077:
        raise RuntimeError("the retained Evidence OAuth client key is not owner-only")
    private_key = _load_json(private_key_path)
    if (
        not isinstance(private_key, dict)
        or private_key.get("kty") != "EC"
        or private_key.get("crv") != "P-256"
        or private_key.get("alg") not in (None, "ES256")
        or not all(
            isinstance(private_key.get(field), str) and private_key[field]
            for field in ("kid", "x", "y", "d")
        )
    ):
        raise RuntimeError("the retained Evidence OAuth client key is invalid")
    ca_path = _relative_file(root, index.get("caBundle"), "pilot CA bundle")
    ca_bundle = ca_path.read_text(encoding="utf-8")
    if ca_bundle.count("-----BEGIN CERTIFICATE-----") != 1 or not ca_bundle.endswith("\n"):
        raise RuntimeError("the retained pilot CA bundle is invalid")

    token_endpoint = _string(index.get("tokenEndpoint"), "token endpoint")
    assertion_audience = _string(index.get("clientAssertionAudience"), "client assertion audience")
    if token_endpoint != "https://127.0.0.1:8443/oauth2/token" or assertion_audience != "https://127.0.0.1:8443":
        raise RuntimeError("the retained issuer endpoints differ from the fixed HTTPS pilot endpoints")
    resource = _string(client.get("resource"), "OAuth resource")
    if resource != index.get("resource"):
        raise RuntimeError("the retained Evidence OAuth resource differs from the issuer resource")

    configuration = {
        "baseUrl": base_url,
        "trustedJwks": {"keys": [active_jwk]},
        "revokedKeyIds": revoked,
        "token": {"privateKeyJwt": {
            "tokenEndpoint": token_endpoint,
            "clientId": _string(client.get("clientId"), "OAuth client id"),
            "clientKey": private_key,
            "audience": assertion_audience,
            "resource": resource,
            "scopes": scopes,
            "trustedRootCertificates": ca_bundle,
        }},
        "trustedRootCertificates": ca_bundle,
    }
    request = {
        "responseFormat": "signed-jws",
        "requirement": requirement_id,
        "purpose": purpose,
        "audience": audience,
        "evidenceType": evidence_type,
        "issuedBy": issuer,
        "providedBy": provider,
        "configurationRevision": revision,
        "expectedAssuranceProfile": "production",
        "subjects": [{
            "role": role,
            "selectorProfile": selector_profile,
            "selectorValues": {
                "local-identifier": {"valueFrom": "data.values.local-identifier"},
            },
        }],
        "expectedOutputs": expected_outputs,
        "maximumAssertionLifetimeSeconds": requirement.get("validitySeconds"),
        "clockSkewSeconds": signing.get("verifierClockSkewSeconds"),
        "subjectExpectations": "acceptFirstUse",
    }
    if requirement_handle != "holding-registered":
        raise RuntimeError("the governed Evidence bundle has an unexpected requirement handle")
    if not isinstance(request["maximumAssertionLifetimeSeconds"], int) or not 1 <= request["maximumAssertionLifetimeSeconds"] <= 31_536_000:
        raise RuntimeError("the governed Evidence assertion lifetime is invalid")
    maximum_validity = signing.get("maximumAssertionValiditySeconds")
    if not isinstance(maximum_validity, int) or request["maximumAssertionLifetimeSeconds"] > maximum_validity:
        raise RuntimeError("the governed Evidence assertion lifetime exceeds the signing ceiling")
    if not isinstance(request["clockSkewSeconds"], int) or not 0 <= request["clockSkewSeconds"] <= 300:
        raise RuntimeError("the governed Evidence clock skew is invalid")

    generated = {
        "schema": SCHEMA,
        "packageDigest": runtime_report["packageDigest"],
        "evidence": {
            "configuration": {"evidence": configuration},
            "request": request,
        },
    }
    _atomic_json(root / "evidence-client" / "generated.json", generated)
    _atomic_json(root / "openfn" / "evidence-credential.json", {"evidence": configuration})
    return generated


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    arguments = parser.parse_args()
    os.umask(0o077)
    prepare_client(arguments.root)
    print("Explicit Evidence client binding prepared.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Evidence client preparation stopped: {error}", file=sys.stderr)
        sys.exit(1)
