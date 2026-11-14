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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def command(*args,cwd=None):
    result=subprocess.run(list(map(str,args)),capture_output=True,text=True,cwd=cwd)
    if result.returncode:
        raise RuntimeError(f'{Path(str(args[0])).name} failed; subprocess output was withheld')
    return result.stdout


def token(client):
    from issuer import token as issue_token
    return issue_token(Path('/workspace/pilot/agriculture/.runtime-0.45'), client)


def request(method,path,bearer,body=None,headers=None):
    req=urllib.request.Request('http://127.0.0.1:8090'+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+bearer,'Accept':'application/json',**({'Content-Type':'application/json'} if body is not None else {}),**(headers or {})})
    try:
        with OPENER.open(req,timeout=15) as response:
            return response.status,{key.lower():value for key,value in response.headers.items()},json.load(response)
    except urllib.error.HTTPError as error:
        return error.code,{key.lower():value for key,value in error.headers.items()},json.load(error)


def save(path,body):
    path.write_text(json.dumps(body,indent=2)+'\n'); path.chmod(0o600)


def main():
    os.umask(0o077)
    os.environ['SSL_CERT_FILE']='/config/evidence-client/pilot-ca.pem'
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
    status,_,problem=request('PATCH',f'/v1/records/farms/{record}?accessProfile=openfn-service',service,{'name':'NEVER'}, {'Idempotency-Key':'synthetic-denied-patch-v1','If-Match':headers['etag']})
    assert status==404 and problem.get('code')=='resource.not_found',(status,problem.get('code'))
    status,_,problem=request('POST','/v1/records/farms?accessProfile=evidence-source',source,{'data':{'localIdentifier':'SYNTHETIC-DENIED','name':'NEVER'}}, {'Idempotency-Key':'synthetic-denied-create-v1'})
    assert status==404 and problem.get('code')=='resource.not_found',(status,problem.get('code'))
    status,_,found=request('POST','/v1/records/farms:lookup?accessProfile=evidence-source',source,{'selector':'by-local-identifier','values':{'localIdentifier':identifier}})
    assert status==200
    assert found['data']['domainData']=={'localIdentifier':identifier}
    # Exercise the documented reviewer commands on a native BReg Proposal.
    status,_,before=request('GET',f'/v1/records/farms/{record}?accessProfile=openfn-service',service)
    before_name=before['data']['domainData']['name']
    correction_name='SYNTHETIC-CORRECTED-'+uuid.uuid4().hex[:12]
    proposal_key='smoke-correction-'+uuid.uuid4().hex
    status,_,draft=request('POST','/v1/actions/correct-farm-name/proposals?accessProfile=openfn-service',service,
        {'input':{'record':record,'name':correction_name,'reason':'Synthetic reviewer command proof',
            'supportingReference':'SYNTHETIC-SMOKE-SUPPORT'}},{'Idempotency-Key':proposal_key})
    assert status==201,(status,draft.get('code'))
    correction=draft['id']
    submit=draft.get('links',{}).get('submit',{})
    assert submit.get('path')==f'/v1/proposals/{correction}/submit'
    assert submit.get('accessProfile')=='openfn-service' and submit.get('operation')=='submit'
    status,_,submitted=request('POST',submit['path']+'?accessProfile=openfn-service',service,{},
        {'If-Match':submit['ifMatch'],'Idempotency-Key':'smoke-submit-'+correction})
    assert status==200,(status,submitted.get('code'))
    command('python3','/opt/pilot/agriculture/review.py','inspect',correction)
    reviewed=json.loads((ROOT/'review'/f'{correction}.json').read_text())
    task=reviewed['casework']['task']
    req=urllib.request.Request(f'http://127.0.0.1:8092/v1/review-tasks/{task["taskId"]}/decisions',
        method='POST',data=json.dumps({'decision':{'type':'approve','outcome':'approved'}}).encode(),headers={
            'Authorization':'Bearer '+service,'Content-Type':'application/json',
            'Registry-Casework-Profile':'reviewer','Registry-Source-Profile':'openfn-service',
            'If-Match':f'"{task["revision"]}"','Idempotency-Key':'smoke-denied-approve-'+correction})
    try:
        OPENER.open(req,timeout=15).close()
        raise AssertionError('The intake service unexpectedly gained human review authority')
    except urllib.error.HTTPError as error:
        assert error.code==401,error.code
    command('python3','/opt/pilot/agriculture/review.py','approve',correction)
    status,_,after_approval=request('GET',f'/v1/records/farms/{record}?accessProfile=openfn-service',service)
    assert after_approval['data']['domainData']['name']==before_name
    command('python3','/opt/pilot/agriculture/review.py','inspect',correction)
    command('python3','/opt/pilot/agriculture/review.py','apply',correction)
    status,_,after_apply=request('GET',f'/v1/records/farms/{record}?accessProfile=openfn-service',service)
    assert after_apply['data']['domainData']['name']==correction_name
    save(WORK/'report.json',{'serviceApprovalRefused':True,'directPatchRefused':True,'sourceCreateRefused':True,'sourceNameExcluded':True,'approvalLeavesFarmUnchanged':True,'manualApplyChangesFarm':True})
    print('PASS: source/read-write ceilings and explicit Casework review/BREG application split.')


if __name__=='__main__':
    main()
