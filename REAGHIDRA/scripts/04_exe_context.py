"""Print the printable context around the few Slack-term hits in Slack.exe."""
import re
import sys

EXE = sys.argv[1]
PATTERN = re.compile(rb"canvases|document_content")
CTX = 90
tail = b""
offset = 0
CHUNK = 8 * 1024 * 1024
with open(EXE, "rb") as f:
    while True:
        chunk = f.read(CHUNK)
        if not chunk:
            break
        data = tail + chunk
        base = offset - len(tail)
        for m in PATTERN.finditer(data):
            s = data[max(0, m.start() - CTX): m.end() + CTX]
            text = re.sub(rb"[^\x20-\x7e]", b".", s).decode()
            print(f"@{base + m.start():#x}: {text}")
        tail = data[-(CTX + 32):]
        offset += len(chunk)
