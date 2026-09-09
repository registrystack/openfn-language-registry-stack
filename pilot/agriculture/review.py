#!/usr/bin/env python3
"""Inspect a synthetic correction, then explicitly approve or apply that snapshot."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import urllib.error
import uuid

ROOT=Path('/config/breg')
ORIGIN='http://127.0.0.1:8090'


def token():
    result=subprocess.run(['mint','token','--url','http://127.0.0.1:8091/token','--client-id','reviewer','--key',str(ROOT/'clients/reviewer/signing-p256-private-jwk')],capture_output=True,text=True)
    if result.returncode:
        raise RuntimeError('Reviewer authentication failed')
    return result.stdout.strip()


def request(path,bearer,method='GET',body=None,headers=None):
    req=urllib.request.Request(ORIGIN+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+bearer,'Accept':'application/json',**({'Content-Type':'application/json'} if body is not None else {}),**(headers or {})})
    try:
        with urllib.request.urlopen(req,timeout=10) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        problem=json.load(error)
        raise RuntimeError(f"Registry refused ({error.code}): {problem.get('code','unknown')}") from None


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['inspect','approve','apply'])
    parser.add_argument('request_id',type=uuid.UUID)
    args=parser.parse_args()
    os.umask(0o077)
    request_id=str(args.request_id)
    snapshot=ROOT/'review'/f'{request_id}.json'
    bearer=token()
    if args.action=='inspect':
        value=request(f'/v1/records/name-corrections/{request_id}?accessProfile=reviewer',bearer)
        snapshot.parent.mkdir(exist_ok=True,mode=0o700)
        snapshot.write_text(json.dumps(value,indent=2)+'\n'); snapshot.chmod(0o600)
        print(json.dumps(value,indent=2))
        print('Review the proposed values above. Approval and application are separate commands.')
        return
    if not snapshot.exists():
        raise RuntimeError('Inspect this correction first; no reviewed snapshot exists')
    value=json.loads(snapshot.read_text())
    actions=value['data']['request']['actions']
    operation={'approve':'approve_request','apply':'apply_request'}[args.action]
    selected=[action for action in actions if action['operation']==operation]
    if len(selected)!=1:
        raise RuntimeError('The inspected snapshot has no unique permitted action. Inspect current state first.')
    action=selected[0]
    suffix='/actions/stages/review/approve' if args.action=='approve' else '/actions/apply'
    expected=f'/v1/records/name-corrections/{request_id}'+suffix
    if action['href'].split('?')[0]!=expected or action['method']!='POST':
        raise RuntimeError('Unexpected action location; refusing to forward a reviewer credential')
    body={key:action[key] for key in ['proposalVersion','effectDigest']}
    key=f"reviewer:{request_id}:{operation}:{body['proposalVersion']}:{body['effectDigest']}"
    result=request(expected+'?accessProfile=reviewer',bearer,'POST',body,{'If-Match':action['ifMatch'],'Idempotency-Key':key})
    print(json.dumps(result,indent=2))
    print('Approval recorded; the farm is unchanged. Inspect again before applying.' if args.action=='approve' else 'The reviewed correction was applied.')


if __name__=='__main__':
    main()
