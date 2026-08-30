"""Apply relay stack update (SG 80/443 + UserData caddy) and install caddy live via SSM."""

import sys
import time

import boto3

session = boto3.Session(profile_name="rdc-dev", region_name="ap-south-1")
cf = session.client("cloudformation")
ssm = session.client("ssm")

command = sys.argv[1] if len(sys.argv) > 1 else "all"

INSTANCE = "i-05dc8f42392f6bb38"

CADDY_INSTALL = r"""
set -e
if [ ! -x /usr/local/bin/caddy ]; then
  curl -sL -o /usr/local/bin/caddy "https://caddyserver.com/api/download?os=linux&arch=amd64"
  chmod +x /usr/local/bin/caddy
fi
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<'EOF'
ws.relay.bytical.ai {
  reverse_proxy 127.0.0.1:8443
}
EOF
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy TLS proxy for rdc relay
After=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now caddy
sleep 5
systemctl is-active caddy
/usr/local/bin/caddy version
"""

if command in ("sg", "all"):
    print("stack update deploys via GH workflow — this script only does SSM")

if command in ("caddy", "all"):
    result = ssm.send_command(
        InstanceIds=[INSTANCE],
        DocumentName="AWS-RunShellScript",
        Parameters={"commands": [CADDY_INSTALL]},
        Comment="install caddy TLS proxy",
    )
    command_id = result["Command"]["CommandId"]
    for _ in range(30):
        time.sleep(4)
        inv = ssm.get_command_invocation(CommandId=command_id, InstanceId=INSTANCE)
        if inv["Status"] in ("Success", "Failed", "Cancelled", "TimedOut"):
            print("status:", inv["Status"])
            print(inv["StandardOutputContent"][-600:])
            if inv["StandardErrorContent"]:
                print("stderr:", inv["StandardErrorContent"][-400:])
            break
    else:
        print("timed out waiting for SSM")
