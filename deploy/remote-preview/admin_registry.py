"""Subscription group administration for the private mekiR Apache service."""
import argparse
from contextlib import contextmanager
import fcntl
from http import HTTPStatus
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

import groups

STATE = Path('/var/lib/mekir-preview-admin')
ROOT = Path('/srv/mekir-previews')
GENERATION = re.compile(r'[0-9a-f]{32}')
MAX_BODY = 131072


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def require(condition, message, status=400):
    if not condition:
        raise RequestError(status, message)


def identifier(value, pattern, label):
    require(isinstance(value, str) and pattern.fullmatch(value), f'{label}格式无效。')
    return value


def title(data):
    value = data.get('title')
    require(isinstance(value, str) and 0 < len(value.strip()) <= 240, '请输入名称，最多 240 个字符。')
    return value.strip()


def selection(data, field, allowed):
    items = data.get(field)
    require(isinstance(items, list) and all(isinstance(item, str) and item in allowed for item in items)
            and len(items) == len(set(items)), '选择中包含重复或已移除的项目、订阅组或账号。')
    return items


def assign(rows, field, value, selected):
    for item in rows:
        has = value in item[field]
        if item['id'] in selected and not has:
            item[field].append(value)
        elif item['id'] not in selected and has:
            item[field].remove(value)


def password_hash(name, password):
    require(isinstance(password, str) and len(password) >= 12 and len(password.encode()) <= 72
            and not any(c in password for c in '\r\n\0'), '密码至少 12 个字符，UTF-8 长度最多 72 字节。')
    result = subprocess.run(['htpasswd', '-niB', '-C', '10', name], input=password + '\n',
                            text=True, capture_output=True, timeout=10, check=True)
    account, hashed = result.stdout.strip().split(':', 1)
    if account != name or not hashed.startswith('$2'):
        raise RuntimeError('Password hashing failed')
    return hashed


def read_users(file):
    result = {}
    for line in file.read_text().splitlines():
        if line:
            name, hashed = line.split(':', 1)
            groups.checked(name, groups.ACCOUNT)
            if name in result or not hashed or ':' in hashed:
                raise ValueError('Invalid account file')
            result[name] = hashed
    return result


def edit(config, users, action, data):
    group_rows, projects = config['groups'], config['projects']
    group_ids = {g['id'] for g in group_rows}
    project_ids = {p['id'] for p in projects}
    kind, _, verb = action.partition('.')
    require(kind in ('group', 'project', 'account') and verb in ('create', 'update', 'remove'), '未知管理操作。')
    creating = verb == 'create'
    if kind == 'account':
        key = identifier(data.get('id'), groups.ACCOUNT, '用户名')
        require((key not in users) if creating else (key in users), '账号已存在或已被移除。', 409)
        if verb == 'remove':
            del users[key]
            assign(group_rows, 'members', key, set())
            assign(projects, 'publishers', key, set())
        else:
            memberships = selection(data, 'groups', group_ids)
            if creating or data.get('password'):
                users[key] = password_hash(key, data.get('password'))
            assign(group_rows, 'members', key, memberships)
        return key
    rows = group_rows if kind == 'group' else projects
    key = 'g-' + uuid.uuid4().hex[:16] if kind == 'group' and creating else data.get('id')
    identifier(key, groups.ID, 'ID')
    item = next((r for r in rows if r['id'] == key), None)
    require((item is None) == creating, '该 ID 已登记或条目已被移除。', 409)
    if verb == 'remove':
        rows.remove(item)
        if kind == 'project':
            assign(group_rows, 'projects', key, set())
        return key
    fields = {'id': key, 'title': title(data)}
    if kind == 'group':
        fields.update(members=selection(data, 'members', users), projects=selection(data, 'projects', project_ids))
    else:
        directory = identifier(data.get('directory'), groups.DIRECTORY, '发布目录')
        require(creating or item['directory'] == directory, '已登记项目的发布目录须保持稳定。')
        require(all(p['directory'] != directory or p['id'] == key for p in projects), '该发布目录已登记。')
        fields.update(directory=directory, publishers=selection(data, 'publishers', users))
        assign(group_rows, 'projects', key, selection(data, 'groups', group_ids))
    if item is None:
        rows.append(fields)
    else:
        item.update(fields)
    return key


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_file(file, data):
    with file.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


