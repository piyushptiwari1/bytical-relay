import gzip
import json
import subprocess
import sys
import urllib.request
import zlib

build_id = sys.argv[1] if len(sys.argv) > 1 else "3c5556e8-73e9-4d24-abf9-32da7a7325f8"
view = subprocess.run(
    ["npx.cmd", "eas-cli", "build:view", build_id, "--json"],
    capture_output=True,
    text=True,
    cwd="apps/mobile",
)
info = json.loads(view.stdout)
url = info["logFiles"][0]
raw = urllib.request.urlopen(url).read()
try:
    data = gzip.decompress(raw).decode("utf8", "replace")
except Exception:
    try:
        data = zlib.decompress(raw, -zlib.MAX_WBITS).decode("utf8", "replace")
    except Exception:
        data = raw.decode("utf8", "replace")
open("eas.log", "w", encoding="utf8").write(data)
lines = data.splitlines()
hits = [i for i, l in enumerate(lines) if "What went wrong" in l or "FAILURE:" in l or "error:" in l.lower()]
print("total lines:", len(lines), "| failure markers:", len(hits))
for i in hits[:3]:
    print("\n".join(lines[max(0, i - 2) : i + 12]))
    print("-" * 60)
