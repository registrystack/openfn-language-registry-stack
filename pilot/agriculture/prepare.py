#!/usr/bin/env python3
"""Prepare a new, private synthetic deployment. Never connects to a database."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import yaml

HERE = Path(__file__).resolve().parent
PROFILE = 'breg-8-registry-4-farm-19-by-local-identifier'
REQUIREMENT = 'urn:example:requirement:holding-registered:v1'


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('x', encoding='utf-8') as handle:
        handle.write(value if isinstance(value, str) else json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def run(binary, *args):
    result = subprocess.run([str(binary), *map(str, args)], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'{Path(binary).name} {args[0]} failed: {result.stderr[-3000:]}')
    return result.stdout


def prepare(root, bins):
    if root.exists():
        raise SystemExit('Output exists. Reuse the retained runtime, or choose a new --output directory.')
    for name in ['bregctl','evidencectl','evidence','mint']:
        if run(bins/name,'--version').split()[-1] != '0.27.0':
            raise SystemExit('This pilot requires matching Registry Stack 0.27.0 binaries.')
    os.umask(0o077)
    root.mkdir(parents=True, mode=0o700)
    bregctl, evidencectl = bins/'bregctl', bins/'evidencectl'
    os.environ['EVIDENCE_BIN'] = str(bins/'evidence')
    for name in ['breg', 'mint', 'bridge', 'evidence', 'evidence-client', 'openfn', 'breg-db']:
        (root/name).mkdir(mode=0o700)
    breg = root/'breg'
    shutil.copytree(HERE/'registry', breg/'registry')
    clients = json.loads((HERE/'registry/clients.yaml').read_text())['clients']
    mint_keys = root/'mint/keys'
    run(evidencectl, 'keygen', 'signing', '--output-dir', mint_keys)
    mint_public = json.loads((mint_keys/'signing-p256-public.jwk.json').read_text())
    mint_kid = mint_public['kid']
    run(evidencectl, 'keygen', 'secret', '--output', mint_keys/'audit-hmac-key')
    write(root/f'mint/public-keys/{mint_kid}.jwk.json', mint_public)
    for client in clients + [{'id':'openfn-evidence','scopes':['evidence:request'],'claims':{'evidence_tags':['holding-verifier'],'evidence_audience':'urn:example:audience:openfn-pilot'}}]:
        ident = client['id']
        key_dir = breg/f'clients/{ident}' if ident != 'openfn-evidence' else root/'evidence-client/keys'
        run(evidencectl, 'keygen', 'signing', '--output-dir', key_dir)
        public = json.loads((key_dir/'signing-p256-public.jwk.json').read_text())
        write(root/f'mint/clients/{ident}.yaml', {'clientId':ident,'principal':f'urn:example:pilot:{ident}','authorization':{'scopes':client['scopes'],'claims':client['claims']},'keys':[public]})
    write(root/'mint/mint.json', {'version':1,'validationMode':'supervised-local-development','issuer':'http://127.0.0.1:8091','listener':{'address':'127.0.0.1','port':8091},'signing':{'algorithm':'ES256','activePublicJwkFile':f'public-keys/{mint_kid}.jwk.json','publishedPublicJwkFiles':[],'revokedKeyIds':[]},'signer':{'kind':'local-jwk','privateKeyRef':'secret:file/signing-p256-private-jwk'},'secretProviders':{'file':{'root':'/config/mint/keys'}},'audit':{'path':'/var/lib/mint/mint.jsonl','maximumFileBytes':10485760,'hashKeyRef':'secret:file/audit-hmac-key','hashKeyVersion':1},'accessTokens':{'audiences':['urn:example:audience:agriculture-pilot'],'lifetimeSeconds':300},'clientAssertion':{'audience':'http://127.0.0.1:8091/token','maximumLifetimeSeconds':120,'algorithms':['ES256']},'clients':{'directory':'clients'}})
    for name in ['audit-key','cursor-key','webhook-key']:
        write(breg/f'secrets/{name}', secrets.token_hex(32))
    write(breg/'secrets/mint-jwks', {'keys':[mint_public]})
    password = secrets.token_hex(24)
    write(root/'breg-db/password', password)
    write(root/'breg-db/postgres.env', f'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB=postgres\n')
    for mode,database in [('', 'agriculture'),('test-', 'agriculture_test')]:
        for role in ['runtime','migration']:
            write(breg/f'secrets/{mode}{role}-database-url', f'postgresql://agriculture_{role}:{password}@breg-db:5432/{database}')
    sql = ''.join(f"CREATE ROLE agriculture_{role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '{password}';\n" for role in ['runtime','migration'])
    for db in ['agriculture', 'agriculture_test']:
        sql += f'CREATE DATABASE {db};\n\\connect {db}\nCREATE EXTENSION IF NOT EXISTS btree_gist;\nREVOKE ALL ON DATABASE {db} FROM PUBLIC;\nGRANT CONNECT ON DATABASE {db} TO agriculture_runtime, agriculture_migration;\n'
        for schema in ['registry_internal','registry_data','registry_source','registry_derived','registry_context']:
            sql += f'CREATE SCHEMA {schema} AUTHORIZATION agriculture_migration;\nREVOKE ALL ON SCHEMA {schema} FROM PUBLIC;\n'
    write(root/'breg-db/bootstrap.sql', sql)
    run('openssl','req','-x509','-new','-nodes','-newkey','rsa:2048','-sha256','-days','30','-subj','/CN=Synthetic agriculture pilot CA','-keyout',root/'breg-db/ca.key','-out',root/'breg-db/ca.pem')
    run('openssl','req','-new','-nodes','-newkey','rsa:2048','-subj','/CN=breg-db','-keyout',root/'breg-db/server.key','-out',root/'breg-db/server.csr')
    write(root/'breg-db/server.ext','subjectAltName=DNS:breg-db\n')
    run('openssl','x509','-req','-sha256','-days','30','-in',root/'breg-db/server.csr','-CA',root/'breg-db/ca.pem','-CAkey',root/'breg-db/ca.key','-CAcreateserial','-extfile',root/'breg-db/server.ext','-out',root/'breg-db/server.crt')
    shutil.copyfile(root/'breg-db/ca.pem',breg/'secrets/database-ca.pem')
    runtime = {'apiVersion':'registry.registrystack.org/breg-runtime/v1alpha1','kind':'BRegRuntimeConfig','listener':{'bind':'0.0.0.0:8090'},'identity':{'environment':'local','instanceId':'agriculture-openfn-pilot','databaseId':'agriculture-pilot-db','databaseInitializationEnvironment':'local'},'secretProviders':{'file':{'root':'/config/breg/secrets'}},'database':{'runtimeUrlRef':'secret:file/runtime-database-url','migrationUrlRef':'secret:file/migration-database-url','pool':{'maxSize':4},'roles':{'migration':'agriculture_migration','runtime':'agriculture_runtime'}},'package':{'root':'/config/breg/build/package','trustAnchorPath':'/config/breg/trust-anchor.json','compilerSourceRevision':'agriculture-openfn-pilot-v1','activeRevision':'sha256:'+'1'*64,'activeSequence':1},'authentication':{'oidc':{'issuer':'http://127.0.0.1:8091','audience':'urn:example:audience:agriculture-pilot','allowedAlgorithm':'ES256','accessTokenType':'at+jwt','scopeClaim':'scope','scopeSeparator':' ','allowedClients':[c['id'] for c in clients],'deniedKids':[],'maxTokenLifetimeSeconds':300,'leewayMilliseconds':30000,'jwksSource':{'kind':'static','documentRef':'secret:file/mint-jwks'}},'authorityClaims':{'principal':'registry_principal','purpose':'registry_purpose'}},'audit':{'hashKeyRef':'secret:file/audit-key'},'cursor':{'secretRef':'secret:file/cursor-key'},'eventDestinations':{'openfn':{'origin':'http://127.0.0.1:8081','path':'/events/breg','networkProfile':'loopbackDevelopmentHttp','dnsFamily':'dualStackStrict','allowedPrivateCidrs':[],'hmacSha256KeyRef':'secret:file/webhook-key','classificationCeiling':'restricted','deliveryCeilings':{'attemptTimeoutMilliseconds':5000,'maximumAttempts':5}}},'eventDelivery':{'payloadRetentionDays':1}}
    write(breg/'runtime-template.json', runtime)
    test = json.loads(json.dumps(runtime)); test['database'].update(runtimeUrlRef='secret:file/test-runtime-database-url',migrationUrlRef='secret:file/test-migration-database-url'); test['package']['root']='/config/breg/empty-package'
    (breg/'empty-package').mkdir()
    write(breg/'test-runtime.json',test); write(breg/'trust-anchor.json',{})
    bindings=[]
    journeys=json.loads((breg/'registry/tests/journeys.yaml').read_text())
    for journey in journeys['journeys']:
        for step in journey['steps']:
            bindings.append({'journeyId':journey['id'],'stepId':step['id'],'credential':{'type':'bearer','tokenRef':'secret:file/token-'+step['accessProfile']}})
    write(breg/'schema-test-credentials.json',{'apiVersion':'registry.registrystack.org/breg-schema-test-credentials/v1','kind':'SchemaTestCredentials','bindings':bindings})
    write(root/'bridge/breg-hmac-key',(breg/'secrets/webhook-key').read_text())
    events={}
    for event in ['farm-created-v1','farm-patched-v1']:
        sample=json.loads(run(bregctl,'webhook','sample',breg/'registry','--event',event,'--format','json'))
        events[event]={'schema':sample['request']['headers']['ce-dataschema'],'trigger':sample['request']['body']['trigger']}
    write(root/'bridge/expected-events.json',events); write(root/'bridge/allowed-value-fields.json',['local-identifier'])
    write(root/'bridge/expected-source','urn:registrystack:registry:agricultural-holdings:instance:agriculture-openfn-pilot')
    evidence=root/'evidence'; project=evidence/'project'
    run(evidencectl,'new',project,'--starter',HERE/'evidence-starter','--profile','local')
    settings=json.loads((HERE/'evidence-starter/targets/local/settings.yaml').read_text())
    settings['runtime']['bundleDirectory']=str(evidence/'candidate/bundle'); settings['runtime']['secretProviders']['file']['root']=str(project/'secrets'); settings['runtime']['auditStorage']['path']='/var/lib/evidence/evidence.jsonl'
    write(evidence/'settings.json',settings)
    run(evidencectl,'target','new',evidence/'target','--settings',evidence/'settings.json','--signing-public-key',project/'secrets/signing-p256-public.jwk.json')
    run(bregctl,'generate','evidence-source',breg/'registry','--access-profile','evidence-source','--entity','farm','--selector','by-local-identifier','--fields','local-identifier','--source-id','holding-register','--connection','registry','--output',evidence/'source-export')
    run(evidencectl,'source','import',evidence/'source-export','--project',project,'--target',evidence/'target')
    fixture_report=run(evidencectl,'fixtures','run','--project',project,'--target',evidence/'target','--json'); write(evidence/'fixture-report.json',fixture_report)
    run(evidencectl,'build','--project',project,'--target',evidence/'target','--output',evidence/'candidate')
    runtime_path=evidence/'candidate/runtime.yaml'; ev_runtime=yaml.safe_load(runtime_path.read_text()); ev_runtime['bundleDirectory']='/config/evidence/candidate/bundle'; ev_runtime['secretProviders']['file']['root']='/config/evidence/project/secrets'; write(evidence/'runtime.yaml',ev_runtime)
    (evidence/'runtime.yaml').chmod(0o400)
    write(project/'secrets/registry-client-id','evidence-source')
    write(project/'secrets/registry-client-key',(breg/'clients/evidence-source/signing-p256-private-jwk').read_text())
    run(evidencectl,'client','profile','create','--base-url','http://127.0.0.1:8080','--client-id','openfn-evidence','--private-key-file','keys/signing-p256-private-jwk','--local-loopback-discovery','--expected-audience','urn:example:audience:openfn-pilot','--output',root/'evidence-client/profile.json')
    key=json.loads((breg/'clients/openfn-service/signing-p256-private-jwk').read_text())
    breg_credential={'breg':{'baseUrl':'http://127.0.0.1:8090','authorization':{'privateKeyJwt':{'tokenEndpoint':'http://127.0.0.1:8091/token','clientId':'openfn-service','clientKey':key}}}}
    write(root/'openfn/breg-credential.json',breg_credential)
    write(root/'openfn/evidence-credential.json',{'evidence':{'profilePath':'/config/evidence-client/profile.json'}})
    write(root/'workflow-bindings.json',{'breg':{'accessProfile':'openfn-service','farmEntity':'farm','farmCreateOperation':'records.farm.create','selector':'by-local-identifier','correctionEntity':'name-correction','correctionCreateOperation':'records.name-correction.create','correctionSubmitOperation':'records.name-correction.request.submit'},'evidence':{'requirement':'holding-registered','requirementId':REQUIREMENT,'selectorProfile':PROFILE,'purpose':'holding-verification','registeredConcept':'urn:example:concept:holding-registered:registered'}})
    write(root/'prepared.json',{'schema':'synthetic-agriculture-pilot/v1','version':'0.27.0','fixtures':8})
    print('Prepared isolated synthetic configuration, source export and 8 passing Evidence fixtures.')


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir',type=Path,required=True)
    parser.add_argument('--output',type=Path,default=HERE/'.runtime')
    args=parser.parse_args()
    prepare(args.output.resolve(),args.bin_dir.resolve())
