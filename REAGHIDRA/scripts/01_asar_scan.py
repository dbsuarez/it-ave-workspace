"""Bounded, read-only scan of Slack's app.asar: file layout plus term counts.

Reads the archive header and counts terms in file bodies. It does not extract
or print any source text.
"""
import collections
import json
import re
import struct
import sys

PATH = sys.argv[1]
TERMS = [
    "canvas", "canvases", "slackLists", "slack_list", "slack-list", "quip",
    "document_content", "rich_text", "conversations.canvases", "files.info",
    "app.slack.com", "webapp", "loadURL", "webview", "BrowserView", "WebContentsView",
    "slack-edge", "slack.com/ssb", "/client/", "boot_data",
]

with open(PATH, "rb") as f:
    f.read(4)
    (_hs,) = struct.unpack("<I", f.read(4))
    f.read(4)
    (js,) = struct.unpack("<I", f.read(4))
    header = json.loads(f.read(js))
    base = 8 + _hs

def walk(node, prefix=""):
    for name, entry in node.get("files", {}).items():
        path = f"{prefix}/{name}"
        if "files" in entry:
            yield from walk(entry, path)
        else:
            yield path, entry

files = list(walk(header))
packed = [(p, e) for p, e in files if not e.get("unpacked")]
print(f"files total={len(files)} packed={len(packed)} unpacked={len(files) - len(packed)}")
top = collections.Counter(p.split("/")[1] for p, _ in files)
print("top-level:", dict(top))
packages = collections.Counter()
for p, _ in files:
    parts = p.split("/")
    if len(parts) > 3 and parts[1] == "node_modules":
        packages[parts[2] + "/" + parts[3] if parts[2].startswith("@") else parts[2]] += 1
print("node_modules packages:", len(packages))
print("tinyspeck/slack-named:", sorted(k for k in packages if k.startswith("@tinyspeck") or "slack" in k.lower()))
print("non-node_modules files:", sorted(p for p, _ in files if not p.startswith("/node_modules/"))[:80])

counts = {t: {"app": 0, "node_modules": 0} for t in TERMS}
per_file = collections.defaultdict(list)
with open(PATH, "rb") as f:
    for p, e in packed:
        f.seek(base + int(e["offset"]))
        data = f.read(int(e["size"])).lower()
        bucket = "node_modules" if p.startswith("/node_modules/") else "app"
        for t in TERMS:
            n = len(re.findall(re.escape(t.lower()).encode(), data))
            if n:
                counts[t][bucket] += n
                if bucket == "app":
                    per_file[t].append((p, n))
for t in TERMS:
    print(f"{t:26s} app={counts[t]['app']:5d} node_modules={counts[t]['node_modules']:5d}")
for t in ("canvas", "canvases", "slackLists", "slack_list", "quip", "app.slack.com", "loadURL", "BrowserView", "WebContentsView"):
    if per_file.get(t):
        print(f"files with '{t}' (app code):", sorted(per_file[t], key=lambda x: -x[1])[:8])
