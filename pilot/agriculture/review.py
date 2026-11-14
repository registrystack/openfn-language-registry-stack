#!/usr/bin/env python3
"""Inspect and decide a native correction review, then explicitly apply approval."""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.request
import urllib.error
import urllib.parse
import uuid

ROOT = Path('/config/breg')
RUNTIME = Path('/workspace/pilot/agriculture/.runtime-0.45')
BREG = 'http://127.0.0.1:8090'
CASEWORK = 'http://127.0.0.1:8092'
CASEWORK_HEADERS = {'Registry-Casework-Profile': 'reviewer', 'Registry-Source-Profile': 'reviewer'}
REVIEW_CONTEXT = {
    'mode': 'current-source',
    'provider': 'agricultural-holdings',
    'contract': {
        'id': 'urn:registry:breg:review-context:agricultural-holdings:correct-farm-name:farm-name-context',
        'revision': 'sha256:54ec76f0558c42b3e698f3209fb1b8f53d0c9cc4e343edf7d98bbf757c0f2d2b',
        'schemaDigest': 'sha256:0bcdce5b1d3ae5d51328c3fb79d0c86f20b384bfc3cfa5b834bc681a11e7f4f0',
    },
}


def token():
    from issuer import token as issue_token
    return issue_token(RUNTIME, 'reviewer')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(origin, path, bearer, method='GET', body=None, headers=None):
    if origin not in [BREG, CASEWORK] or not path.startswith('/v1/') or path.startswith('//'):
        raise RuntimeError('Unexpected service location; credential was not forwarded')
    req = urllib.request.Request(origin + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + bearer, 'Accept': 'application/json',
            **({'Content-Type': 'application/json'} if body is not None else {}), **(headers or {})})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(req, timeout=10) as response:
            content = response.read()
            return json.loads(content) if content else None
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Service refused the reviewed action (HTTP {error.code})') from None
    except (OSError, urllib.error.URLError, ValueError):
        raise RuntimeError('Reviewed service exchange did not complete') from None


def proposal(proposal_id, bearer, profile='reviewer'):
    if profile not in ['reviewer', 'correction-applier']:
        raise RuntimeError('Unexpected BReg access profile')
    return request(BREG, f'/v1/proposals/{proposal_id}?accessProfile={profile}', bearer)


def casework(path, bearer, method='GET', body=None, headers=None):
    return request(CASEWORK, path, bearer, method, body, {**CASEWORK_HEADERS, **(headers or {})})


