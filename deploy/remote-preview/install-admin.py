#!/usr/bin/env python3
"""Install the optional private administration site alongside an existing mekiR preview service."""
import argparse
import grp
import os
from pathlib import Path
import pwd
import re
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import build_opener, ProxyHandler

HERE = Path(__file__).resolve().parent
CONFIG = Path('/etc/mekir-preview')
STATE = Path('/var/lib/mekir-preview-admin')
UNIT = 'mekir-preview.service'


def write(path, data, mode, gid=0):
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            os.fchmod(file.fileno(), mode)
            os.fchown(file.fileno(), 0, gid)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def check_origins(admin, data):
    def origin(text):
        if not re.fullmatch(r'https://[a-zA-Z0-9.\[\]:-]+', text):
            raise ValueError('Supply an HTTPS origin with no path, credentials or query.')
        url = urlsplit(text)
        if not url.hostname or url.port == 0:
            raise ValueError('Invalid hostname or port.')
        return url.hostname, url.port or 443
    if origin(admin) == origin(data):
        raise ValueError('Use different origins for the administration UI and published files.')


def ready():
    opener = build_opener(ProxyHandler({}))
    for _ in range(30):
        try:
            opener.open('http://127.0.0.1:17842/api', timeout=2).close()
        except HTTPError as error:
            if error.code == 401 and 'mekiR subscription administration' in error.headers.get('WWW-Authenticate', ''):
                return
        except URLError:
            pass
        time.sleep(.15)
    raise RuntimeError('The administration listener did not become ready.')


def install(admin_origin, admins):
    if os.geteuid():
        raise SystemExit('Run this installer as root on the preview server.')
    subprocess.run(['systemctl', 'is-active', '--quiet', UNIT], check=True)
    entries = (CONFIG / 'endpoint').read_text().splitlines()
    data_origin = next(s.split('=', 1)[1].strip().strip('"\'').rstrip('/') for s in entries if s.startswith('MEKIR_PREVIEW_ORIGIN='))
    check_origins(admin_origin, data_origin)
    service = pwd.getpwnam('mekir-preview')
    gid = grp.getgrnam('mekir-preview').gr_gid
    password_file = CONFIG / 'admin-users'
    if not password_file.exists():
        if not admins or not admins.is_file() or not admins.stat().st_size:
            raise SystemExit('Provide --admin-users with a dedicated htpasswd file for first installation.')
        write(password_file, admins.read_bytes(), 0o640, gid)
    if not password_file.is_file() or not password_file.stat().st_size:
        raise SystemExit('The dedicated administrator password file is missing or empty.')
    dropin = Path('/etc/systemd/system') / (UNIT + '.d')
    dropin.mkdir(mode=0o755, exist_ok=True)
    for path in [CONFIG / 'admin-ui', CONFIG / 'admin-api']:
        path.mkdir(mode=0o755, exist_ok=True)
    STATE.mkdir(mode=0o700, exist_ok=True)
    os.chown(STATE, service.pw_uid, gid)
    os.chmod(STATE, 0o700)
    files = {CONFIG / n: ((HERE / n).read_bytes(), 0o644) for n in
             ['httpd.conf', 'managed-access.conf', 'groups.py', 'admin_registry.py', 'admin.conf']}
    for name in ['index.html', 'admin.css', 'admin.js']:
        files[CONFIG / 'admin-ui' / name] = ((HERE / 'admin-ui' / name).read_bytes(), 0o644)
    files[CONFIG / 'admin-api' / 'registry.cgi'] = ((HERE / 'registry.cgi').read_bytes(), 0o755)
    files[CONFIG / 'admin-endpoint'] = (f'MEKIR_ADMIN_ORIGIN={admin_origin}\n'.encode(), 0o644)
    files[dropin / 'subscription-admin.conf'] = ((HERE / 'admin-service.conf').read_bytes(), 0o644)
    backup = {p: (p.read_bytes(), p.stat().st_mode & 0o777, p.stat().st_gid) if p.exists() else None for p in files}
    run_as_service = ['runuser', '-u', 'mekir-preview', '--']
    restarting = False
    try:
        for path, (data, mode) in files.items():
            write(path, data, mode)
        subprocess.run([*run_as_service, '/usr/bin/python3', '-B', CONFIG / 'admin_registry.py',
                        '--config', CONFIG / 'groups.json', '--users', CONFIG / 'users'], check=True)
        env = dict(os.environ, MEKIR_ADMIN_ORIGIN=admin_origin, MEKIR_PREVIEW_ORIGIN=data_origin)
        subprocess.run([*run_as_service, '/usr/sbin/apache2', '-t', '-f', CONFIG / 'httpd.conf'], env=env, check=True)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        restarting = True
        subprocess.run(['systemctl', 'restart', UNIT], check=True)
        ready()
    except BaseException:
        for path, old in backup.items():
            if old is None:
                path.unlink(missing_ok=True)
            else:
                write(path, *old)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        if restarting:
            subprocess.run(['systemctl', 'restart', UNIT], check=True)
        raise
    print(f'Administration listener ready on 127.0.0.1:17842 for {admin_origin}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--admin-users', type=Path, help='Dedicated htpasswd file, used only on first installation')
    args = parser.parse_args()
    install(args.origin.rstrip('/'), args.admin_users)
