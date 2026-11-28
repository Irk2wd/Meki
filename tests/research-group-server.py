"""Exercise the shipping subscription policy against a private, throwaway Apache instance."""
import base64
import json
import os
from pathlib import Path
import pwd
import grp
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy' / 'remote-preview'


def check(tmp):
    root = tmp / 'projects'
    root.mkdir()
    projects = []
    for name in ('forest', 'trail', 'private'):
        (root / name).mkdir()
        (root / name / 'latest.json').write_text(json.dumps({'projectId': name}))
        projects.append({'id': name, 'title': name, 'directory': name, 'publishers': ['publisher']})
    projects.append({'id': 'upcoming', 'title': 'Upcoming', 'directory': 'upcoming', 'publishers': ['publisher']})
    (root / 'unlisted').mkdir()
    (root / 'unlisted' / 'latest.json').write_text('{}')
    accounts = ['reader', 'limited', 'outside', 'publisher']
    users = tmp / 'users'
    for user in accounts:
        cmd = ['htpasswd', '-iB'] + ([] if users.exists() else ['-c']) + [str(users), user]
        subprocess.run(cmd, input='local-test\n', text=True, capture_output=True, check=True)
    policy = {'library': {'id': 'lib', 'title': 'Library'}, 'projects': projects,
              'groups': [{'id': 'render', 'title': 'Render', 'projects': ['forest', 'trail'], 'members': ['reader']},
                         {'id': 'shared', 'title': 'Shared', 'projects': ['forest'], 'members': ['limited', 'reader']},
                         {'id': 'lab', 'title': 'Private', 'projects': ['private'], 'members': ['publisher']}]}
    config = tmp / 'groups.json'
    config.write_text(json.dumps(policy))
    output = tmp / 'policy'
    compile_cmd = [sys.executable, str(DEPLOY / 'groups.py'), '--config', str(config), '--users', str(users),
                   '--root', str(root), '--output', str(output)]
    subprocess.run(compile_cmd, check=True)
    generation = (output / 'current').resolve()
    policy['groups'][0]['members'].append('unknown')
    config.write_text(json.dumps(policy))
    assert subprocess.run(compile_cmd, capture_output=True).returncode and (output / 'current').resolve() == generation

    mac = sys.platform == 'darwin'
    httpd = shutil.which('httpd') if mac else shutil.which('apache2')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = 'http://127.0.0.1:' + str(port)
    conf = (DEPLOY / 'httpd.conf').read_text().replace('${MEKIR_PREVIEW_ORIGIN}', base).replace('127.0.0.1:17841', '127.0.0.1:' + str(port))
    conf = conf.replace('/etc/mekir-preview', str(tmp)).replace('/run/mekir-preview', str(tmp)).replace('/srv/mekir-previews', str(root))
    conf = conf.replace('syslog:local6', str(tmp / 'errors.log'))
    if mac:
        conf = conf.replace('/usr/lib/apache2/modules/', '/usr/libexec/apache2/')
        conf += '\nLoadModule unixd_module /usr/libexec/apache2/mod_unixd.so\n'
    if os.geteuid():
        conf += f'\nUser {pwd.getpwuid(os.getuid()).pw_name}\nGroup {grp.getgrgid(os.getgid()).gr_name}\n'
    file = tmp / 'httpd.conf'
    file.write_text(conf)
    subprocess.run([httpd, '-t', '-f', file], check=True)
    proc = subprocess.Popen([httpd, '-f', file, '-DFOREGROUND'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(100):
            if proc.poll() is not None:
                raise RuntimeError(proc.stderr.read().decode() + (tmp / 'errors.log').read_text())
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.2):
                    break
            except OSError:
                time.sleep(.03)

        def request(user, resource, expected, method='GET'):
            headers = {'Authorization': 'Basic ' + base64.b64encode((user + ':local-test').encode()).decode()} if user else {}
            req = urllib.request.Request(base + resource, headers=headers, method=method, data=b'test' if method == 'PUT' else None)
            try:
                with urllib.request.urlopen(req, timeout=4) as response:
                    code, body = response.status, response.read()
            except urllib.error.HTTPError as e:
                code, body = e.code, e.read()
            assert code == expected, (user, resource, method, code, expected)
            return body

        for user, visible in [('reader', ['forest', 'trail']), ('limited', ['forest']), ('outside', [])]:
            catalog = json.loads(request(user, f'/_mekir/accounts/{user}.json', 200))
            assert [p['id'] for p in catalog['projects']] == visible
        request(None, '/forest/latest.json', 401)
        request('reader', '/_mekir/accounts/limited.json', 403)
        request('outside', '/forest/latest.json', 403)
        request('limited', '/trail/latest.json', 403)
        request('limited', '/forest/latest.json', 200)
        request('reader', '/trail/latest.json', 200)
        request('reader', '/private/latest.json', 403)
        request('publisher', '/unlisted/latest.json', 403)
        request('reader', '/forest/sample.txt', 403, 'PUT')
        request('publisher', '/forest/sample.txt', 201, 'PUT')
        request('reader', '/forest/sample.txt', 200)
        request('publisher', '/upcoming/latest.json', 404)
        request('publisher', '/upcoming/', 405, 'MKCOL')
        request('publisher', '/upcoming/snapshots/', 201, 'MKCOL')
        request('publisher', '/_mekir/accounts/publisher.json', 403, 'PUT')
        print('Apache served per-user group lists and enforced project reads and publisher writes.')
    finally:
        proc.terminate()
        proc.wait(timeout=8)


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='mekir-group-httpd-') as directory:
        check(Path(directory).resolve())
