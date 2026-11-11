"""Count Slack-product terms in the native addons and in Slack.exe (read-only, chunked)."""
import os
import re
import sys

ROOT = sys.argv[1]
UNPACKED = os.path.join(ROOT, "app", "resources", "app.asar.unpacked", "node_modules")
EXE = os.path.join(ROOT, "app", "Slack.exe")
TERMS = [b"slackLists", b"slack_list", b"canvases", b"conversations.canvases", b"canvas.edit",
         b"document_content", b"files.info", b"app.slack.com", b"slack.com/api", b"tinyspeck"]

def scan(path):
    counts = {t.decode(): 0 for t in TERMS}
    tail = b""
    with open(path, "rb") as f:
        while True:
            chunk = f.read(8 * 1024 * 1024)
            if not chunk:
                break
            data = tail + chunk
            for t in TERMS:
                counts[t.decode()] += len(re.findall(re.escape(t), data))
            tail = data[-64:]
    return {k: v for k, v in counts.items() if v}

for dirpath, _dirs, files in os.walk(UNPACKED):
    for name in files:
        if name.endswith(".node"):
            p = os.path.join(dirpath, name)
            print(f"{name:34s} {os.path.getsize(p)//1024:6d} KB  hits={scan(p)}")
print(f"{'Slack.exe':34s} {os.path.getsize(EXE)//1048576:6d} MB  hits={scan(EXE)}")
