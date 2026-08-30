"""Deploy rdc-analytics: upload bundle to S3, install systemd unit + caddy route via SSM."""

import subprocess
import sys
import time

import boto3

session = boto3.Session(profile_name="rdc-dev", region_name="ap-south-1")
ssm = session.client("ssm")
s3 = session.client("s3")

INSTANCE = "i-05dc8f42392f6bb38"
BUCKET = "rdc-relay-artifacts-960862431428"
token = sys.argv[1] if len(sys.argv) > 1 else ""
if len(token) < 16:
    print("usage: deploy-analytics.py <ANALYTICS_TOKEN>")
    sys.exit(1)

print("uploading bundle…")
s3.upload_file("apps/relay/dist/analytics.mjs", BUCKET, "analytics.mjs")

SCRIPT = f"""
set -e
aws s3 cp s3://{BUCKET}/analytics.mjs /opt/rdc/analytics.mjs
cat > /etc/rdc-analytics.env <<EOF
ANALYTICS_TOKEN={token}
ANALYTICS_PORT=8444
ANALYTICS_DB=/opt/rdc/analytics.db
EOF
chmod 600 /etc/rdc-analytics.env
cat > /etc/systemd/system/rdc-analytics.service <<'EOF'
[Unit]
Description=rdc-analytics first-party product analytics
After=network-online.target
StartLimitIntervalSec=0

[Service]
EnvironmentFile=/etc/rdc-analytics.env
ExecStart=/usr/bin/env node /opt/rdc/analytics.mjs
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/caddy/Caddyfile <<'EOF'
ws.relay.bytical.ai {{
  handle_path /a/* {{
    reverse_proxy 127.0.0.1:8444
  }}
  handle {{
    reverse_proxy 127.0.0.1:8443
  }}
}}
EOF
systemctl daemon-reload
systemctl enable --now rdc-analytics
systemctl restart caddy
sleep 4
systemctl is-active rdc-analytics caddy
curl -s http://127.0.0.1:8444/healthz
"""

result = ssm.send_command(
    InstanceIds=[INSTANCE],
    DocumentName="AWS-RunShellScript",
    Parameters={"commands": [SCRIPT]},
    Comment="deploy rdc-analytics + caddy route",
)
command_id = result["Command"]["CommandId"]
for _ in range(30):
    time.sleep(4)
    inv = ssm.get_command_invocation(CommandId=command_id, InstanceId=INSTANCE)
    if inv["Status"] in ("Success", "Failed", "Cancelled", "TimedOut"):
        print("status:", inv["Status"])
        print(inv["StandardOutputContent"][-500:])
        if inv["StandardErrorContent"]:
            print("stderr:", inv["StandardErrorContent"][-400:])
        break
else:
    print("timed out")
