"""Local static server for the dosimeter that disables browser caching.

`python3 -m http.server` only sends Last-Modified, so browsers may keep running
stale ES modules after an update. Here:

- every response carries `Cache-Control: no-store`, so nothing new is cached;
- HTML pages also carry `Clear-Site-Data: "cache"`, so opening the page wipes
  whatever an older server left in this origin's cache (localhost counts as a
  secure context, so Chrome honours it).

Usage: python3 scripts/dev-server.py [port] [--directory DIR]
"""

import argparse
import functools
import http.server
import pathlib


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        path = self.path.split("?", 1)[0]
        if path.endswith((".html", "/")):
            self.send_header("Clear-Site-Data", '"cache"')
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("port", nargs="?", type=int, default=8080)
    parser.add_argument("--directory", default=str(pathlib.Path(__file__).resolve().parent.parent))
    args = parser.parse_args()
    handler = functools.partial(NoCacheHandler, directory=args.directory)
    with http.server.ThreadingHTTPServer(("", args.port), handler) as server:
        print(f"Serving {args.directory} at http://localhost:{args.port}/public/index.html (no-store)")
        server.serve_forever()


if __name__ == "__main__":
    main()
