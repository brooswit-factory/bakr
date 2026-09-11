import pexpect, sys, time, json, re

shortid = sys.argv[1]
message = sys.argv[2]

child = pexpect.spawn(f"claude attach {shortid}", timeout=30, encoding="utf-8", dimensions=(50,200))
child.logfile = sys.stdout
time.sleep(4)
child.send(message)
time.sleep(1)
child.send("\r")
# wait for it to finish thinking: poll for a while
time.sleep(20)
# detach with Ctrl+Z
child.sendcontrol('z')
time.sleep(2)
try:
    child.close(force=True)
except Exception as e:
    print("close error:", e)
print("DONE")
