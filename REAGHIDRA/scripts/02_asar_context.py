"""Bounded context sampler: unique short windows around a few terms in two files."""
import collections
import json
import re
import struct
import sys

PATH = sys.argv[1]
with open(PATH, "rb") as f:
    f.read(4)
    (hs,) = struct.unpack("<I", f.read(4))
    f.read(4)
    (js,) = struct.unpack("<I", f.read(4))
    header = json.loads(f.read(js))
    base = 8 + hs

def entry(path):
    node = header
    for part in path.strip("/").split("/"):
        node = node["files"][part]
    return node

def body(path):
    e = entry(path)
    with open(PATH, "rb") as f:
        f.seek(base + int(e["offset"]))
        return f.read(int(e["size"])).decode("utf-8", "replace")

def windows(text, pattern, before=18, after=26, limit=14):
    seen = collections.Counter()
    for m in re.finditer(pattern, text, re.I):
        s = text[max(0, m.start() - before): m.end() + after].replace("\n", " ")
        seen[s] += 1
    return seen.most_common(limit)

pre = body("/dist/preload.bundle.js")
print("== preload.bundle.js size", len(pre))
print("'canvas' as part of identifiers:")
ident = collections.Counter(m.group(0) for m in re.finditer(r"[A-Za-z_.$]*canvas[A-Za-z_.$]*", pre, re.I))
for k, v in ident.most_common(25):
    print(f"  {v:4d}  {k}")

main = body("/dist/main.bundle.cjs")
print("\n== main.bundle.cjs size", len(main))
print("'canvas' contexts:")
for s, n in windows(main, r"canvas", 40, 60):
    print(f"  {n}x  {s}")
print("\nhosts mentioned (domains only):")
hosts = collections.Counter(re.findall(r"https?://([A-Za-z0-9.\-*{}$]+\.[a-z]{2,})", main))
for k, v in hosts.most_common(25):
    print(f"  {v:3d}  {k}")
print("\nloadURL argument shapes:")
for s, n in windows(main, r"loadURL\(", 4, 70, 12):
    print(f"  {n}x  {s}")
print("\n'webapp' identifier shapes in main:")
w = collections.Counter(m.group(0) for m in re.finditer(r"[A-Za-z_.$]*webapp[A-Za-z_.$]*", main, re.I))
for k, v in w.most_common(12):
    print(f"  {v:4d}  {k}")
