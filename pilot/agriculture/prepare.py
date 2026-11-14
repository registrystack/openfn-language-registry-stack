#!/usr/bin/env python3
"""Prepare a fresh, offline Registry Stack 0.45 agriculture pilot."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess

import yaml

from issuer import prepare_issuer


HERE = Path(__file__).resolve().parent
VERSION = "0.45.0"
RESOURCE = "urn:example:audience:agriculture-pilot"
PROFILE = "breg-8-registry-4-farm-19-by-local-identifier"
REQUIREMENT = "urn:example:requirement:holding-registered:v1"
PILOT_NETWORK = ipaddress.ip_network("10.254.0.0/16")
DEFAULT_PILOT_SUBNET = "10.254.45.0/24"


def write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        raise RuntimeError(f"prepared output already exists: {path}")
    if isinstance(value, str):
        body = value
    elif path.suffix in {".yaml", ".yml"}:
        body = yaml.safe_dump(value, sort_keys=False)
    else:
        body = json.dumps(value, indent=2, sort_keys=True) + "\n"
    path.write_text(body, encoding="utf-8")
    path.chmod(0o600)


def run(binary: Path | str, *args: object) -> str:
    result = subprocess.run(
        [str(binary), *map(str, args)],
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


def check_versions(bins: Path) -> None:
    for name in (
        "breg", "bregctl", "casework", "caseworkctl", "evidence", "evidencectl"
    ):
        reported = run(bins / name, "--version").split()[-1]
        if reported != VERSION:
            raise SystemExit(
                f"{name} reports {reported}; this pilot requires Registry Stack {VERSION}"
            )


def secure_prepared_tree(root: Path) -> None:
    for path in root.rglob("*"):
        path.chmod(0o700 if path.is_dir() else 0o600)


def client_descriptors(root: Path) -> list[dict]:
    def client(
        logical_id: str,
        scopes: list[str],
        claims: dict[str, object],
        *,
        human: bool = False,
    ) -> dict:
        value = {
            "logicalId": logical_id,
            "clientId": logical_id,
            "subject": f"synthetic-{logical_id}",
            "resource": RESOURCE,
            "scopes": scopes,
            "claims": claims,
            "keyDirectory": str(root / "clients" / logical_id),
        }
        if human:
            value["allowHumanFixture"] = True
        return value

    return [
        client("reader", ["starter:reader"], {
            "registry_actor_kind": "service",
            "registry_principal": "synthetic-reader",
            "registry_purpose": "starter-learning",
        }),
        client("editor", ["starter:editor"], {
            "registry_actor_kind": "human",
            "registry_principal": "synthetic-editor",
            "registry_purpose": "starter-learning",
        }, human=True),
        client("reviewer", ["casework:staff", "starter:reviewer"], {
            "registry_actor_kind": "human",
            "registry_principal": "synthetic-reviewer",
            "registry_purpose": "starter-learning",
        }, human=True),
        client("openfn-service", ["pilot:submit"], {
            "registry_actor_kind": "service",
            "registry_principal": "synthetic-openfn-service",
            "registry_purpose": "agriculture-registration",
        }),
        client("evidence-source", ["pilot:evidence-source"], {
            "registry_actor_kind": "service",
            "registry_principal": "synthetic-evidence-source",
            "registry_purpose": "evidence-source-read",
        }),
        client("casework-reader", ["casework:source-reader"], {
            "registry_actor_kind": "service",
            "registry_principal": "casework-reader",
            "registry_purpose": "casework-sync",
        }),
        client("casework-producer", ["casework:reviews:request"], {
            "registry_actor_kind": "service",
        }),
        client("casework-admin", ["casework:admin"], {
            "registry_actor_kind": "human",
            "registry_principal": "synthetic-casework-admin",
        }, human=True),
        client("openfn-evidence", ["evidence:request"], {
            "registry_actor_kind": "service",
            "evidence_tags": ["holding-verifier"],
            "evidence_audience": RESOURCE,
        }),
    ]


def database_files(
    root: Path,
    service: str,
    database: str,
    roles: tuple[str, str],
) -> None:
    database_root = root / f"{service}-db"
    secrets_root = root / service / "secrets"
    admin_password = secrets.token_hex(24)
    migration_password = secrets.token_hex(24)
    runtime_password = secrets.token_hex(24)
    migration_role, runtime_role = roles
    write(
        database_root / "postgres.env",
        f"POSTGRES_USER=postgres\nPOSTGRES_PASSWORD={admin_password}\nPOSTGRES_DB=postgres\n",
    )
    sql = (
        f"CREATE ROLE {migration_role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
        f"NOINHERIT NOBYPASSRLS PASSWORD '{migration_password}';\n"
        f"CREATE ROLE {runtime_role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
        f"NOINHERIT NOBYPASSRLS PASSWORD '{runtime_password}';\n"
    )
    databases = [database, database + "_test"] if service == "breg" else [database]
    for name in databases:
        owner = "" if service == "breg" else f" OWNER {migration_role}"
        sql += (
            f"CREATE DATABASE {name}{owner};\n"
            f"\\connect {name}\n"
            "CREATE EXTENSION IF NOT EXISTS btree_gist;\n"
            f"REVOKE ALL ON DATABASE {name} FROM PUBLIC;\n"
            f"GRANT CONNECT ON DATABASE {name} TO {migration_role}, {runtime_role};\n"
        )
        if service == "breg":
            schemas = (
                "registry_internal", "registry_data", "registry_source",
                "registry_derived", "registry_context",
            )
            sql += "".join(
                f"CREATE SCHEMA {schema} AUTHORIZATION {migration_role};\n"
                for schema in schemas
            )
            sql += (
                "REVOKE ALL ON SCHEMA " + ", ".join(schemas)
                + " FROM PUBLIC;\n"
            )
    write(database_root / "bootstrap.sql", sql)
    host = f"{service}-db"
    write(
        secrets_root / "runtime-database-url",
        f"postgresql://{runtime_role}:{runtime_password}@{host}:5432/{database}",
    )
    write(
        secrets_root / "migration-database-url",
        f"postgresql://{migration_role}:{migration_password}@{host}:5432/{database}",
    )
    if service == "breg":
        write(
            secrets_root / "test-runtime-database-url",
            f"postgresql://{runtime_role}:{runtime_password}@{host}:5432/{database}_test",
        )
        write(
            secrets_root / "test-migration-database-url",
            f"postgresql://{migration_role}:{migration_password}@{host}:5432/{database}_test",
        )

    run(
        "openssl", "req", "-x509", "-new", "-nodes", "-newkey", "rsa:2048",
        "-sha256", "-days", "365", "-subj", f"/CN=Synthetic {service} database CA",
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        "-addext", "subjectKeyIdentifier=hash",
        "-keyout", database_root / "ca.key", "-out", database_root / "ca.pem",
    )
    run(
        "openssl", "req", "-new", "-nodes", "-newkey", "rsa:2048",
        "-subj", f"/CN={host}", "-keyout", database_root / "server.key",
        "-out", database_root / "server.csr",
    )
    write(
        database_root / "server.ext",
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n"
        f"subjectAltName=DNS:{host}\n"
        "subjectKeyIdentifier=hash\n"
        "authorityKeyIdentifier=keyid,issuer\n",
    )
    run(
        "openssl", "x509", "-req", "-sha256", "-days", "365",
        "-in", database_root / "server.csr", "-CA", database_root / "ca.pem",
        "-CAkey", database_root / "ca.key", "-CAcreateserial",
        "-extfile", database_root / "server.ext", "-out", database_root / "server.crt",
    )
    shutil.copyfile(database_root / "ca.pem", secrets_root / "database-ca.pem")
    (secrets_root / "database-ca.pem").chmod(0o600)


def schema_credentials(registry: Path, destination: Path) -> None:
    bindings = []
    for filename in ("journeys.yaml",):
        document = yaml.safe_load(
            (registry / "tests" / filename).read_text(encoding="utf-8")
        )
        for journey in document["journeys"]:
            for step in journey["steps"]:
                profile = step["accessProfile"]
                bindings.append({
                    "journeyId": journey["id"],
                    "stepId": step["id"],
                    "credential": {
                        "type": "bearer",
                        "tokenRef": f"secret:file/token-{profile}",
                    },
                })
    write(destination, {
        "apiVersion": "id.registrystack.org/formats/breg/schema-test-credentials/v1",
        "kind": "BRegSchemaTestCredentials",
        "bindings": bindings,
    })


def breg_runtime(bindings: dict, *, test: bool) -> dict:
    package_root = "/config/breg/empty-package" if test else "/config/breg/build/package"
    prefix = "test-" if test else ""
    event_destinations = {
        "openfn": {
            "origin": "http://localhost:8081",
            "path": "/events/breg",
            "networkProfile": "loopback-development-http",
            "dnsFamily": "ipv4-only",
            "allowedPrivateCidrs": [],
            "hmacSha256KeyRef": "secret:file/openfn-webhook-key",
            "classificationCeiling": "restricted",
            "deliveryCeilings": {
                "attemptTimeoutMilliseconds": 5000,
                "maximumAttempts": 5,
            },
        },
    }
    review_authorities = {
        "casework": {
            "endpoint": "http://127.0.0.1:8092",
            "profile": "integration-requester",
            "producerId": "registry-breg",
            "recoveryDays": 7,
            "privateKeyJwt": {
                "tokenEndpoint": bindings["tokenEndpoint"],
                "clientIdRef": "secret:file/casework-producer-client-id",
                "clientAssertionKeyRef": "secret:file/casework-producer-private-jwk",
                "assertionAudience": bindings["clientAssertionAudience"],
                "resource": bindings["resource"],
                "scopes": ["casework:reviews:request"],
                "caBundleRef": "secret:file/pilot-ca.pem",
            },
        },
    }
    return {
        "apiVersion": "id.registrystack.org/formats/breg/runtime/v1alpha1",
        "kind": "BRegRuntimeConfig",
        "listener": {
            "bind": "127.0.0.1:8090",
            "publicOrigin": "http://127.0.0.1:8090",
        },
        "identity": {
            "environment": "local",
            "instanceId": "agriculture-openfn-pilot-045",
            "databaseId": "agriculture-pilot-045-db",
            "databaseInitializationEnvironment": "local",
        },
        "secretProviders": {"file": {"root": "/config/breg/secrets"}},
        "database": {
            "runtimeUrlRef": f"secret:file/{prefix}runtime-database-url",
            "migrationUrlRef": f"secret:file/{prefix}migration-database-url",
            "pool": {"maximumConnections": 4},
            "roles": {
                "migration": "agriculture_migration",
                "runtime": "agriculture_runtime",
            },
        },
        "package": {"root": package_root},
        "authentication": {
            "oidc": {
                "issuer": bindings["issuer"],
                "audience": bindings["resource"],
                "allowedAlgorithm": "RS256",
                "accessTokenType": "at+jwt",
                "scopeClaim": "scope",
                "scopeSeparator": " ",
                "allowedClients": [
                    bindings["clients"][logical_id]["clientId"]
                    for logical_id in (
                        "reader", "editor", "reviewer", "openfn-service",
                        "evidence-source", "casework-reader",
                    )
                ],
                "maximumTokenLifetimeSeconds": 300,
                "leewayMilliseconds": 30000,
                "jwksSource": {
                    "type": "static",
                    "documentRef": "secret:file/issuer-jwks",
                },
            },
            "authorityClaims": {
                "principal": "registry_principal",
                "purpose": "registry_purpose",
            },
        },
        "audit": {
            "hashKeyRef": "secret:file/audit-key",
            "destination": "file",
            "path": (
                "/var/lib/registry-breg/test-audit.jsonl"
                if test else "/var/lib/registry-breg/audit.jsonl"
            ),
        },
        "cursor": {"secretRef": "secret:file/cursor-key"},
        "destinations": {"hooks": event_destinations},
        "retention": {"hookPayloadRetentionDays": 1},
        "reviewAuthorities": review_authorities,
    }


def prepare_casework(root: Path, bindings: dict) -> None:
    casework = root / "casework"
    source_root = HERE / "casework"
    stale_export_root = (source_root / "sources").resolve()

    def omit_stale_provider_export(directory: str, names: list[str]) -> list[str]:
        if Path(directory).resolve() == stale_export_root:
            return ["agricultural-holdings.json"]
        return []

    shutil.copytree(
        source_root,
        casework / "project",
        ignore=omit_stale_provider_export,
    )
    policy = casework / "project" / "casework.yaml"
    body = policy.read_text(encoding="utf-8")
    if body.count("__CASEWORK_PRODUCER_SUBJECT__") != 1:
        raise RuntimeError("Casework producer subject placeholder is missing or repeated")
    body = body.replace(
        "__CASEWORK_PRODUCER_SUBJECT__",
        bindings["clients"]["casework-producer"]["subject"],
    )
    policy.write_text(body, encoding="utf-8")
    policy.chmod(0o600)
    write(casework / "secrets" / "casework-audit-key", secrets.token_hex(32))
    reader = bindings["clients"]["casework-reader"]
    write(casework / "secrets" / "breg-reader-client-id", reader["clientId"])
    shutil.copyfile(reader["privateJwk"], casework / "secrets" / "breg-reader-key")
    (casework / "secrets" / "breg-reader-key").chmod(0o600)
    write(casework / "runtime-template.yaml", {
        "apiVersion": "id.registrystack.org/formats/casework/runtime/v1alpha1",
        "kind": "CaseworkRuntimeConfig",
        "identity": {"databaseId": "agriculture-casework-pilot-045"},
        "package": {"root": "/config/casework/package"},
        "listener": {
            "bind": "127.0.0.1:8092",
            "tlsTermination": "development-loopback",
            "networkExposure": "private-address",
        },
        "secretProviders": {"file": {"root": "/config/casework/secrets"}},
        "database": {
            "runtimeUrlRef": "secret:file/runtime-database-url",
            "migrationUrlRef": "secret:file/migration-database-url",
            "trustedRootCertificateRef": "secret:file/database-ca.pem",
        },
        "authentication": {"oidc": {
            "issuer": bindings["issuer"],
            "audience": bindings["resource"],
            "scopeClaim": "scope",
            "jwksSource": {
                "type": "static",
                "documentRef": "secret:file/issuer-jwks",
            },
            "allowedClients": [
                bindings["clients"][logical_id]["clientId"]
                for logical_id in (
                    "reviewer", "casework-admin", "casework-producer",
                )
            ],
            "humanIdentity": {
                "claim": "registry_actor_kind",
                "value": "human",
            },
        }},
        "audit": {
            "path": "/var/lib/registry-casework/audit.ndjson",
            "hashKeyRef": "secret:file/casework-audit-key",
        },
        "contextProviders": {"agricultural-holdings": {
            "baseUrl": "http://127.0.0.1:8090",
            "statusProfile": "casework-reader",
            "tokenEndpoint": bindings["tokenEndpoint"],
            "clientAssertionAudience": bindings["clientAssertionAudience"],
            "resource": bindings["resource"],
            "scopes": ["casework:source-reader"],
            "clientIdRef": "secret:file/breg-reader-client-id",
            "clientAssertionKeyRef": "secret:file/breg-reader-key",
        }},
    })


def validate_pilot_subnet(value: str) -> str:
    try:
        network = ipaddress.ip_network(value, strict=True)
    except ValueError as error:
        raise ValueError("PILOT_SUBNET must be a canonical IPv4 /24 inside 10.254.0.0/16") from error
    if not isinstance(network, ipaddress.IPv4Network) or network.prefixlen != 24:
        raise ValueError("PILOT_SUBNET must be a /24 inside 10.254.0.0/16")
    if not network.subnet_of(PILOT_NETWORK):
        raise ValueError("PILOT_SUBNET must be inside 10.254.0.0/16")
    return str(network)


def bind_evidence_subnet(project: Path, subnet: str) -> None:
    for relative in ("production-target.yaml", "targets/production/settings.yaml"):
        path = project / relative
        target = yaml.safe_load(path.read_text(encoding="utf-8"))
        target["connections"]["registry"]["allowedPrivateCidrs"] = [subnet]
        path.write_text(yaml.safe_dump(target, sort_keys=False), encoding="utf-8")


def prepare_evidence(root: Path, bins: Path, bindings: dict, pilot_subnet: str) -> None:
    evidence = root / "evidence"
    project = evidence / "project"
    shutil.copytree(HERE / "evidence-starter", project)
    bind_evidence_subnet(project, pilot_subnet)
    (evidence / "secrets").mkdir(mode=0o700)
    for name in ("audit-hmac-key", "subject-binding-hmac-key"):
        run(
            bins / "evidencectl", "keygen", "secret",
            "--output", evidence / "secrets" / name,
        )
    source = bindings["clients"]["evidence-source"]
    write(evidence / "secrets" / "registry-client-id", source["clientId"])
    shutil.copyfile(
        source["privateJwk"], evidence / "secrets" / "registry-client-key"
    )
    (evidence / "secrets" / "registry-client-key").chmod(0o600)


def workflow_bindings() -> dict:
    return {
        "breg": {
            "accessProfile": "openfn-service",
            "farmEntity": "farm",
            "farmCreateOperation": "records.farm.create",
            "selector": "by-local-identifier",
            "correctionAction": "correct-farm-name",
            "correctionAccessProfile": "openfn-service",
        },
        "evidence": {
            "requirement": "holding-registered",
            "requirementId": REQUIREMENT,
            "selectorProfile": PROFILE,
            "purpose": "holding-verification",
            "registeredConcept": (
                "urn:example:concept:holding-registered:registered"
            ),
        },
    }


def prepare(root: Path, bins: Path, pilot_subnet: str = DEFAULT_PILOT_SUBNET) -> None:
    if root.exists():
        raise SystemExit("Output exists. Retain it, or choose a new --output directory.")
    pilot_subnet = validate_pilot_subnet(pilot_subnet)
    check_versions(bins)
    os.environ["PATH"] = str(bins) + os.pathsep + os.environ.get("PATH", "")
    os.environ["EVIDENCE_BIN"] = str(bins / "evidence")
    os.umask(0o077)
    root.mkdir(parents=True, mode=0o700)
    for name in (
        "breg", "casework", "evidence", "evidence-client", "openfn", "bridge",
        "breg-db", "casework-db", "openbao", "evidence/transit-public",
    ):
        (root / name).mkdir(parents=True, exist_ok=True, mode=0o700)

    bindings = prepare_issuer(root, client_descriptors(root))
    write(root / "issuer-bindings.json", bindings)
    ca_bundle = Path(bindings["caBundle"])
    for destination in (
        root / "breg" / "secrets" / "pilot-ca.pem",
        root / "casework" / "secrets" / "pilot-ca.pem",
        root / "evidence" / "tls" / "pilot-ca.pem",
        root / "evidence-client" / "pilot-ca.pem",
    ):
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(ca_bundle, destination)
        destination.chmod(0o600)

    breg = root / "breg"
    shutil.copytree(HERE / "registry", breg / "registry")
    write(
        breg / "check-report.json",
        run(bins / "bregctl", "check", breg / "registry", "--format", "json"),
    )
    for name in (
        "audit-key", "cursor-key", "openfn-webhook-key"
    ):
        write(breg / "secrets" / name, secrets.token_hex(32))
    producer = bindings["clients"]["casework-producer"]
    write(
        breg / "secrets" / "casework-producer-client-id",
        producer["clientId"],
    )
    shutil.copyfile(
        producer["privateJwk"],
        breg / "secrets" / "casework-producer-private-jwk",
    )
    (breg / "secrets" / "casework-producer-private-jwk").chmod(0o600)
    write(breg / "runtime-template.yaml", breg_runtime(bindings, test=False))
    write(breg / "test-runtime.yaml", breg_runtime(bindings, test=True))
    (breg / "empty-package").mkdir(mode=0o700)
    schema_credentials(
        breg / "registry", breg / "schema-test-credentials.json"
    )

    database_files(
        root, "breg", "agriculture",
        ("agriculture_migration", "agriculture_runtime"),
    )
    database_files(
        root, "casework", "agriculture_casework",
        ("casework_migration", "casework_runtime"),
    )
    write(
        breg / "secrets" / "trust-bundle.pem",
        (breg / "secrets" / "database-ca.pem").read_text(encoding="utf-8")
        + ca_bundle.read_text(encoding="utf-8"),
    )
    prepare_casework(root, bindings)
    prepare_evidence(root, bins, bindings, pilot_subnet)

    evidence_client = bindings["clients"]["openfn-evidence"]
    client_key = root / "evidence-client" / "keys" / "signing-p256-private-jwk"
    client_key.parent.mkdir(mode=0o700)
    shutil.copyfile(evidence_client["privateJwk"], client_key)
    client_key.chmod(0o600)

    write(
        root / "bridge" / "breg-hmac-key",
        (breg / "secrets" / "openfn-webhook-key").read_text(),
    )
    events = {}
    for event in ("farm-created-v1", "farm-patched-v1"):
        sample = json.loads(run(
            bins / "bregctl", "hook", "sample", breg / "registry",
            "--event", event, "--format", "json",
        ))
        events[event] = {
            "schema": sample["request"]["headers"]["ce-dataschema"],
            "trigger": sample["request"]["body"]["data"]["trigger"],
        }
    write(root / "bridge" / "expected-events.json", events)
    write(root / "bridge" / "allowed-value-fields.json", ["local-identifier"])
    write(
        root / "bridge" / "expected-source",
        "urn:registrystack:registry:agricultural-holdings:"
        "instance:agriculture-openfn-pilot-045",
    )

    openfn = bindings["clients"]["openfn-service"]
    write(root / "openfn" / "breg-credential.json", {"breg": {
        "baseUrl": "http://127.0.0.1:8090",
        "authorization": {"privateKeyJwt": {
            "tokenEndpoint": bindings["tokenEndpoint"],
            "clientId": openfn["clientId"],
            "clientKey": json.loads(
                Path(openfn["privateJwk"]).read_text(encoding="utf-8")
            ),
            "audience": bindings["clientAssertionAudience"],
            "resource": bindings["resource"],
            "scopes": openfn["scopes"],
            "trustedRootCertificates": ca_bundle.read_text(encoding="utf-8"),
        }},
    }})
    write(root / "workflow-bindings.json", workflow_bindings())
    write(root / "prepared.json", {
        "schema": "synthetic-agriculture-pilot/v1",
        "version": VERSION,
        "pilotSubnet": pilot_subnet,
        "fixtures": "pending-transit-public-key",
        "evidencePackage": "pending-transit-public-key",
    })
    secure_prepared_tree(root)
    print(
        "Prepared isolated Registry Stack 0.45 BReg, Casework, "
        "and Evidence authoring inputs."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument("--pilot-subnet", default=DEFAULT_PILOT_SUBNET)
    parser.add_argument(
        "--output", type=Path, default=HERE / ".runtime-0.45"
    )
    arguments = parser.parse_args()
    prepare(arguments.output.resolve(), arguments.bin_dir.resolve(), arguments.pilot_subnet)