class Registry:
    def __init__(self, state=STATE, root=ROOT):
        self.state = state
        self.root = root

    @contextmanager
    def lock(self, exclusive):
        with (self.state / '.lock').open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            yield

    def current(self):
        revision = os.readlink(self.state / 'current')
        if not GENERATION.fullmatch(revision):
            raise RuntimeError('Invalid registry generation')
        return revision

    def read(self, revision):
        return json.loads((self.state / revision / 'groups.json').read_bytes()), read_users(self.state / revision / 'users')

    def save(self, config, users, previous):
        catalogs, readers = groups.project_access(config, users, self.root)
        require(all(len(json_bytes(catalog)) <= 2 * 1024 * 1024 for catalog in catalogs.values()),
                '账号清单超过桌面端的 2 MiB 读取上限。')
        groups.ensure_directories(config, self.root)
        permissions = []
        for project in config['projects']:
            writers = set(project['publishers'])
            for label, names in [('read', readers[project['id']] | writers), ('write', writers)]:
                members = sorted(names)
                for n in range(0, len(members), 40):
                    permissions.append(f'{label}-{project["directory"]}: ' + ' '.join(members[n:n + 40]) + '\n')
        revision = uuid.uuid4().hex
        generation = self.state / revision
        with tempfile.TemporaryDirectory(dir=self.state, prefix='.build-') as temporary:
            work = Path(temporary)
            bundle = work / 'generation'
            (bundle / 'catalogs').mkdir(parents=True, mode=0o700)
            write_file(bundle / 'groups.json', json_bytes(config))
            write_file(bundle / 'users', ''.join(f'{n}:{h}\n' for n, h in sorted(users.items())).encode())
            write_file(bundle / 'permissions', ''.join(permissions).encode())
            for user, catalog in catalogs.items():
                write_file(bundle / 'catalogs' / (user + '.json'), json_bytes(catalog))
            sync_dir(bundle / 'catalogs')
            sync_dir(bundle)
            bundle.rename(generation)
            (work / 'current').symlink_to(revision)
            os.replace(work / 'current', self.state / 'current')
            sync_dir(self.state)
        # Keep a complete previous generation for recovery. Project archives live elsewhere.
        for child in self.state.iterdir():
            if child.name not in (revision, previous) and GENERATION.fullmatch(child.name) and child.is_dir():
                try:
                    shutil.rmtree(child)
                except OSError:
                    print('Could not retire a previous registry generation', file=sys.stderr)
        return revision

    def initialize(self, config_file, users_file):
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.lock(True):
            if (self.state / 'current').is_symlink():
                self.read(self.current())
                return
            self.save(json.loads(config_file.read_bytes()), read_users(users_file), None)

    @staticmethod
    def public(config, users, revision):
        return {'revision': revision, 'library': {k: config['library'][k] for k in ('id', 'title')},
                'groups': [{k: g[k] for k in ('id', 'title', 'members', 'projects')} for g in config['groups']],
                'projects': [{k: p[k] for k in ('id', 'title', 'directory', 'publishers')} for p in config['projects']],
                'accounts': sorted(users)}

    def view(self):
        with self.lock(False):
            revision = self.current()
            return self.public(*self.read(revision), revision)

    def change(self, request):
        require(isinstance(request, dict) and isinstance(request.get('action'), str)
                and isinstance(request.get('data'), dict), '管理请求格式无效。')
        with self.lock(True):
            revision = self.current()
            require(request.get('revision') == revision, '清单已被其他管理员更新。请刷新并核对修改。', 409)
            config, users = self.read(revision)
            before = json_bytes([config, users])
            key = edit(config, users, request['action'], request['data'])
            if before != json_bytes([config, users]):
                revision = self.save(config, users, revision)
            return {**self.public(config, users, revision), 'changedId': key}


def serve():
    status = 200
    try:
        user = os.environ.get('REMOTE_USER')
        require(user, '请使用管理账号登录。', 401)
        method = os.environ.get('REQUEST_METHOD')
        registry = Registry(Path(os.environ.get('MEKIR_ADMIN_STATE', STATE)), Path(os.environ.get('MEKIR_PROJECT_ROOT', ROOT)))
        if method == 'GET':
            result = registry.view()
        elif method == 'POST':
            origin = os.environ.get('MEKIR_ADMIN_ORIGIN', '').rstrip('/')
            require(origin and os.environ.get('HTTP_ORIGIN') == origin and os.environ.get('HTTP_X_MEKIR_REQUEST') == 'admin',
                    '请在管理页面中提交修改。', 403)
            require(os.environ.get('CONTENT_TYPE', '').split(';')[0].strip().lower() == 'application/json', '请使用 JSON 格式提交。', 415)
            size = os.environ.get('CONTENT_LENGTH', '')
            require(size.isdigit() and 0 < int(size) <= MAX_BODY, '提交内容超出大小限制。', 413)
            result = registry.change(json.loads(sys.stdin.buffer.read(int(size))))
        else:
            raise RequestError(405, '不支持此请求方式。')
        result.update(operator=user, projectOrigin=os.environ.get('MEKIR_PROJECT_ORIGIN', '').rstrip('/'))
    except RequestError as e:
        status, result = e.status, {'error': str(e)}
    except ValueError:
        # Never include a submitted password, filesystem path or password hash in an HTTP error.
        status, result = 400, {'error': '清单校验失败。请核对项目 ID、发布目录和已发布快照。'}
    except Exception as e:
        print('Subscription administration failed:', type(e).__name__, file=sys.stderr)
        status, result = 500, {'error': '服务暂时无法完成这次操作，请刷新清单后重试。'}
    body = json_bytes(result)
    sys.stdout.buffer.write(f'Status: {status} {HTTPStatus(status).phrase}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {len(body)}\r\n\r\n'.encode() + body)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Initialize or restore the subscription administration registry.')
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--users', type=Path, required=True)
    parser.add_argument('--state', type=Path, default=STATE)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    os.umask(0o077)
    Registry(args.state, args.root).initialize(args.config, args.users)
