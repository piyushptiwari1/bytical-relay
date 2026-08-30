"""Poll an EAS build until it finishes. Usage: watch-eas-build.py <build_id>"""

import json
import os
import sys
import time
import urllib.request

build_id = sys.argv[1]
state = json.load(open(os.path.expanduser("~/.expo/state.json")))
secret = state["auth"]["sessionSecret"]

query = {
    "query": '{ builds { byId(buildId: "%s") { status artifacts { applicationArchiveUrl buildUrl } error { message } } } }'
    % build_id
}

for _ in range(80):
    req = urllib.request.Request(
        "https://api.expo.dev/graphql",
        data=json.dumps(query).encode(),
        headers={
            "content-type": "application/json",
            "expo-session": secret,
            "user-agent": "eas-cli",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.load(response)
        build = data["data"]["builds"]["byId"]
        status = build["status"]
        print(time.strftime("%H:%M:%S"), status, flush=True)
        if status in ("FINISHED", "ERRORED", "CANCELED"):
            artifacts = build.get("artifacts") or {}
            print("APK:", artifacts.get("applicationArchiveUrl") or artifacts.get("buildUrl"))
            if build.get("error"):
                print("error:", build["error"].get("message"))
            sys.exit(0 if status == "FINISHED" else 1)
    except Exception as error:  # noqa: BLE001 - keep polling through transient failures
        print("poll error:", error, flush=True)
    time.sleep(45)
print("timed out")
sys.exit(1)
