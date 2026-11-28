#!/usr/bin/env python3
"""Compile group discovery and Apache project permissions from the same policy."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

ID = re.compile(r'[a-z][a-z0-9_-]{0,63}')
DIRECTORY = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}')
ACCOUNT = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}')
FORMAT = 'mekir-subscriptions/1'


def checked(value, pattern):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f'Invalid identifier: {value!r}')
    return value


def title(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 240:
        raise ValueError('A title must contain 1–240 characters')
    return value


def references(values, allowed):
    if not isinstance(values, list) or any(v not in allowed for v in values) or len(set(values)) != len(values):
        raise ValueError(f'Unknown or duplicate reference: {values!r}')
    return values


def indexed(items):
    result = {}
    for item in items:
        key = checked(item['id'], ID)
        if key in result:
            raise ValueError(f'Duplicate ID: {key}')
        title(item['title'])
        result[key] = item
    return result


def quoted(path, directory=False):
    value = str(path.resolve()) + ('/' if directory else '')
    if any(c in value for c in '\r\n"\\$'):
        raise ValueError('Use a plain absolute path for Apache configuration')
    return f'"{value}"'


def compile_policy(config, users, root, destination, users_path):
    library = {'id': checked(config['library']['id'], ID), 'title': title(config['library']['title'])}
    projects = indexed(config['projects'])
    groups = indexed(config['groups'])
    readers = {key: set() for key in projects}
    directories = set()
    for key, project in projects.items():
        folder = checked(project['directory'], DIRECTORY)
        directory = root / folder
        if folder in directories or directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise ValueError(f'Invalid or duplicate project directory: {folder}')
        directories.add(folder)
        references(project['publishers'], users)
        head = root / folder / 'latest.json'
        if head.exists() and json.loads(head.read_bytes())['projectId'] != key:
            raise ValueError(f'Published project ID differs at {folder}')
    for group in groups.values():
        references(group['members'], users)
        for key in references(group['projects'], projects):
            readers[key].update(group['members'])
    catalogs = {}
    for user in sorted(users):
        memberships = [{k: g[k] for k in ('id', 'title', 'projects')} for g in groups.values() if user in g['members']]
        visible = {key for group in memberships for key in group['projects']}
        catalogs[user] = {'format': FORMAT, 'library': library, 'groups': memberships,
                          'projects': [{k: p[k] for k in ('id', 'title', 'directory')} for key, p in projects.items() if key in visible]}
    rules = [f'Alias /_mekir/accounts/ {quoted(destination / "catalogs", directory=True)}',
             f'<Directory {quoted(destination / "catalogs")}>', '  Options None', '  AllowOverride None',
             '  AuthType Basic', '  AuthzSendForbiddenOnFailure On', '  AuthName "mekiR subscriptions"', f'  AuthUserFile {quoted(users_path)}', '  Require all denied']
    for user in sorted(users):
        rules.extend([f'  <Files "{user}.json">', '    <RequireAll>', '      Require method GET',
                      f'      Require user {user}', '    </RequireAll>', '  </Files>'])
    rules.append('</Directory>')
    for key, project in projects.items():
        writers = set(project['publishers'])
        def require(names):
            return 'Require user ' + ' '.join(sorted(names)) if names else 'Require all denied'
        rules.extend([f'<Directory {quoted(root / project["directory"])}>', '  Dav On', '  AuthType Basic',
                      '  AuthzSendForbiddenOnFailure On', '  AuthName "mekiR private previews"', f'  AuthUserFile {quoted(users_path)}',
                      '  <Limit GET OPTIONS PROPFIND>', '    ' + require(readers[key] | writers), '  </Limit>',
                      '  <LimitExcept GET OPTIONS PROPFIND>', '    ' + require(writers), '  </LimitExcept>', '</Directory>'])
    return catalogs, '\n'.join(rules) + '\n'


def generate(config_path, users_path, root, output):
    config = json.loads(config_path.read_bytes())
    users = {checked(line.split(':', 1)[0], ACCOUNT) for line in users_path.read_text().splitlines() if line}
    seed = json.dumps([config, sorted(users), str(root.resolve()), str(output.resolve()), str(users_path.resolve())], sort_keys=True).encode()
    generation = hashlib.sha256(Path(__file__).read_bytes() + seed).hexdigest()
    destination = output / generation
    catalogs, rules = compile_policy(config, users, root, destination, users_path)
    # Apache applies directory-specific WebDAV rules after the project directory exists.
    owner = root.stat()
    for project in config['projects']:
        directory = root / project['directory']
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            if directory.is_symlink() or not directory.is_dir():
                raise ValueError(f'Invalid project directory: {directory}')
        else:
            created = directory.stat()
            if (created.st_uid, created.st_gid) != (owner.st_uid, owner.st_gid):
                try:
                    os.chown(directory, owner.st_uid, owner.st_gid, follow_symlinks=False)
                except OSError:
                    directory.rmdir()
                    raise
    output.mkdir(mode=0o755, parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(dir=output))
    try:
        if not destination.exists():
            (tmp / 'catalogs').mkdir(mode=0o755)
            for user, catalog in catalogs.items():
                (tmp / 'catalogs' / (user + '.json')).write_text(json.dumps(catalog, ensure_ascii=False), encoding='utf8')
            (tmp / 'access.conf').write_text(rules)
            for file in (tmp / 'access.conf', *(tmp / 'catalogs').iterdir()):
                file.chmod(0o644)
            (tmp / 'catalogs').chmod(0o755)
            tmp.chmod(0o755)
            try:
                tmp.rename(destination)
            except OSError:
                if not destination.is_dir():
                    raise
        link = Path(tempfile.mkdtemp(dir=output))
        try:
            (link / 'current').symlink_to(generation)
            os.replace(link / 'current', output / 'current')
        finally:
            link.rmdir()
    finally:
        if tmp.exists():
            shutil.rmtree(tmp)
    print(f'{len(catalogs)} accounts, {len(config["groups"])} groups, {len(config["projects"])} projects')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('/etc/mekir-preview/groups.json'))
    parser.add_argument('--users', type=Path, default=Path('/etc/mekir-preview/users'))
    parser.add_argument('--root', type=Path, default=Path('/srv/mekir-previews'))
    parser.add_argument('--output', type=Path, default=Path('/etc/mekir-preview/policy'))
    args = parser.parse_args()
    generate(args.config, args.users, args.root, args.output)
