import socket
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


class ReleaseWebTest(unittest.TestCase):
    def probe(self, health, page):
        attempts = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                attempts.append(self.path)
                if len(attempts) == 1:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(health if self.path == '/healthz' else page)

            def log_message(self, *args):
                pass

        with HTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                url = f'http://127.0.0.1:{server.server_port}'
                script = Path(__file__).resolve().parents[2] / 'scripts/check-release-web.sh'
                result = subprocess.run(['bash', script, url], capture_output=True, timeout=20)
            finally:
                server.shutdown()
                thread.join()
        return result.returncode, attempts

    def test_retries_startup_disconnect(self):
        code, paths = self.probe(b'{"status":"ok"}', b'<title>WeNote</title>')
        self.assertEqual((code, paths), (0, ['/healthz', '/healthz', '/']))

    def test_rejects_unhealthy_api_and_wrong_homepage(self):
        for health, page in [(b'{"status":"starting"}', b'<title>WeNote</title>'),
                             (b'{"status":"ok"}', b'<title>Other service</title>')]:
            with self.subTest(health=health):
                self.assertNotEqual(self.probe(health, page)[0], 0)


if __name__ == '__main__':
    unittest.main()
