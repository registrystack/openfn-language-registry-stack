#!/usr/bin/env python3
"""Native direct-source proof against only the prepared synthetic pilot."""
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import urllib.error
import uuid

ROOT=Path('/config/breg')
WORK=ROOT/'smoke'


def command(*args,cwd=None):
    result=subprocess.run(list(map(str,args)),capture_output=True,text=True,cwd=cwd)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stderr[-2000:]}')
    return result.stdout


def token(client):
    return command('mint','token','--url','http://127.0.0.1:8091/token','--client-id',client,'--key',ROOT/f'clients/{client}/signing-p256-private-jwk').strip()


def request(method,path,bearer,body=None,headers=None):
    req=urllib.request.Request('http://127.0.0.1:8090'+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+bearer,'Accept':'application/json',**({'Content-Type':'application/json'} if body is not None else {}),**(headers or {})})
    try:
        with urllib.request.urlopen(req,timeout=15) as response:
            return response.status,dict(response.headers),json.load(response)
    except urllib.error.HTTPError as error:
        return error.code,dict(error.headers),json.load(error)


def save(path,body):
    path.write_text(json.dumps(body,indent=2)+'\n'); path.chmod(0o600)


def main():
    os.umask(0o077)
    WORK.mkdir(exist_ok=True,mode=0o700)
    service=token('openfn-service'); source=token('evidence-source')
    identifier='SYNTHETIC-DIRECT-SMOKE-001'
    status,_,found=request('POST','/v1/records/farms:lookup?accessProfile=openfn-service',service,{'selector':'by-local-identifier','values':{'localIdentifier':identifier}})
    if status==404 and found.get('code')=='lookup.unresolved':
        status,_,found=request('POST','/v1/records/farms?accessProfile=openfn-service',service,{'data':{'localIdentifier':identifier,'name':'SYNTHETIC-PRIVATE-NAME-CANARY'}}, {'Idempotency-Key':'synthetic-direct-smoke-create-v1'})
        assert status==201,(status,found)
        record=found['data']['recordIdentifier']
    else:
        assert status==200,(status,found.get('code'))
        record=found['data']['recordIdentifier']
    status,headers,_=request('GET',f'/v1/records/farms/{record}?accessProfile=openfn-service',service)
    assert status==200
    status,_,problem=request('PATCH',f'/v1/records/farms/{record}?accessProfile=openfn-service',service,{'name':'NEVER'}, {'Idempotency-Key':'synthetic-denied-patch-v1','If-Match':headers.get('ETag',headers.get('Etag',''))})
    assert status==404 and problem.get('code')=='resource.not_found',(status,problem.get('code'))
    status,_,problem=request('POST','/v1/records/farms?accessProfile=evidence-source',source,{'data':{'localIdentifier':'SYNTHETIC-DENIED','name':'NEVER'}}, {'Idempotency-Key':'synthetic-denied-create-v1'})
    assert status==404 and problem.get('code')=='resource.not_found',(status,problem.get('code'))
    status,_,found=request('POST','/v1/records/farms:lookup?accessProfile=evidence-source',source,{'selector':'by-local-identifier','values':{'localIdentifier':identifier}})
    assert status==200
    assert found['data']['domainData']=={'localIdentifier':identifier}
    # Exercise the documented reviewer commands on this separate synthetic record.
    status,_,before=request('GET',f'/v1/records/farms/{record}?accessProfile=openfn-service',service)
    before_name=before['data']['domainData']['name']
    correction_name='SYNTHETIC-CORRECTED-'+uuid.uuid4().hex[:12]
    status,_,draft=request('POST','/v1/records/name-corrections?accessProfile=openfn-service',service,{'data':{'record':record,'name':correction_name,'reason':'Synthetic reviewer command proof','supportingReference':'SYNTHETIC-SMOKE-SUPPORT'}},{'Idempotency-Key':'smoke-correction-'+uuid.uuid4().hex})
    assert status==201,(status,draft.get('code'))
    correction=draft['data']['recordIdentifier']
    status,_,draft=request('GET',f'/v1/records/name-corrections/{correction}?accessProfile=openfn-service',service)
    submit=next(a for a in draft['data']['request']['actions'] if a['operation']=='submit_request')
    status,_,submitted=request('POST',f'/v1/records/name-corrections/{correction}/actions/submit?accessProfile=openfn-service',service,{}, {'If-Match':submit['ifMatch'],'Idempotency-Key':'smoke-submit-'+correction})
    assert status==200,(status,submitted.get('code'))
    command('python3','/opt/pilot/agriculture/review.py','inspect',correction)
    reviewed=json.loads((ROOT/'review'/f'{correction}.json').read_text())
    approval=next(a for a in reviewed['data']['request']['actions'] if a['operation']=='approve_request')
    status,_,denied=request('POST',f'/v1/records/name-corrections/{correction}/actions/stages/review/approve?accessProfile=openfn-service',service,{key:approval[key] for key in ['proposalVersion','effectDigest']},{'If-Match':approval['ifMatch'],'Idempotency-Key':'smoke-denied-approve-'+correction})
    assert status==404 and denied.get('code')=='resource.not_found',(status,denied.get('code'))
    command('python3','/opt/pilot/agriculture/review.py','approve',correction)
    status,_,after_approval=request('GET',f'/v1/records/farms/{record}?accessProfile=openfn-service',service)
    assert after_approval['data']['domainData']['name']==before_name
    command('python3','/opt/pilot/agriculture/review.py','inspect',correction)
    command('python3','/opt/pilot/agriculture/review.py','apply',correction)
    status,_,after_apply=request('GET',f'/v1/records/farms/{record}?accessProfile=openfn-service',service)
    assert after_apply['data']['domainData']['name']==correction_name
    for suffix,value in [('registered',identifier),('missing','SYNTHETIC-DIRECT-SMOKE-MISSING')]:
        name=suffix+'-'+uuid.uuid4().hex[:12]
        inputs=WORK/(name+'-subjects.json')
        save(inputs,{'subjects':[{'role':'subject','field':'local-identifier','value':value}]})
        command('evidencectl','request','prepare','--profile','/config/evidence-client/profile.json','--requirement','holding-registered','--subjects-file',inputs,'--name',name,cwd=WORK)
        retained=WORK/'.evidence/requests'/name
        response=retained/'response.json'
        status=command('curl','--silent','--show-error','--config',retained/'curl.config','--output',response,'--write-out','%{http_code}',cwd=WORK)
        if suffix=='registered':
            assert status=='200',status
            command('evidencectl','verify',response,'--context',retained/'verification.json','--output',retained/'verified.json')
            verified=(retained/'verified.json').read_text()
            assert 'SYNTHETIC-PRIVATE-NAME-CANARY' not in verified and identifier not in verified
            assert 'urn:example:concept:holding-registered:registered' in verified
        else:
            problem=json.loads(response.read_text())
            assert problem.get('code')=='evidence.unavailable',(status,problem.get('code'))
    save(WORK/'report.json',{'serviceApprovalRefused':True,'directPatchRefused':True,'sourceCreateRefused':True,'sourceNameExcluded':True,'signedRegisteredVerified':True,'missingUnavailable':True,'approvalLeavesFarmUnchanged':True,'manualApplyChangesFarm':True})
    print('PASS: source/read-write ceilings, explicit review/application split, verified registered assertion, and missing unavailable.')


if __name__=='__main__':
    main()
