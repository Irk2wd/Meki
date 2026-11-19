#!/usr/bin/env python3
"""Mirror Meki and mekiR's public, signed GitHub update assets."""

import argparse
import base64
import fcntl
import hashlib
import json
import re
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen

API = 'https://api.github.com/repos/Irk2wd/Meki/releases'
HEADERS = {'User-Agent': 'Meki-update-mirror', 'Cache-Control': 'no-cache'}
TAG = re.compile(r'(mekir-)?v((?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))')
EDITIONS = {'Meki': 'io.meki.editor', 'mekiR': 'io.meki.research'}
PLATFORMS = {'windows': ('win32', 'Setup-x64.exe'), 'macos': ('darwin', 'macOS-universal.dmg')}
SYNC_LOCK = '.sync.lock'
INSTALLERS_LOCK = '.sync-installers.lock'
PARTIAL = re.compile(r'\.(.+)\.[1-9][0-9]*\.part')


def public_releases():
    page = 1
    while True:
        request = Request(f'{API}?per_page=20&page={page}', headers={
            **HEADERS, 'Accept': 'application/vnd.github+json',
        })
        with urlopen(request, timeout=30) as response:
            data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('GitHub release list is too large')
        releases = json.loads(data)
        if not isinstance(releases, list) or len(releases) > 20:
            raise ValueError('Invalid GitHub release list')
        for release in releases:
            tag = TAG.fullmatch(release.get('tag_name', ''))
            if tag and release.get('published_at') and not release['draft'] and not release['prerelease']:
                yield tag, release
        if len(releases) < 20:
            return
        page += 1


def usable_asset(asset, limit):
    return (type(asset.get('id')) is int and asset['id'] > 0
            and type(asset.get('size')) is int and 0 < asset['size'] <= limit
            and re.fullmatch(r'sha256:[0-9a-f]{64}', asset.get('digest') or ''))


def asset_names(edition, version, target):
    return (f'{edition}-update-{target}.json', f'{edition}-{version}-{target}-app.asar.gz',
            f'{edition}-{version}-{PLATFORMS[target][1]}')


def version_key(version):
    return tuple(map(int, version.split('.')))


def select_updates():
    selected = {}
    for tag, release in public_releases():
        standalone, version = tag.groups()
        sort_key = version_key(version)
        files = {}
        for asset in release['assets']:
            if asset['state'] == 'uploaded':
                files.setdefault(asset['name'], []).append(asset)
        for edition in EDITIONS:
            if standalone and edition != 'mekiR':
                continue
            for target in PLATFORMS:
                names = asset_names(edition, version, target)
                manifest = names[0]
                if manifest in selected and selected[manifest][0] >= sort_key:
                    continue
                groups = [files.get(name, []) for name in names]
                limits = (65536, 512 * 1024 ** 2, 2 * 1024 ** 3)
                if all(len(group) == 1 and usable_asset(group[0], limit) for group, limit in zip(groups, limits)):
                    selected[manifest] = (sort_key, release, edition, target, [group[0] for group in groups])
    return selected.values()


def matches(file, asset):
    if not file.is_file() or file.stat().st_size != asset['size']:
        return False
    digest = hashlib.sha256()
    with file.open('rb') as data:
        for chunk in iter(lambda: data.read(1024 * 1024), b''):
            digest.update(chunk)
    return asset['digest'] == f'sha256:{digest.hexdigest()}'


def download(folder, asset):
    target = folder / asset['name']
    partial = folder / f'.{target.name}.{asset["id"]}.part'
    if matches(target, asset):
        partial.unlink(missing_ok=True)
        return target
    if partial.exists() and partial.stat().st_size > asset['size']:
        partial.unlink()
    offset = partial.stat().st_size if partial.exists() else 0
    if offset < asset['size']:
        print(f'Downloading {target.name}', flush=True)
        url = f'{API}/assets/{asset["id"]}?mirror={int(time.time())}'
        command = [
            'curl', '--fail', '--silent', '--show-error', '--location', '--max-redirs', '4',
            '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20',
            '--speed-limit', '1024', '--speed-time', '90', '--max-time', '10800',
            '--header', 'Accept: application/octet-stream', '--header', 'Cache-Control: no-cache',
            '--user-agent', HEADERS['User-Agent'], '--continue-at', '-', '--output', str(partial), url,
        ]
        result = subprocess.run(command)
        if result.returncode == 33 and offset:
            # Some GitHub asset responses do not accept the saved byte range.
            partial.unlink(missing_ok=True)
            print(f'Restarting {target.name} because the server rejected the saved range', flush=True)
            result = subprocess.run(command)
        result.check_returncode()
    if not matches(partial, asset):
        partial.unlink(missing_ok=True)
        raise ValueError(f'GitHub asset checksum mismatch for {target.name}')
    partial.chmod(0o644)
    partial.replace(target)
    return target


