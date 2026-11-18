"""Local static server for the dosimeter that disables browser caching.

`python3 -m http.server` only sends Last-Modified, so browsers may keep running
stale ES modules after an update. Here:

- every response carries `Cache-Control: no-store`, so nothing new is cached;
- HTML pages also carry `Clear-Site-Data: "cache"`, so opening the page wipes
  whatever an older server left in this origin's cache (localhost counts as a
  secure context, so Chrome honours it);
- only the app is served: `/` redirects to the app, files under `/public/` and
  `/src/` are allowed, and everything else (including `.git/`, `.claude/` and
  directory listings) answers 404. This matters when the port is shared through
  a tunnel, where anyone with the link could otherwise read the repository.

Usage: python3 scripts/dev-server.py [port] [--directory DIR]
"""

import argparse
import functools
import http.server
import pathlib
import posixpath
import urllib.parse

APP_PATH = "/public/index.html"
ALLOWED_PREFIXES = ("/public/", "/src/")


def is_allowed(raw_path):
    """True for files of the app; the path is decoded and normalized first."""
    path = posixpath.normpath(urllib.parse.unquote(raw_path.split("?", 1)[0].split("#", 1)[0]))
    if any(part.startswith(".") for part in path.split("/") if part):
        return False
    return path.startswith(ALLOWED_PREFIXES) and not path.endswith("/")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] in ("/", "/public", "/public/"):
            # Explicit empty body: without Content-Length a proxy (such as a dev tunnel)
            # may keep waiting for a body and never forward the redirect.
            self._redirecting = True
            self.send_response(302)
            self.send_header("Location", APP_PATH)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not is_allowed(self.path):
            self.send_error(404, "Not found")
            return
        super().do_GET()

    def do_HEAD(self):
        if not is_allowed(self.path):
            self.send_error(404, "Not found")
            return
        super().do_HEAD()

    def list_directory(self, path):
        self.send_error(404, "Not found")
        return None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        path = self.path.split("?", 1)[0]
        if path.endswith(".html") and not getattr(self, "_redirecting", False):
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
