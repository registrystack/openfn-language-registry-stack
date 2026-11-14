#!/usr/bin/env python3
"""Render and use the pilot's pinned, stock ThunderID development issuer."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import ssl
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import yaml


ISSUER = "https://127.0.0.1:8443"
TOKEN_ENDPOINT = ISSUER + "/oauth2/token"
JWKS_URI = ISSUER + "/oauth2/jwks"
DEFAULT_RESOURCE = "urn:example:audience:agriculture-pilot"
ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
DEFAULT_OU = "default"
DEFAULT_AGENT_TYPE = "default"

_PINNED_AGENT_SCHEMA = """\
resource_type: agent_type
id: 01900000-0000-7000-8000-000000000011
name: default
ouHandle: default
schema:
  modelProvider:
    type: string
    displayName: Model Provider
    required: false
    enum:
      - openai
      - anthropic
      - gemini
      - mistral
      - custom
  model:
    type: string
    displayName: Model
    required: false
  function:
    type: string
    displayName: Function
    required: false
    enum:
      - task-automation
      - rag-retrieval
      - code-gen
      - data-analysis
      - orchestrator
      - sub-agent
      - assistant
      - custom
"""


def _write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        raise RuntimeError(f"issuer output already exists: {path}")
    if isinstance(value, str):
        text = value
    elif path.suffix in {".yaml", ".yml"}:
        # ThunderID's directory importer supplies document boundaries between
        # files. A per-file `---` creates an empty document and is rejected.
        text = yaml.safe_dump(value, sort_keys=False)
    else:
        text = json.dumps(value, indent=2, sort_keys=True) + "\n"
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)


def _derived_uuid(seed: str) -> str:
    value = list(hashlib.sha256(seed.encode()).hexdigest()[:32])
    value[12], value[16] = "7", "8"
    raw = "".join(value)
    return f"{raw[:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:]}"


def _scope_resources(scopes: set[str]) -> list[dict]:
    resources: dict[str, dict] = {}
    for scope in sorted(scopes):
        pieces = scope.split(":")
        if len(pieces) < 2 or any(
            not piece or any(not (char.isalnum() or char in "-_") for char in piece)
            for piece in pieces
        ):
            raise ValueError(f"invalid ThunderID scope handle: {scope}")
        handle, action = pieces[0], ":".join(pieces[1:])
        if len(handle) > 64 or len(action) > 64:
            raise ValueError(f"ThunderID scope handle is too long: {scope}")
        resource = resources.setdefault(
            handle,
            {
                "name": handle,
                "handle": handle,
                "description": f"pilot resource {handle}",
                "actions": [],
            },
        )
        resource["actions"].append(
            {
                "name": action,
                "handle": action,
                "description": f"pilot permission {scope}",
                "kind": "resource",
            }
        )
    return list(resources.values())


def _deployment_yaml() -> str:
    return f"""\
server:
  http_only: true
  hostname: "0.0.0.0"
  public_url: {ISSUER}
  port: 8091
  security:
    direct_auth_secret: "file://config/secrets/direct_auth_secret"
tls:
  min_version: "1.3"
  cert_file: "config/certs/server.cert"
  key_file: "config/certs/server.key"
database:
  config:
    type: "sqlite"
    sqlite: {{ path: "database/configdb.db" }}
  runtime_transient:
    type: "sqlite"
    sqlite: {{ path: "database/runtime_transient.db" }}
  entity:
    type: "sqlite"
    sqlite: {{ path: "database/entitydb.db" }}
  runtime_persistent:
    type: "sqlite"
    sqlite: {{ path: "database/runtime_persistent.db" }}
crypto:
  encryption:
    key: "file://config/certs/crypto.key"
  password_hashing:
    algorithm: "PBKDF2"
  keys:
    - id: "default-key"
      cert_file: "config/certs/signing.cert"
      key_file: "config/certs/signing.key"
    - id: "ecdsa-key"
      cert_file: "config/certs/ecdsa-signing.cert"
      key_file: "config/certs/ecdsa-signing.key"
jwt:
  preferred_key_id: "default-key"
resource:
  store: composite
