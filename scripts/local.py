#!/usr/bin/env python3
"""Build and manage the local WeNote web app and API on macOS and Linux."""

import argparse
import errno
import fcntl
import hashlib
import http.client
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'apps/web'
API = ROOT / 'services/api'
RUN = ROOT / 'dist/local'
BINARY = RUN / 'wenote-api'
STATE = RUN / 'server.pid'
LOG = RUN / 'server.log'


def command(port):
    return [str(BINARY), '-addr', f'127.0.0.1:{port}', '-web-dir', str(WEB / 'dist')]


def running():
    if not STATE.exists():
        return None
    pid, port = map(int, STATE.read_text().split())
    if pid <= 1 or not 1 <= port <= 65535:
        raise ValueError(f'无效的进程记录：{STATE}')
    # A stale PID can belong to another process after a reboot.
    ps = subprocess.run(['ps', '-ww', '-p', str(pid), '-o', 'command='],
                        capture_output=True, text=True)
    if ps.stderr or ps.returncode not in (0, 1):
        raise RuntimeError(f'无法核对进程 {pid}：{ps.stderr.strip()}')
    if ps.stdout.strip() == ' '.join(command(port)):
        return pid, port
    STATE.unlink()
    return None


def build():
    lock = WEB / 'package-lock.json'
    stamp = WEB / 'node_modules/.wenote-lock'
    digest = hashlib.sha256(lock.read_bytes()).hexdigest()
    if not stamp.exists() or stamp.read_text() != digest:
        subprocess.run(['npm', 'ci', '--prefer-offline', '--no-audit', '--no-fund'], cwd=WEB, check=True)
        stamp.write_text(digest)
    subprocess.run(['npm', 'run', 'build'], cwd=WEB, check=True)
    subprocess.run(['go', 'build', '-mod=readonly', '-o', str(BINARY), './cmd/wenote-api'],
                   cwd=API, env={**os.environ, 'CGO_ENABLED': '1'}, check=True)


def healthy(port):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
    try:
        conn.request('GET', '/healthz')
        return conn.getresponse().status == 200
    except (OSError, http.client.HTTPException):
        return False
    finally:
        conn.close()


def start(port):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', port))
        except OSError as error:
            if error.errno == errno.EADDRINUSE:
                raise RuntimeError(f'端口 {port} 已被占用，请用 start --port 指定其他端口') from error
            raise
    build()
    with LOG.open('ab') as log:
        child = subprocess.Popen(command(port), cwd=API, start_new_session=True,
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
    try:
        pending = STATE.with_suffix('.tmp')
        pending.write_text(f'{child.pid} {port}\n')
        pending.replace(STATE)
        deadline = time.monotonic() + 15
        while child.poll() is None and time.monotonic() < deadline:
            if healthy(port) and child.poll() is None:
                print(f'已启动 http://localhost:{port}（PID {child.pid}）')
                return
            time.sleep(0.15)
        raise RuntimeError(f'服务未就绪，请查看 {LOG}')
    except BaseException:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=8)
        STATE.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    actions.add_parser('start').add_argument('--port', type=int, default=8080)
    actions.add_parser('stop')
    actions.add_parser('status')
    args = parser.parse_args()
    if args.action == 'start' and not 1 <= args.port <= 65535:
        parser.error('端口应在 1 到 65535 之间')

    RUN.mkdir(parents=True, exist_ok=True)
    with (RUN / 'control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        server = running()
        if args.action == 'start' and not server:
            start(args.port)
        elif not server:
            print('本地服务已停止')
        elif args.action == 'stop':
            pid, _ = server
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 8
            while running():
                if time.monotonic() >= deadline:
                    raise RuntimeError(f'服务仍在退出，请查看 {LOG}')
                time.sleep(0.1)
            print('本地服务已停止')
        else:
            pid, port = server
            print(f'运行中 http://localhost:{port}（PID {pid}）')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
