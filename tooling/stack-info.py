import sys

import boto3

session = boto3.Session(profile_name="rdc-dev", region_name="ap-south-1")
cf = session.client("cloudformation")
command = sys.argv[1] if len(sys.argv) > 1 else "events"

if command == "events":
    try:
        stack = cf.describe_stacks(StackName="rdc-relay")["Stacks"][0]
        print("state:", stack["StackStatus"])
        for e in cf.describe_stack_events(StackName="rdc-relay")["StackEvents"]:
            if "FAILED" in e.get("ResourceStatus", ""):
                print(e["LogicalResourceId"], "|", e.get("ResourceStatusReason", "")[:250])
    except Exception as err:
        print("no stack:", err)
elif command == "delete-if-rollback":
    state = cf.describe_stacks(StackName="rdc-relay")["Stacks"][0]["StackStatus"]
    print("state:", state)
    if state in ("ROLLBACK_COMPLETE", "CREATE_FAILED"):
        cf.delete_stack(StackName="rdc-relay")
        cf.get_waiter("stack_delete_complete").wait(StackName="rdc-relay")
        print("deleted")
elif command == "outputs":
    stack = cf.describe_stacks(StackName="rdc-relay")["Stacks"][0]
    print("state:", stack["StackStatus"])
    for o in stack.get("Outputs", []):
        print(o["OutputKey"], "=", o["OutputValue"])