role:
  store: composite
identity_provider:
  store: declarative
passkey:
  allowed_origins:
    - "127.0.0.1:8443"
"""


def _prepare_tls(root: Path) -> Path:
    tls = root / "tls"
    tls.mkdir(mode=0o700)
    commands = [
        ["req", "-x509", "-new", "-nodes", "-newkey", "rsa:3072", "-sha256", "-days", "365",
         "-subj", "/CN=Synthetic agriculture pilot CA",
         "-addext", "basicConstraints=critical,CA:TRUE",
         "-addext", "keyUsage=critical,keyCertSign,cRLSign",
         "-addext", "subjectKeyIdentifier=hash",
         "-keyout", str(tls / "ca.key"), "-out", str(tls / "ca.pem")],
        ["req", "-new", "-nodes", "-newkey", "rsa:3072", "-subj", "/CN=127.0.0.1",
         "-keyout", str(tls / "server.key"), "-out", str(tls / "server.csr")],
    ]
    for command in commands:
        subprocess.run(["openssl", *command], check=True, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _write(
        tls / "server.ext",
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n"
        "subjectKeyIdentifier=hash\n"
        "authorityKeyIdentifier=keyid,issuer\n"
        "subjectAltName=IP:127.0.0.1,DNS:issuer\n",
    )
    subprocess.run(
        ["openssl", "x509", "-req", "-sha256", "-days", "365", "-in", str(tls / "server.csr"),
         "-CA", str(tls / "ca.pem"), "-CAkey", str(tls / "ca.key"), "-CAcreateserial",
         "-extfile", str(tls / "server.ext"), "-out", str(tls / "server.crt")],
        check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for path in tls.iterdir():
        path.chmod(0o600)
    return tls / "ca.pem"


def prepare_issuer(root: Path, clients: list[dict]) -> dict:
    """Render native ThunderID resources and one private key per declared client."""
    root = Path(root).resolve()
    issuer_root = root / "issuer"
    if issuer_root.exists():
        raise RuntimeError("issuer state already exists; retain it or prepare a fresh runtime")
    issuer_root.mkdir(parents=True, mode=0o700)
    os.chmod(issuer_root, 0o700)
    for directory in ("database", "certs", "secrets", "resources", "registry-schema"):
        (issuer_root / directory).mkdir(mode=0o700)
    ca_bundle = _prepare_tls(root)

    session_id = secrets.token_urlsafe(24)
    server_id = _derived_uuid(f"{session_id}:server")
    normalized: list[dict] = []
    logical_ids: set[str] = set()
    client_ids: set[str] = set()
    all_scopes: set[str] = set()
    claim_kinds: dict[str, str] = {}
    resource = None

    for raw in clients:
        logical_id = raw.get("logicalId")
        client_id = raw.get("clientId")
        client_resource = raw.get("resource", DEFAULT_RESOURCE)
        scopes = raw.get("scopes")
        claims = raw.get("claims", {})
        key_directory = Path(raw.get("keyDirectory", ""))
        if (
            not isinstance(logical_id, str)
            or not logical_id
            or logical_id in logical_ids
            or not isinstance(client_id, str)
            or not client_id
            or client_id in client_ids
        ):
            raise ValueError("issuer clients need distinct non-empty logicalId and clientId values")
        if resource is None:
            resource = client_resource
        if client_resource != resource or not isinstance(resource, str) or not resource:
            raise ValueError("this pilot uses one explicit ThunderID resource audience")
        if not isinstance(scopes, list) or not scopes or not all(isinstance(v, str) for v in scopes):
            raise ValueError(f"issuer client {logical_id} needs explicit scopes")
        if not isinstance(claims, dict) or not all(isinstance(k, str) for k in claims):
            raise ValueError(f"issuer client {logical_id} has invalid claims")
        if claims.get("registry_actor_kind") == "human" and raw.get("allowHumanFixture") is not True:
            raise ValueError(f"issuer client {logical_id} must explicitly allow its synthetic human fixture")
        if not key_directory.is_absolute() or root not in key_directory.parents:
            raise ValueError(f"issuer client {logical_id} keyDirectory must be inside the runtime root")
        for name, value in claims.items():
            kind = "array" if isinstance(value, list) and all(isinstance(v, str) for v in value) else "string"
            if kind == "string" and not isinstance(value, str):
                raise ValueError(f"issuer claim {name} must be a string or string array")
            if name in claim_kinds and claim_kinds[name] != kind:
                raise ValueError(f"issuer claim {name} has conflicting types")
            claim_kinds[name] = kind

        subprocess.run(
            ["evidencectl", "keygen", "signing", "--output-dir", str(key_directory)],
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        private_jwk = key_directory / "signing-p256-private-jwk"
        public_jwk = key_directory / "signing-p256-public.jwk.json"
        public = json.loads(public_jwk.read_text(encoding="utf-8"))
        if any(name in public for name in ("d", "p", "q")):
            raise RuntimeError("issuer client public JWK contains private material")
        native_subject = _derived_uuid(f"{session_id}:agent:{client_id}")
        role_id = _derived_uuid(f"{session_id}:role:{client_id}")
        normalized.append(
            {
                "logicalId": logical_id,
                "clientId": client_id,
                "subject": native_subject,
                "requestedSubject": raw.get("subject"),
                "resource": resource,
                "scopes": sorted(set(scopes)),
                "claims": claims,
                "privateJwk": private_jwk.relative_to(root).as_posix(),
                "publicJwk": public_jwk.relative_to(root).as_posix(),
                "public": public,
                "roleId": role_id,
            }
        )
        logical_ids.add(logical_id)
        client_ids.add(client_id)
        all_scopes.update(scopes)

    if not normalized:
        raise ValueError("issuer needs at least one client")

    _write(issuer_root / "deployment.yaml", _deployment_yaml())
    _write(issuer_root / "secrets" / "admin-password", secrets.token_urlsafe(32) + "\n")
    _write(issuer_root / "secrets" / "bootstrap-password", secrets.token_urlsafe(32) + "\n")
    _write(
        issuer_root / "resources" / "resource_servers" / f"{server_id}.yaml",
        {
            "resource_type": "resource_server",
            "id": server_id,
            "name": "Agriculture pilot",
            "description": "Synthetic agriculture pilot APIs",
            "identifier": resource,
            "ouHandle": DEFAULT_OU,
            "delimiter": ":",
            "resources": _scope_resources(all_scopes),
        },
    )

    schema = yaml.safe_load(_PINNED_AGENT_SCHEMA)
    for name, kind in sorted(claim_kinds.items()):
        schema["schema"][name] = (
            {"type": "array", "items": {"type": "string"}, "displayName": name, "required": False}
            if kind == "array"
            else {"type": "string", "displayName": name, "required": False}
        )
    _write(issuer_root / "registry-schema" / "agent-type.yaml", schema)

    client_index: dict[str, dict] = {}
    for client in normalized:
        public_jwks = json.dumps({"keys": [client.pop("public")]}, separators=(",", ":"))
        _write(
            issuer_root / "resources" / "roles" / f"{client['roleId']}.yaml",
            {
                "resource_type": "role",
                "id": client["roleId"],
                "name": f"Pilot {client['logicalId']}",
                "description": "Explicit synthetic pilot permissions",
                "ouHandle": DEFAULT_OU,
                "permissions": [{"resourceServerId": server_id, "permissions": client["scopes"]}],
                "assignments": [{"id": client["subject"], "type": "agent"}],
            },
        )
        _write(
            issuer_root / "registry-schema" / "agents" / f"{client['subject']}.yaml",
            {
                "resource_type": "agent",
                "id": client["subject"],
                "type": DEFAULT_AGENT_TYPE,
                "ouHandle": DEFAULT_OU,
                "name": f"Pilot {client['logicalId']}",
                "description": "Synthetic agriculture pilot client",
                "attributes": client["claims"],
                "inboundAuthConfig": [
                    {
                        "type": "oauth2",
                        "config": {
                            "clientId": client["clientId"],
                            "grantTypes": ["client_credentials"],
                            "tokenEndpointAuthMethod": "private_key_jwt",
                            "publicClient": False,
                            "certificate": {"type": "JWKS", "value": public_jwks},
                            "token": {
                                "accessToken": {
                                    "clientConfig": {
                                        "validityPeriod": 300,
                                        "attributes": sorted(client["claims"]),
                                    }
                                }
                            },
                        },
                    }
                ],
            },
        )
        client.pop("roleId")
        client_index[client["logicalId"]] = client

    index = {
        "schema": "synthetic-agriculture-thunderid/v1",
        "issuer": ISSUER,
        "tokenEndpoint": TOKEN_ENDPOINT,
        "clientAssertionAudience": ISSUER,
        "jwksUri": JWKS_URI,
        "resource": resource,
        "caBundle": ca_bundle.relative_to(root).as_posix(),
        "sessionId": session_id,
        "clients": client_index,
    }
    _write(issuer_root / "clients.json", index)
    returned = {key: value for key, value in index.items() if key != "sessionId"}
    returned["clients"] = {
        logical_id: {
            **client,
            "privateJwk": str(root / client["privateJwk"]),
            "publicJwk": str(root / client["publicJwk"]),
        }
        for logical_id, client in index["clients"].items()
    }
    returned["caBundle"] = str(ca_bundle)
    return returned


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _der_length(length: int) -> bytes:
    if length < 128:
        return bytes([length])
    encoded = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(encoded)]) + encoded


def _der(tag: int, value: bytes) -> bytes:
    return bytes([tag]) + _der_length(len(value)) + value


def _private_pem(jwk: dict) -> bytes:
    try:
        scalar = base64.urlsafe_b64decode(jwk["d"] + "==")
        x = base64.urlsafe_b64decode(jwk["x"] + "==")
        y = base64.urlsafe_b64decode(jwk["y"] + "==")
    except (KeyError, ValueError) as error:
        raise RuntimeError("issuer client key is not a private EC JWK") from error
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256" or len(scalar) != 32 or len(x) != 32 or len(y) != 32:
        raise RuntimeError("issuer client key must be an EC P-256 private JWK")
    oid_prime256v1 = bytes.fromhex("06082a8648ce3d030107")
    body = _der(0x02, b"\x01") + _der(0x04, scalar)
    body += bytes([0xA0]) + _der_length(len(oid_prime256v1)) + oid_prime256v1
    point = b"\x04" + x + y
    bit_string = _der(0x03, b"\x00" + point)
    body += bytes([0xA1]) + _der_length(len(bit_string)) + bit_string
    encoded = base64.b64encode(_der(0x30, body))
    return b"-----BEGIN EC PRIVATE KEY-----\n" + b"\n".join(
        encoded[index : index + 64] for index in range(0, len(encoded), 64)
    ) + b"\n-----END EC PRIVATE KEY-----\n"


def _read_der_integer(data: bytes, offset: int) -> tuple[int, int]:
    if offset >= len(data) or data[offset] != 0x02:
        raise RuntimeError("OpenSSL returned a malformed ECDSA signature")
    offset += 1
    length = data[offset]
    offset += 1
    if length & 0x80:
        count = length & 0x7F
        length = int.from_bytes(data[offset : offset + count], "big")
        offset += count
    value = int.from_bytes(data[offset : offset + length], "big")
    return value, offset + length


def _jose_signature(der: bytes) -> bytes:
    if len(der) < 8 or der[0] != 0x30:
        raise RuntimeError("OpenSSL returned a malformed ECDSA signature")
    offset = 2
    if der[1] & 0x80:
        count = der[1] & 0x7F
        offset = 2 + count
    r, offset = _read_der_integer(der, offset)
    s, offset = _read_der_integer(der, offset)
    if offset != len(der):
        raise RuntimeError("OpenSSL returned a malformed ECDSA signature")
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def token(
    runtime_root: Path,
    logical_id: str,
    scopes: list[str] | None = None,
    *,
    timeout: float = 5.0,
) -> str:
    """Mint one bearer token for a prepared client's fixed resource and scopes."""
    root = Path(runtime_root).resolve()
    index_path = root / "issuer" / "clients.json"
    if index_path.stat().st_mode & 0o077:
        raise RuntimeError("issuer client index must be owner-only")
    index = json.loads(index_path.read_text(encoding="utf-8"))
    try:
        client = index["clients"][logical_id]
        private_path = root / client["privateJwk"]
    except (KeyError, TypeError) as error:
        raise RuntimeError(f"unknown prepared issuer client: {logical_id}") from error
    registered_scopes = client.get("scopes")
    if not isinstance(registered_scopes, list) or not all(
        isinstance(scope, str) and scope for scope in registered_scopes
    ):
        raise RuntimeError("issuer client index has invalid registered scopes")
    requested_scopes = registered_scopes if scopes is None else scopes
    if (
        not isinstance(requested_scopes, list)
        or not requested_scopes
        or not all(isinstance(scope, str) and scope for scope in requested_scopes)
        or len(set(requested_scopes)) != len(requested_scopes)
        or not set(requested_scopes).issubset(registered_scopes)
    ):
        raise RuntimeError("requested issuer scopes must be a non-empty registered subset")
    if private_path.stat().st_mode & 0o077:
        raise RuntimeError("issuer client private key must be owner-only")
    jwk = json.loads(private_path.read_text(encoding="utf-8"))
    now = int(time.time())
    header = {"alg": "ES256", "typ": "JWT", "kid": jwk.get("kid")}
    if not isinstance(header["kid"], str) or not header["kid"]:
        raise RuntimeError("issuer client key has no kid")
    claims = {
        "iss": client["clientId"],
        "sub": client["clientId"],
        "aud": index["clientAssertionAudience"],
        "iat": now,
        "exp": now + 60,
        "jti": secrets.token_urlsafe(24),
    }
    signing_input = (
        _b64(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + _b64(json.dumps(claims, separators=(",", ":")).encode())
    ).encode("ascii")
    key_fd, key_name = tempfile.mkstemp(prefix="pilot-thunderid-", suffix=".pem")
    try:
        os.fchmod(key_fd, 0o600)
        with os.fdopen(key_fd, "wb") as handle:
            handle.write(_private_pem(jwk))
        signed = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", key_name],
            input=signing_input,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
        ).stdout
    finally:
        os.unlink(key_name)
    assertion = signing_input.decode("ascii") + "." + _b64(_jose_signature(signed))
    form = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": client["clientId"],
            "client_assertion_type": ASSERTION_TYPE,
            "client_assertion": assertion,
            "resource": client["resource"],
            "scope": " ".join(requested_scopes),
        }
    ).encode("ascii")
    request = urllib.request.Request(
        index["tokenEndpoint"],
        data=form,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    context = ssl.create_default_context(cafile=str(root / index["caBundle"]))
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=context),
        _NoRedirect(),
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read(65537)
            if response.status != 200 or len(body) > 65536:
                raise RuntimeError("ThunderID token endpoint refused the client")
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError("ThunderID token request failed") from error
    try:
        document = json.loads(body)
        access_token = document["access_token"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise RuntimeError("ThunderID token response is malformed") from error
    if not isinstance(access_token, str) or access_token.count(".") != 2 or any(char.isspace() for char in access_token):
        raise RuntimeError("ThunderID token response has no compact access token")
    if str(document.get("token_type", "Bearer")).lower() != "bearer":
        raise RuntimeError("ThunderID token response has an unexpected token type")
    returned_scopes = document.get("scope")
    if returned_scopes is not None and not set(requested_scopes).issubset(str(returned_scopes).split()):
        raise RuntimeError("ThunderID token response omitted a requested scope")
    return access_token


def _main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["token"])
    parser.add_argument("logical_id")
    parser.add_argument(
        "--runtime-root",
        type=Path,
        default=Path("/workspace/pilot/agriculture/.runtime-0.45"),
    )
    args = parser.parse_args()
    if args.command == "token":
        print(token(args.runtime_root, args.logical_id))


if __name__ == "__main__":
    try:
        _main()
    except Exception as error:
        raise SystemExit(f"ThunderID token request failed: {error}")
