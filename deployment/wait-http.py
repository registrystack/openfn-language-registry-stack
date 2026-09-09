#!/usr/bin/env python3
"""Bounded readiness checks. Never print response bodies or credential headers."""
import sys
import time
import urllib.error
import urllib.request

url = sys.argv[1]
label = sys.argv[2]
timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 90
deadline = time.monotonic() + timeout
while time.monotonic() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            if response.status == 200:
                print(f'{label} ready.')
                sys.exit(0)
    except (urllib.error.URLError, TimeoutError, OSError):
        pass
    time.sleep(1)
print(f'{label} did not become ready within {timeout} seconds.', file=sys.stderr)
sys.exit(1)
