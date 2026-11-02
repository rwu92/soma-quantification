#!/usr/bin/env python3
"""Tiny local server for testing this static toolkit with its extensionless routes."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os
import re
import sys

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)

class ToolkitHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        translated = Path(super().translate_path(path))
        if translated.is_file() or translated.is_dir():
            return str(translated)
        # Production uses clean routes such as /figure-workshop. Resolve those
        # to the static .html page during local testing.
        if translated.suffix == "":
            html = translated.with_suffix(".html")
            if html.is_file():
                return str(html)
        return str(translated)

    def send_head(self):
        # Every build ships files with the same fixed date, so answering
        # If-Modified-Since with 304 made the browser keep pages from whichever
        # build it saw first (e.g. an Image Prep without the histogram).
        # Always send the file itself.
        for name in ("If-Modified-Since", "If-None-Match"):
            del self.headers[name]
        # Safari plays video only from a server that answers byte ranges (the
        # homepage previews); Cloudflare does, and so does this.
        self._range_left = None
        path = self.translate_path(self.path)
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", (self.headers.get("Range") or "").strip())
        if not (m and (m[1] or m[2]) and os.path.isfile(path)):
            return super().send_head()
        size = os.path.getsize(path)
        start, end = (int(m[1]), int(m[2]) if m[2] else size - 1) if m[1] else (max(0, size - int(m[2])), size - 1)
        end = min(end, size - 1)
        if start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._range_left = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        left = self._range_left
        if left is None:
            return super().copyfile(source, outputfile)
        while left > 0:
            chunk = source.read(min(1 << 16, left))
            if not chunk:
                break
            outputfile.write(chunk)
            left -= len(chunk)

    def end_headers(self):
        # Prevent stale local-test assets after swapping toolkit builds.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("127.0.0.1", port), ToolkitHandler)
    print(f"Toolkit test server: http://localhost:{port}")
    print("Press Control-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")

if __name__ == "__main__":
    main()
