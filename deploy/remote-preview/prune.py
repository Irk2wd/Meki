#!/usr/bin/env python3
"""Prune retired mekiR snapshots in a private WebDAV tree. Leave unrelated files alone."""
import argparse
import hashlib
import json
import re
import time
from pathlib import Path

HASH = re.compile(r'[0-9a-f]{64}')
PENDING = re.compile(r'pending-[0-9a-f-]{36}\.json')
FORMAT = 'mekir-preview/1'


def read_json(path, limit, expected=None):
    if path.is_symlink() or path.stat().st_size > limit:
        raise ValueError('Invalid preview file')
    data = path.read_bytes()
    if expected and hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('Snapshot checksum mismatch')
    return json.loads(data)


def prune(folder, cutoff):
    head = folder / 'latest.json'
    pointer = read_json(head, 4096)
    if pointer.get('format') != FORMAT:
        return
    snapshots = {pointer['revision']}
    if pointer.get('previous'):
        snapshots.add(pointer['previous'])
    if (folder / 'snapshots').is_symlink() or (folder / 'media').is_symlink():
        return
    media = set()
    for hash_id in snapshots:
        if not HASH.fullmatch(hash_id):
            return
        manifest = read_json(folder / 'snapshots' / (hash_id + '.json'), 8 * 1024**2, hash_id)
        if manifest.get('format') != FORMAT or manifest['project']['id'] != pointer['projectId']:
            return
        for item in manifest['items']:
            for row in item.get('figure', {}).get('rows', []):
                media.update(h for h in row['images'] if h is not None)
    candidates = []
    for directory, extension, keep in [('snapshots', '.json', snapshots), ('media', '.png', media), ('media', '.jpg', media)]:
        target = folder / directory
        if target.is_symlink():
            return
        candidates.extend(f for f in target.iterdir() if f.suffix == extension and HASH.fullmatch(f.stem) and f.stem not in keep)
    pending = [f for f in folder.iterdir() if PENDING.fullmatch(f.name)]
    if any(f.stat().st_mtime >= cutoff for f in pending):
        return  # A publisher is uploading. Recheck on the next maintenance run.
    for f in candidates + pending:
        if f.is_symlink() or not f.is_file() or f.stat().st_mtime >= cutoff:
            continue
        if read_json(head, 4096) != pointer or any(p.stat().st_mtime >= cutoff for p in folder.glob('pending-*.json')):
            return
        f.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    for head in args.root.resolve().rglob('latest.json'):
        try:
            prune(head.parent, time.time() - 86400)
        except (OSError, KeyError, TypeError, ValueError) as e:
            print(f'Skipped {head.parent.name}: {e}')
