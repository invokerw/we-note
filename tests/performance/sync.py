"""Measure native sync against a deterministic loopback manifest/change feed."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def measure(count):
    original = b'x' * 4096
    edited = b'y' * 4096
    original_hash = digest(original)
    files = [dict(file_id=f'f{i}', path=f'{i:05}.md', current_version_id='v1',
                  current_content_hash=original_hash, is_deleted=False) for i in range(count)]
    revision = count
    changes = []
    traffic = [0]
    expire = False

    class Fixture(BaseHTTPRequestHandler):
        def reply(self, data):
            body = data if isinstance(data, bytes) else json.dumps(data, separators=(',', ':')).encode()
            traffic[0] += len(body)
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.endswith('/manifest'):
                self.reply(dict(snapshot_revision=revision, files=files))
            elif self.path.endswith('/v2/content'):
                self.reply(edited)
            else:
                self.send_error(404)

        def do_POST(self):
            data = self.rfile.read(int(self.headers['Content-Length']))
            traffic[0] += len(data)
            if self.path.endswith('/devices'):
                self.reply(dict(id='device'))
            elif self.path.endswith('/changes'):
                if expire:
                    self.send_error(409)
                    return
                cursor = json.loads(data)['last_server_revision']
                self.reply(dict(mode='pull',vault_id='vault',device_id='device',from_revision=cursor,to_revision=revision,
                                has_more=False, changes=[c for c in changes if c['vault_revision'] > cursor]))
            else:
                self.send_error(404)

        def log_message(self, *args):
            pass

    with tempfile.TemporaryDirectory() as tmp, ThreadingHTTPServer(('127.0.0.1', 0), Fixture) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        notes = Path(tmp) / 'notes'
        notes.mkdir()
        for item in files:
            (notes / item['path']).write_bytes(original)
        env = dict(os.environ, WENOTE_BENCH_DIR=tmp, WENOTE_BENCH_ORIGIN=f'http://127.0.0.1:{server.server_port}')
        for phase in ['first', 'idle-1', 'idle-2', 'idle-3', 'one-change', 'expired-cursor']:
            expire = phase == 'expired-cursor'
            if phase == 'one-change':
                revision += 1
                files[0].update(current_version_id='v2', current_content_hash=digest(edited))
                changes.append(dict(file_id='f0',version_id='v2',operation='update_file_content',
                                    path=files[0]['path'],content_hash=digest(edited),vault_revision=revision))
            traffic[0] = 0
            run = subprocess.run(['cargo','test','--locked','-p','wenote-sync','--test','large_vault','--','--ignored','--nocapture'],
                                 env=env, text=True, stdout=subprocess.PIPE, check=True)
            print(count, phase, re.search(r'SYNC_MS=\d+ DOWNLOADS=\d+ SCAN_BODY_BYTES=\d+', run.stdout)[0],
                  f'HTTP_BODY_BYTES={traffic[0]}', flush=True)
            if phase.startswith("idle"):
                assert traffic[0] < 2048, "idle sync fetched the full manifest"
        assert (notes / files[0]['path']).read_bytes() == edited
        server.shutdown()


if __name__ == '__main__':
    for size in (map(int, sys.argv[1:]) if len(sys.argv) > 1 else (1000, 10000)):
        measure(size)
