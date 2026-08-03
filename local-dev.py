#!/usr/bin/env python3
"""Run the v4.2.0 frontend and multiplayer backend locally."""
from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DOCS = ROOT / "docs"
HTTP_PORT = 8130
WS_PORT = 8131


class NoCacheHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(DOCS), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        if " 404 " in (format % args):
            super().log_message(format, *args)


def port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def main() -> None:
    for port in (HTTP_PORT, WS_PORT):
        if not port_available(port):
            raise SystemExit(
                f"Port {port} is already in use. Stop the prior game server with Control-C and try again."
            )

    env = os.environ.copy()
    env["PORT"] = str(WS_PORT)
    env.setdefault("WORLD_SEED", "4102026")
    env.setdefault("MAX_PLAYERS", "8")
    backend = subprocess.Popen([sys.executable, str(ROOT / "server" / "server.py")], env=env)

    try:
        frontend = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), NoCacheHandler)
    except Exception:
        backend.terminate()
        backend.wait(timeout=5)
        raise

    url = f"http://localhost:{HTTP_PORT}/?version=4.2.0&t={int(time.time())}"
    print("=" * 72)
    print("VOXEL MULTIPLAYER HILLS v4.2.0 — LOCAL DEVELOPMENT")
    print(f"Game: {url}")
    print(f"Backend health: http://localhost:{WS_PORT}/health")
    print("Open the game in another tab to test multiplayer.")
    print("Press Control-C to stop both servers.")
    print("=" * 72)

    threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        frontend.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping local servers…")
    finally:
        frontend.shutdown()
        frontend.server_close()
        if backend.poll() is None:
            if os.name == "nt":
                backend.terminate()
            else:
                backend.send_signal(signal.SIGTERM)
            try:
                backend.wait(timeout=5)
            except subprocess.TimeoutExpired:
                backend.kill()


if __name__ == "__main__":
    main()
