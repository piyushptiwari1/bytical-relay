"""One-off: provision analytics backup timer on current relay instance + first backup."""

import time

import boto3

INSTANCE = "i-00cad017196ae0322"
BUCKET = "rdc-relay-artifacts-960862431428"

session = boto3.Session(profile_name="rdc-dev", region_name="ap-south-1")
cf = session.client("cloudformation")
ssm = session.client("ssm")

cf.validate_template(TemplateBody=open("infra/relay-stack.yml", encoding="utf-8").read())
print("TEMPLATE_VALID")

# chr(10) joins avoid heredoc-in-heredoc traps entirely
backup_sh = "\n".join(
    [
        "#!/bin/bash",
        "set -e",
        "[ -f /opt/rdc/analytics.db ] || exit 0",
        'sqlite3 /opt/rdc/analytics.db ".backup /tmp/analytics.db.bak"',
        f"aws s3 cp /tmp/analytics.db.bak s3://{BUCKET}/analytics.db.bak",
    ]
)
svc = "\n".join(
    [
        "[Unit]",
        "Description=backup rdc analytics db to s3",
        "",
        "[Service]",
        "Type=oneshot",
        "ExecStart=/usr/local/bin/rdc-analytics-backup.sh",
    ]
)
timer = "\n".join(
    [
        "[Unit]",
        "Description=periodic rdc analytics db backup",
        "",
        "[Timer]",
        "OnBootSec=15min",
        "OnUnitActiveSec=6h",
        "",
        "[Install]",
        "WantedBy=timers.target",
    ]
)


def b64(text: str) -> str:
    import base64

    return base64.b64encode(text.encode()).decode()


script = "\n".join(
    [
        "set -e",
        "dnf install -y sqlite >/dev/null 2>&1 || true",
        f"echo {b64(backup_sh)} | base64 -d > /usr/local/bin/rdc-analytics-backup.sh",
        "chmod +x /usr/local/bin/rdc-analytics-backup.sh",
        f"echo {b64(svc)} | base64 -d > /etc/systemd/system/rdc-analytics-backup.service",
        f"echo {b64(timer)} | base64 -d > /etc/systemd/system/rdc-analytics-backup.timer",
        "systemctl daemon-reload",
        "systemctl enable --now rdc-analytics-backup.timer",
        "/usr/local/bin/rdc-analytics-backup.sh && echo BACKUP_OK",
        "systemctl list-timers rdc-analytics-backup.timer --no-pager | head -3",
    ]
)

r = ssm.send_command(
    InstanceIds=[INSTANCE],
    DocumentName="AWS-RunShellScript",
    Parameters={"commands": [script]},
    Comment="provision analytics backup timer",
)
cid = r["Command"]["CommandId"]
for _ in range(20):
    time.sleep(4)
    out = ssm.get_command_invocation(CommandId=cid, InstanceId=INSTANCE)
    if out["Status"] in ("Success", "Failed", "Cancelled", "TimedOut"):
        print("status:", out["Status"])
        print(out["StandardOutputContent"][-700:])
        if out["StandardErrorContent"]:
            print("stderr:", out["StandardErrorContent"][-300:])
        break
else:
    print("timed out waiting for SSM")
