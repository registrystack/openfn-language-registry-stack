#!/usr/bin/env python3
"""Rehearse, package, and activate only the prepared synthetic Compose database.

Run inside the tools container after Mint and the new BREG database are ready.
A repeat verifies the retained package and does not seed or reset records.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path('/config/breg')


def run(binary, *args):
    result = subprocess.run([binary, *map(str,args)], capture_output=True, text=True)
    if result.returncode:
        # Product diagnostics exclude tokens and record values. Never print stdout,
        # since mint's success output contains an access token.
        detail = result.stderr if binary == 'mint' else result.stderr + result.stdout
        raise RuntimeError(f'{binary} {args[0]} failed: {detail[-5000:]}')
    return result.stdout


def save(path, value):
    temporary = path.with_name(path.name+'.tmp')
    temporary.write_text(value if isinstance(value,str) else json.dumps(value,indent=2)+'\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def main():
    os.umask(0o077)
    os.environ['SSL_CERT_FILE']=str(ROOT/'secrets/database-ca.pem')
    runtime=ROOT/'runtime.json'
    if (ROOT/'initialized.json').exists():
        run('bregctl','verify','--runtime-config',runtime)
        print('Retained agriculture package verified; records and credentials preserved.')
        return
    if not (ROOT/'schema-test-receipt.json').exists():
        clients=json.loads((ROOT/'registry/clients.yaml').read_text())['clients']
        for client in clients:
            token=run('mint','token','--url','http://127.0.0.1:8091/token','--client-id',client['id'],'--key',ROOT/f"clients/{client['id']}/signing-p256-private-jwk").strip()
            if token.count('.') != 2 or any(c.isspace() for c in token):
                raise RuntimeError('Mint returned an invalid token shape')
            for profile in client['accessProfiles']:
                save(ROOT/f'secrets/token-{profile}',token)
        report=run('bregctl','--format','json','test',ROOT/'registry','--runtime-config',ROOT/'test-runtime.json','--credentials',ROOT/'schema-test-credentials.json','--database-id','agriculture-pilot-db','--output',ROOT/'schema-test-receipt.json')
        save(ROOT/'test-report.json',report)
    if not (ROOT/'build/package').exists():
        if (ROOT/'build').exists():
            raise RuntimeError('Incomplete package build exists; inspect it before retrying. No files were removed.')
        report=run('bregctl','--format','json','package',ROOT/'registry','--database-id','agriculture-pilot-db','--test-receipt',ROOT/'schema-test-receipt.json','--output',ROOT/'build')
        save(ROOT/'package-report.json',report)
    revision=json.loads((ROOT/'package-report.json').read_text())['packageRevision']
    configuration=json.loads((ROOT/'runtime-template.json').read_text())
    configuration['package']['activeRevision']=revision
    save(runtime,configuration)
    # --initial is the maintained first activation flow. Never clear an interlock
    # or mutate the database with an improvised recovery command.
    run('bregctl','apply','--runtime-config',runtime,'--package',ROOT/'build/package','--initial')
    run('bregctl','verify','--runtime-config',runtime)
    save(ROOT/'initialized.json',{'packageRevision':revision})
    print('Agriculture schema journeys passed and the exact local package was activated.')


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        print(f'Initialization stopped: {error}',file=sys.stderr)
        sys.exit(1)