def save(path, value):
    path.parent.mkdir(exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def frozen(value):
    return value.get('id'), value.get('actionId'), value.get('submissionVersion'), value.get('effectDigest')


def subject_for(proposal_id, value):
    return {'source': 'agricultural-holdings', 'type': 'proposal', 'id': proposal_id,
        'version': str(value['submissionVersion']), 'digest': value['effectDigest']}


def validate_context(proposal_id, value, context):
    source = context.get('context', {})
    policy = context.get('policy', {})
    closure = context.get('policyClosure', {})
    expected_subject = subject_for(proposal_id, value)
    if (value.get('actionId') != 'correct-farm-name'
            or context.get('subject') != expected_subject
            or policy.get('id') != 'name-correction'
            or not isinstance(policy.get('version'), str)
            or not isinstance(policy.get('digest'), str)
            or closure.get('identity') != policy
            or closure.get('context') != REVIEW_CONTEXT
            or source.get('bindingStatus') != 'current'
            or not isinstance(source.get('reference'), str)
            or not source['reference']
            or source.get('projection', {}).get('binding') != expected_subject):
        raise RuntimeError('Casework context does not match the inspected current proposal')


def task_for(proposal_id, value, bearer):
    cursor = None
    seen = set()
    for _ in range(10):
        query = {'queue': 'corrections', 'limit': 100}
        if cursor:
            query['cursor'] = str(uuid.UUID(cursor))
        page = casework('/v1/review-tasks?' + urllib.parse.urlencode(query), bearer)
        expected = subject_for(proposal_id, value)
        matches = [item for item in page['items'] if item.get('subject') == expected]
        if len(matches) > 1:
            raise RuntimeError('Review task selection is ambiguous')
        if matches:
            return matches[0]
        cursor = page.get('nextCursor')
        if not cursor:
            return None
        if cursor in seen:
            raise RuntimeError('Casework repeated its task cursor')
        seen.add(cursor)
    raise RuntimeError('Review task selection exceeded its bounded page budget')


def inspect(proposal_id, bearer, timeout=90):
    end = time.monotonic() + timeout
    while True:
        value = proposal(proposal_id, bearer)
        refusal = value.get('handoffRefusal')
        if refusal:
            if isinstance(refusal, dict) and refusal.get('code') == 'review.initiator-required':
                raise RuntimeError('Casework policy requires a verified human initiator for this service-submitted correction')
            raise RuntimeError('Casework refused the submitted correction handoff')
        decision = (value.get('decision') or {}).get('status')
        if value.get('state') in ['applied', 'rejected', 'cancelled'] or decision in [
                'approved', 'rejected', 'changes-requested', 'answered']:
            return {'breg': value}
        if value.get('state') == 'submitted' and value.get('effectDigest'):
            task = task_for(proposal_id, value, bearer)
            if task and task['state'] != 'decided':
                task_id = str(uuid.UUID(task['taskId']))
                context = casework(f'/v1/review-tasks/{task_id}/context', bearer)
                validate_context(proposal_id, value, context)
                if (context.get('taskId') != task_id
                        or context.get('requestId') != task.get('requestId')):
                    raise RuntimeError('Casework task and context correlation changed')
                return {'breg': value, 'casework': {'task': task, 'context': context}}
        if time.monotonic() >= end:
            raise RuntimeError('The submitted correction has no available Casework review task')
        time.sleep(1)


def decision_body(decision, reason=None):
    if decision == 'approve':
        return {'decision': {'type': 'approve', 'outcome': 'approved'}}
    if decision not in ['reject', 'changes-requested']:
        raise RuntimeError('Unsupported Casework decision')
    if not isinstance(reason, str) or not reason.strip():
        raise RuntimeError('Reject and changes-requested decisions require a reason')
    return {'decision': {'type': decision, 'outcome': 'rejected' if decision == 'reject' else decision,
        'reason': reason, 'publicReason': reason}}


def decide(proposal_id, snapshot, bearer, decision, reason=None):
    value = proposal(proposal_id, bearer)
    if frozen(value) != frozen(snapshot['breg']):
        raise RuntimeError('The proposal changed after inspection; inspect current state first')
    current = (value.get('decision') or {}).get('status')
    expected = 'approved' if decision == 'approve' else ('rejected' if decision == 'reject' else decision)
    if current:
        if current == expected:
            return
        raise RuntimeError(f'The proposal already has a {current} decision')
    reviewed = snapshot.get('casework')
    if not reviewed:
        raise RuntimeError('Inspect this Casework review before deciding')
    task = reviewed['task']
    task_id = str(uuid.UUID(task['taskId']))
    path = f'/v1/review-tasks/{task_id}'
    context = casework(path + '/context', bearer)
    validate_context(proposal_id, value, context)
    if context != reviewed['context']:
        raise RuntimeError('The review context changed after inspection; inspect current state first')
    if task['state'] == 'open':
        claimed = casework(path + '/claim', bearer, 'POST', headers={
            'If-Match': f'"{task["revision"]}"', 'Idempotency-Key': f'reviewer:{task_id}:claim:{task["revision"]}'})
        task = claimed
        snapshot['casework']['task'] = task
        save(ROOT / 'review' / f'{proposal_id}.json', snapshot)
    elif not isinstance(task['state'], dict) or set(task['state']) != {'held'}:
        raise RuntimeError('The Casework task is not available for a decision')
    casework(path + '/decisions', bearer, 'POST', decision_body(decision, reason), {
        'If-Match': f'"{task["revision"]}"',
        'Idempotency-Key': f'reviewer:{task_id}:{decision}:{task["revision"]}'})


def approve(proposal_id, snapshot, bearer):
    decide(proposal_id, snapshot, bearer, 'approve')


def apply(proposal_id, snapshot, bearer):
    value = proposal(proposal_id, bearer, 'correction-applier')
    if frozen(value) != frozen(snapshot['breg']):
        raise RuntimeError('The proposal changed after inspection; inspect current state first')
    if value.get('state') == 'applied':
        return
    decision = (value.get('decision') or {}).get('status')
    if decision in ['rejected', 'changes-requested']:
        raise RuntimeError(f'The proposal decision is {decision}; it cannot be applied')
    if decision != 'approved':
        raise RuntimeError('BReg has not reconciled the approved review; inspect current state first')
    action = value.get('links', {}).get('apply')
    if not isinstance(action, dict):
        raise RuntimeError('The inspected snapshot has no unique permitted apply action')
    expected = f'/v1/proposals/{proposal_id}/apply'
    availability = action.get('availability', {})
    if (action.get('path') != expected or action.get('accessProfile') != 'correction-applier'
            or action.get('operation') != 'apply' or action.get('method') != 'POST'
            or availability.get('available') is not True or not isinstance(action.get('ifMatch'), str)):
        raise RuntimeError('Unexpected action location; credential was not forwarded')
    body = {key: value[key] for key in ['submissionVersion', 'effectDigest']}
    request(BREG, action['path'] + '?accessProfile=correction-applier', bearer, 'POST', body, {
        'If-Match': action['ifMatch'],
        'Idempotency-Key': f'applier:{proposal_id}:apply:{body["submissionVersion"]}:{body["effectDigest"]}'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['inspect', 'approve', 'reject', 'changes-requested', 'apply'])
    parser.add_argument('proposal_id', type=uuid.UUID)
    parser.add_argument('--reason')
    args = parser.parse_args()
    os.umask(0o077)
    proposal_id = str(args.proposal_id)
    path = ROOT / 'review' / f'{proposal_id}.json'
    bearer = token()
    if args.action == 'inspect':
        snapshot = inspect(proposal_id, bearer)
        save(path, snapshot)
        print(json.dumps(snapshot, indent=2))
        print('Review the proposal above. Casework approval and BReg application are separate commands.')
        return
    if not path.exists():
        raise RuntimeError('Inspect this correction first; no reviewed snapshot exists')
    snapshot = json.loads(path.read_text())
    if snapshot['breg'].get('id') != proposal_id:
        raise RuntimeError('The saved snapshot belongs to another correction')
    if args.action in ['approve', 'reject', 'changes-requested']:
        decide(proposal_id, snapshot, bearer, args.action, args.reason)
        if args.action == 'approve':
            print('Casework approval recorded; the farm is unchanged. Wait for BReg reconciliation and inspect again before applying.')
        else:
            print(f'Casework {args.action} decision recorded; the farm is unchanged.')
    else:
        apply(proposal_id, snapshot, bearer)
        print('The reviewed correction was applied.')


if __name__ == '__main__':
    main()