def sync_update(root, plan, installers_only):
    _, release, edition, target, (manifest_asset, payload, installer) = plan
    tag = release['tag_name']
    version = TAG.fullmatch(tag)[2]
    folder = root / 'releases' / tag
    latest = root / 'latest'
    pointer = latest / manifest_asset['name']
    if installers_only:
        if not pointer.is_file():
            return
        index = json.loads(pointer.read_bytes())
        if index['tag'] != tag:
            return
        envelope = index['manifest']
    else:
        folder.mkdir(parents=True, exist_ok=True)
        envelope = json.loads(download(folder, manifest_asset).read_bytes())
    signed = json.loads(base64.b64decode(envelope['body'], validate=True))
    if (envelope['schema'] != 1 or signed['appId'] != EDITIONS[edition]
            or signed['version'] != version or signed['platform'] != PLATFORMS[target][0]):
        raise ValueError(f'Update manifest does not match {edition} {target} {tag}')
    for kind, asset in [('payload', payload), ('installer', installer)]:
        if signed[kind] != {'name': asset['name'], 'size': asset['size'], 'sha256': asset['digest'][7:]}:
            raise ValueError(f'Update manifest does not match {asset["name"]}')
    if installers_only:
        download(folder, installer)
        return
    download(folder, payload)
    # Lightweight updates can start while the installer syncs. The client can
    # fall back to the same version's installer on GitHub in the meantime.
    # The client additionally verifies the original Ed25519 envelope before use.
    notes = str(release.get('body') or '')[:16000]
    update = {'tag': tag, 'manifest': envelope, 'notes': notes, 'checkedAt': int(time.time())}
    data = json.dumps(update, ensure_ascii=False).encode()
    if len(data) > 65536:
        update['notes'] = ''
        data = json.dumps(update).encode()
    with tempfile.NamedTemporaryFile(dir=latest, prefix='.mirror-', delete=False) as temporary:
        staging = Path(temporary.name)
        try:
            temporary.write(data)
            temporary.close()
            staging.chmod(0o644)
            staging.replace(pointer)
        finally:
            staging.unlink(missing_ok=True)
    print(f'Published {manifest_asset["name"]} for {tag}', flush=True)


def prune_old_releases(root):
    releases = root / 'releases'
    if releases.is_symlink() or not releases.is_dir():
        return

    published = {}
    for edition in EDITIONS:
        for target in PLATFORMS:
            pointer = root / 'latest' / f'{edition}-update-{target}.json'
            try:
                tag = TAG.fullmatch(json.loads(pointer.read_bytes())['tag'])
                if not tag or (tag[1] and edition != 'mekiR'):
                    raise ValueError('invalid release tag')
                _, payload, _ = asset_names(edition, tag[2], target)
                if not (releases / tag[0] / payload).is_file():
                    raise ValueError('published payload is missing')
            except FileNotFoundError:
                continue
            except (KeyError, TypeError, ValueError) as error:
                print(f'Skipping cleanup for {pointer.name}: {error}', flush=True)
                continue
            published[edition, target] = version_key(tag[2])

    removed = reclaimed = 0
    for folder in releases.iterdir():
        tag = TAG.fullmatch(folder.name)
        if not tag or folder.is_symlink() or not folder.is_dir():
            continue
        version = tag[2]
        release_version = version_key(version)
        obsolete = {name for (edition, target), current in published.items()
                    if release_version < current
                    for name in asset_names(edition, version, target)}
        if not obsolete:
            continue
        for file in folder.iterdir():
            partial = PARTIAL.fullmatch(file.name)
            name = partial[1] if partial else file.name
            if name in obsolete and not file.is_symlink() and file.is_file():
                reclaimed += file.stat().st_size
                file.unlink()
                removed += 1
        if not any(folder.iterdir()):
            folder.rmdir()
    if removed:
        print(f'Pruned {removed} superseded mirror files ({reclaimed} bytes)', flush=True)


def prune_when_idle(root):
    # Either worker can clean the shared release directories once both locks are free.
    with (root / SYNC_LOCK).open('a') as sync, (root / INSTALLERS_LOCK).open('a') as installers:
        try:
            fcntl.flock(sync, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(installers, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        prune_old_releases(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--installers-only', action='store_true', help='Sync the full installers for the published indexes')
    args = parser.parse_args()
    root = args.directory.resolve()
    (root / 'latest').mkdir(parents=True, exist_ok=True)
    lock_name = INSTALLERS_LOCK if args.installers_only else SYNC_LOCK
    try:
        with (root / lock_name).open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            updates = list(select_updates())
            if not updates:
                raise RuntimeError('No complete GitHub releases found')
            with ThreadPoolExecutor(max_workers=4) as executor:
                jobs = [executor.submit(sync_update, root, update, args.installers_only) for update in updates]
                for job in jobs:
                    job.result()
    finally:
        prune_when_idle(root)


if __name__ == '__main__':
    main()
