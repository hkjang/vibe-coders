#!/usr/bin/env python3
"""Run real Keycloak + embedded Go + Chromium without exposing ports or external access.

Requires Go, Docker, OpenSSL, locked web dependencies and staged internal/appui/dist.
Images are fetched only with --pull; runtime containers share a network=none namespace.
Only a validated numeric scenario summary leaves private temporary storage.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import tempfile
import time

KEYCLOAK = "quay.io/keycloak/keycloak:26.8.2@sha256:c68e286cacd87b942ac1939a0a1481461109d6acd3a57dc496969a319a76bbf0"
BROWSER = "mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e"
ISSUER = "https://127.0.0.2:8443/realms/vibe-browser"
GATEWAY = "https://127.0.0.1:4187"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pull", action="store_true")
    parser.add_argument("--report-dir", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    def interrupted(_number, _frame):
        raise RuntimeError("Isolated check interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    root = Path(__file__).resolve().parents[1]
    if not (root / "internal/appui/dist/index.html").is_file():
        raise RuntimeError("Stage production React assets before this check")
    if not (root / "web/node_modules/@playwright/test/cli.js").is_file():
        raise RuntimeError("Install frozen frontend dependencies before this check")
    # The checkout is mounted read-only. Docker cannot create a nested mount
    # destination there, so prepare only this ignored test-output directory.
    browser_output = root / "web/test-results"
    if browser_output.is_symlink():
        raise RuntimeError("Browser output must not be a symlink")
    browser_output.mkdir(exist_ok=True)
    for image in [KEYCLOAK, BROWSER]:
        if args.pull:
            subprocess.run(["docker", "pull", image], check=True)
        subprocess.run(["docker", "image", "inspect", image], stdout=subprocess.DEVNULL, check=True)
    args.report_dir.mkdir(parents=True, exist_ok=True)
    summary_path = args.report_dir / "keycloak-live-summary.json"
    if summary_path.exists():
        raise RuntimeError("Use a fresh report directory")
    names = []
    phase = "fixture creation"
    with tempfile.TemporaryDirectory(prefix="vibe-keycloak-") as temp:
        private = Path(temp)
        fixtures = private / "fixture"
        fixtures.mkdir()
        imports = fixtures / "import"
        imports.mkdir()
        reports = private / "reports"
        reports.mkdir()
        secret = secrets.token_urlsafe(32)
        password = secrets.token_urlsafe(32)
        (fixtures / "browser.json").write_text(json.dumps({"client_secret": secret, "password": password}))
        realm = {
            "realm": "vibe-browser", "enabled": True, "sslRequired": "all",
            "registrationAllowed": False, "resetPasswordAllowed": False,
            "groups": [{"name": "teams", "subGroups": [{"name": "Shared access"}]}],
            "roles": {"realm": [{"name": "vibe-admin"}, {"name": "vibe-auditor"}, {"name": "vibe-team-admin"}]},
            "clients": [{
                "clientId": "vibe-browser", "secret": secret, "publicClient": False,
                "protocol": "openid-connect", "standardFlowEnabled": True,
                "directAccessGrantsEnabled": False,
                "redirectUris": [GATEWAY + "/auth/keycloak/callback"],
                "webOrigins": [GATEWAY],
                "attributes": {"pkce.code.challenge.method": "S256", "post.logout.redirect.uris": GATEWAY + "/app/login"},
                "defaultClientScopes": ["profile", "email"],
                "protocolMappers": [{
                    "name": "gateway roles", "protocol": "openid-connect",
                    "protocolMapper": "oidc-usermodel-realm-role-mapper",
                    "config": {"claim.name": "realm_access.roles", "jsonType.label": "String", "multivalued": "true", "id.token.claim": "true", "access.token.claim": "true"},
                }, {
                    "name": "gateway groups", "protocol": "openid-connect",
                    "protocolMapper": "oidc-group-membership-mapper",
                    "config": {"claim.name": "groups", "full.path": "true", "id.token.claim": "true", "access.token.claim": "true"},
                }],
            }],
            "users": [{
                "username": name, "email": email, "enabled": True, "emailVerified": True,
                "firstName": "제품 검증", "lastName": "사용자",
                "realmRoles": [role],
                "groups": ["/teams/Shared access"] if name == "routing-reader" else [],
                "credentials": [{"type": "password", "value": password, "temporary": False}],
            } for name, email, role in [
                ("existing-operator", "existing@example.invalid", "vibe-admin"),
                ("new-operator", "new@example.invalid", "vibe-admin"),
                ("reader", "reader@example.invalid", "vibe-auditor"),
                ("routing-reader", "routing-reader@example.invalid", "vibe-team-admin"),
            ]],
        }
        (imports / "vibe-browser-realm.json").write_text(json.dumps(realm))
        try:
            with (private / "private.log").open("wb") as log:
                def run(command, **kwargs):
                    return subprocess.run(command, stdout=log, stderr=log, check=True, **kwargs)
                run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=isolated-keycloak", "-addext", "subjectAltName=IP:127.0.0.2", "-keyout", str(fixtures / "server.key"), "-out", str(fixtures / "server.crt")])
                # The outer temporary directory stays 0700 on the host. Inside
                # its read-only bind mount, Keycloak's uid 1000 must be able to
                # read fixtures even when the CI host uses a different uid.
                for path in [fixtures, imports, *fixtures.rglob("*")]:
                    if path.is_symlink(): raise RuntimeError("Unexpected fixture symlink")
                    path.chmod(0o755 if path.is_dir() else 0o444)
                phase = "Go browser test compilation"
                env = {key: os.environ[key] for key in ["PATH", "HOME", "USER", "LANG"] if key in os.environ}
                env.update(GOTOOLCHAIN="go1.26.11", CGO_ENABLED="0")
                run(["go", "test", "-c", "-o", str(private / "proxy.test"), "./internal/proxy"], cwd=root, env=env)
                prefix = "vibe-keycloak-" + secrets.token_hex(6)
                browser_name, keycloak_name = prefix + "-browser", prefix + "-idp"
                phase = "isolated browser namespace startup"
                names.append(browser_name)
                run(["docker", "run", "-d", "--rm", "--pull=never", "--name", browser_name, "--network=none", "--shm-size=1g",
                     "-v", str(root) + ":/work:ro", "-v", str(private / "proxy.test") + ":/proxy.test:ro",
                     "-v", str(fixtures) + ":/fixture:ro", "-v", str(reports) + ":/work/web/test-results:rw",
                     "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", "-e", "SSL_CERT_FILE=/fixture/server.crt", "-e", "VIBE_KEYCLOAK_PRODUCT_TEST=1",
                     "-w", "/work/internal/proxy", BROWSER, "sleep", "infinity"])
                phase = "Keycloak startup and real discovery"
                names.append(keycloak_name)
                run(["docker", "run", "-d", "--rm", "--pull=never", "--name", keycloak_name, "--network", "container:" + browser_name,
                     "--memory=1g", "-v", str(imports) + ":/opt/keycloak/data/import:ro", "-v", str(fixtures) + ":/fixture:ro",
                     KEYCLOAK, "start-dev", "--import-realm", "--http-enabled=false", "--hostname=" + "https://127.0.0.2:8443",
                     "--https-certificate-file=/fixture/server.crt", "--https-certificate-key-file=/fixture/server.key"])
                check = "const https=require('https'),fs=require('fs');const r=https.get('" + ISSUER + "/.well-known/openid-configuration',{ca:fs.readFileSync('/fixture/server.crt'),timeout:1500},res=>{res.resume();process.exitCode=res.statusCode===200?0:1});r.on('error',()=>{process.exitCode=1});r.on('timeout',()=>r.destroy());"
                for _ in range(90):
                    ready = subprocess.run(["docker", "exec", browser_name, "node", "-e", check], stdout=log, stderr=log)
                    if ready.returncode == 0: break
                    time.sleep(2)
                else: raise RuntimeError("Keycloak discovery did not become ready")
                print("Pinned Keycloak HTTPS discovery ready; no host ports or external runtime network", flush=True)
                phase = "real Keycloak browser and database verification"
                result = subprocess.run(["docker", "exec", browser_name, "/proxy.test", "-test.run=^TestKeycloakProductBrowserIntegration$", "-test.count=1", "-test.timeout=6m"], stdout=log, stderr=log)
                source = reports / "keycloak-live-summary.json"
                if source.exists():
                    summary = json.loads(source.read_text())
                    allowed = {f"KEYCLOAK-LIVE-{i:03d}" for i in range(1, 34)}
                    assert set(summary) == {"status", "tests"}
                    assert summary["status"] in {"passed", "failed", "timedout", "interrupted"}
                    assert len(summary["tests"]) == 33
                    assert {item["scenario"] for item in summary["tests"]} == allowed
                    for item in summary["tests"]:
                        assert set(item) <= {"scenario", "status", "durationMs", "lastSourceLine", "failureSourceLine"}
                        assert item["scenario"] in allowed
                        assert item["status"] in {"passed", "failed", "timedOut", "skipped", "interrupted"}
                        assert all(type(value) in (int, float) and 0 <= value <= 9007199254740991 for key, value in item.items() if key not in {"scenario", "status"})
                    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
                if result.returncode != 0: raise RuntimeError("Product checks failed; inspect only the sanitized summary")
                if not summary_path.exists(): raise RuntimeError("Product summary missing")
                assert summary["status"] == "passed" and all(item["status"] == "passed" for item in summary["tests"])
                print("Keycloak product browser and persisted provisioning checks passed", flush=True)
        except Exception:
            raise RuntimeError("Isolated Keycloak check failed during " + phase + "; raw credential-bearing output suppressed") from None
        finally:
            for name in reversed(names):
                subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
