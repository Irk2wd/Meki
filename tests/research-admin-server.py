"""Exercise the web administration API and the existing subscription client routes with real Apache."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import grp
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import build_opener, ProxyHandler, Request

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy' / 'remote-preview'
sys.path.insert(0, str(DEPLOY))
from admin_registry import Registry

TEST_PASSWORD = 'test-only-password'
opener = build_opener(ProxyHandler({}))


def origin():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return 'http://127.0.0.1:' + str(sock.getsockname()[1])


def htpasswd(file, name):
    subprocess.run(['htpasswd', '-iB'] + ([] if file.exists() else ['-c']) + [str(file), name],
                   input=TEST_PASSWORD + '\n', text=True, capture_output=True, check=True)


@contextmanager
def fixture(tmp):
    data, admin = origin(), origin()
    while admin == data:
        admin = origin()
    cfg, root, state, run = (tmp / n for n in ['etc', 'projects', 'state', 'run'])
    for d in [cfg, root, run, cfg / 'admin-api']:
        d.mkdir()
    for name in ['reader', 'writer']:
        htpasswd(cfg / 'users', name)
    htpasswd(cfg / 'admin-users', 'boss')
    projects = [{'id': n, 'directory': n, 'title': n.title(), 'publishers': ['writer']} for n in ['forest', 'trail']]
    initial = {'library': {'id': 'lab', 'title': '研究库'}, 'projects': projects,
               'groups': [{'id': 'render', 'title': '渲染组', 'members': ['reader'], 'projects': ['forest']}]}
    (cfg / 'groups.json').write_text(json.dumps(initial))
    registry = Registry(state, root)
    registry.initialize(cfg / 'groups.json', cfg / 'users')
    for p in projects:
        d = root / p['directory']
        (d / 'latest.json').write_text(json.dumps({'projectId': p['id']}))
        (d / 'snapshots').mkdir()
        (d / 'snapshots/sample.json').write_text('{"sample":true}')
    for src in ['groups.py', 'admin_registry.py']:
        shutil.copy(DEPLOY / src, cfg / src)
    shutil.copytree(DEPLOY / 'admin-ui', cfg / 'admin-ui')
    shutil.copy(DEPLOY / 'registry.cgi', cfg / 'admin-api' / 'registry.cgi')
    for src in ['httpd.conf', 'managed-access.conf', 'admin.conf']:
        conf = (DEPLOY / src).read_text()
        conf = conf.replace('127.0.0.1:17841', data.split('//')[1]).replace('127.0.0.1:17842', admin.split('//')[1])
        for key, val in [('/var/lib/mekir-preview-admin', state), ('/etc/mekir-preview', cfg),
                         ('/srv/mekir-previews', root), ('/run/mekir-preview', run),
                         ('${MEKIR_ADMIN_ORIGIN}', admin), ('${MEKIR_PREVIEW_ORIGIN}', data),
                         ('syslog:local6', tmp / 'errors')]:
            conf = conf.replace(key, str(val))
        if sys.platform == 'darwin':
            conf = conf.replace('/usr/lib/apache2/modules/', '/usr/libexec/apache2/')
            if src == 'httpd.conf':
                conf += '\nLoadModule unixd_module /usr/libexec/apache2/mod_unixd.so\n'
        if src == 'admin.conf':
            conf = conf.replace('SetEnv PYTHONDONTWRITEBYTECODE', f'SetEnv MEKIR_ADMIN_STATE {state}\n    SetEnv MEKIR_PROJECT_ROOT {root}\n    SetEnv PYTHONDONTWRITEBYTECODE')
        if src == 'httpd.conf' and os.geteuid():
            conf += f'\nUser {pwd.getpwuid(os.getuid()).pw_name}\nGroup {grp.getgrgid(os.getgid()).gr_name}\n'
        (cfg / src).write_text(conf)
    binary = shutil.which('httpd' if sys.platform == 'darwin' else 'apache2')
    cmd = [binary, '-f', str(cfg / 'httpd.conf')]
    subprocess.run([*cmd, '-t'], check=True)
    proc = subprocess.Popen([*cmd, '-DFOREGROUND'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(100):
            if proc.poll() is not None:
                raise RuntimeError(proc.stderr.read().decode())
            try:
                with socket.create_connection(('127.0.0.1', int(admin.rsplit(':', 1)[1])), timeout=.2):
                    break
            except OSError:
                time.sleep(.03)
        yield data, admin, root, state
    except BaseException:
        if (tmp / 'errors').exists():
            print((tmp / 'errors').read_text()[-3000:], file=sys.stderr)
        raise
    finally:
        proc.terminate()
        proc.wait(timeout=8)


def call(url, username=None, *, payload=None, headers=None, method=None, password=TEST_PASSWORD):
    headers = dict(headers or {})
    if username:
        headers['Authorization'] = 'Basic ' + base64.b64encode((username + ':' + password).encode()).decode()
    body = json.dumps(payload).encode() if payload is not None else None
    if body:
        headers['Content-Type'] = 'application/json'
    try:
        with opener.open(Request(url, data=body, headers=headers, method=method), timeout=8) as response:
            return response.status, response.read()
    except HTTPError as e:
        return e.code, e.read()


def verify(data, admin, root, state):
    api = admin + '/api'
    headers = {'Origin': admin, 'X-MekiR-Request': 'admin'}
    assert call(admin + '/')[0] == 401
    assert call(api, 'reader')[0] == 401
    assert call(data + '/api', 'boss')[0] != 200
    assert call(admin + '/forest/latest.json', 'boss')[0] == 404
    assert '订阅管理' in call(admin + '/', 'boss')[1].decode()
    code, raw = call(api, 'boss')
    assert code == 200, (code, raw)
    info = json.loads(raw)
    assert info['accounts'] == ['reader', 'writer'] and info['operator'] == 'boss' and b'$2' not in raw
    revision = info['revision']
    catalog_url = data + '/_mekir/accounts/reader.json'
    assert [p['id'] for p in json.loads(call(catalog_url, 'reader')[1])['projects']] == ['forest']
    assert call(data + '/_mekir/accounts/writer.json', 'reader')[0] == 403
    assert call(data + '/trail/snapshots/sample.json', 'reader')[0] == 403
    assert call(data + '/forest/snapshots/sample.json', 'reader')[0] == 200
    assert call(data + '/forest/new.txt', 'reader', method='PUT')[0] == 403

    def change(action, values, expected=200):
        nonlocal revision
        code, body = call(api, 'boss', headers=headers, payload={'revision': revision, 'action': action, 'data': values})
        assert code == expected, (action, code, body)
        result = json.loads(body)
        if expected == 200:
            revision = result['revision']
        return result

    update = {'revision': revision, 'action': 'group.create', 'data': {'title': '计时组', 'members': ['reader'], 'projects': ['trail']}}
    assert call(api, 'boss', payload=update, headers={**headers, 'Origin': data})[0] == 403
    assert call(api, 'boss', payload=update)[0] == 403
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(lambda _: call(api, 'boss', headers=headers, payload=update), [1, 2]))
    assert sorted(code for code, _ in replies) == [200, 409]
    saved = json.loads(next(b for c, b in replies if c == 200))
    group, revision = saved['changedId'], saved['revision']
    assert [p['id'] for p in json.loads(call(catalog_url, 'reader')[1])['projects']] == ['forest', 'trail']
    assert call(data + '/trail/snapshots/sample.json', 'reader')[0] == 200
    change('group.update', {'id': group, 'title': '计时复测', 'members': ['reader'], 'projects': ['trail']})
    change('account.create', {'id': 'visitor', 'password': 'a-test-password', 'groups': [group]})
    # Restore the same group assignments and password hashes at a different filesystem root.
    with tempfile.TemporaryDirectory() as moved:
        moved = Path(moved)
        (moved / 'projects').mkdir()
        relocated = Registry(moved / 'settings', moved / 'projects')
        source = state / revision
        relocated.initialize(source / 'groups.json', source / 'users')
        copy = relocated.view()
        current = Registry(state, root).view()
        assert all(copy[k] == current[k] for k in ('library', 'groups', 'projects', 'accounts'))
        assert (relocated.state / relocated.current() / 'users').read_bytes() == (source / 'users').read_bytes()
        relocated.initialize(moved / 'unused', moved / 'unused')
        assert relocated.current() == copy['revision']
    visit = data + '/_mekir/accounts/visitor.json'
    assert [g['title'] for g in json.loads(call(visit, 'visitor', password='a-test-password')[1])['groups']] == ['计时复测']
    change('account.update', {'id': 'visitor', 'password': 'next-test-password', 'groups': []})
    assert call(visit, 'visitor', password='a-test-password')[0] == 401
    assert json.loads(call(visit, 'visitor', password='next-test-password')[1])['groups'] == []
    change('project.create', {'id': 'new-project', 'title': '新项目', 'directory': 'new-project', 'publishers': ['visitor'], 'groups': [group]})
    put = data + '/new-project/note.txt'
    assert call(put, 'visitor', password='next-test-password', method='PUT')[0] == 201
    assert call(put, 'reader')[0] == 200
    change('project.update', {'id': 'new-project', 'title': '复测项目', 'directory': 'new-project', 'publishers': ['writer'], 'groups': []})
    assert call(put, 'visitor', password='next-test-password', method='PUT')[0] == 403
    assert call(put, 'reader')[0] == 403
    before = revision
    change('project.create', {'id':'wrong', 'title':'错误映射', 'directory':'forest', 'publishers':[], 'groups':[]}, 400)
    assert Registry(state, root).current() == before
    change('project.remove', {'id': 'new-project'})
    assert (root / 'new-project' / 'note.txt').exists()
    change('group.remove', {'id': group})
    assert call(data + '/trail/snapshots/sample.json', 'reader')[0] == 403
    change('account.remove', {'id': 'visitor'})
    assert call(visit, 'visitor', password='next-test-password')[0] == 401
    assert json.loads(call(catalog_url, 'reader')[1])['groups'][0]['id'] == 'render'
    assert len([p for p in state.iterdir() if p.is_dir() and not p.is_symlink()]) == 2
    print('Admin authentication, concurrent saves, account lifecycle, in-place ACL changes, live client catalogs and archive retention passed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(dir='/tmp', prefix='mekir-admin-') as tmp:
        with fixture(Path(tmp).resolve()) as (data, admin, root, state):
            if args.serve:
                print(json.dumps({'data':data, 'admin':admin}), flush=True)
                sys.stdin.readline()
            else:
                verify(data, admin, root, state)
