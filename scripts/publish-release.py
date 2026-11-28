"""Publish the selected, verified editions in one GitHub Release."""
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from release_version import VERSION

# The workflow runs this tool from the pinned default-branch checkout.
ROOT = pathlib.Path.cwd().resolve()


def gh(*args, check=True):
    result = subprocess.run(['gh', *args], cwd=ROOT, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or 'GitHub CLI command failed')
    return result


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def collect_delivery(directory, output, edition, version, combined_release):
    product, tag = edition['product'], edition['tag']
    verification = json.loads((directory / 'verification.json').read_text(encoding='utf-8'))
    commit = subprocess.check_output(['git', 'rev-parse', f'refs/tags/{tag}^{{commit}}'], cwd=ROOT, text=True).strip()
    require(commit == edition['commit'], f'The source tag {tag} changed after planning.')
    require(verification['version'] == version and verification['sourceCommit'] == commit, f'{product} delivery does not match {tag}')
    ci = verification['ci']
    require(ci['headSha'] == commit and ci['status'] == 'completed' and ci['conclusion'] == 'success',
            f'{product} installer verification did not pass for {tag}')

    checksums = {}
    for line in (directory / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines():
        digest, name = line.split('  ', 1)
        require(re.fullmatch(r'[a-f0-9]{64}', digest) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name),
                'Invalid checksum entry')
        require(name not in checksums, 'Duplicate checksum entry')
        checksums[name] = digest
    files = {file.name for file in directory.iterdir() if file.is_file()}
    require(set(checksums) | {'SHA256SUMS.txt'} == files, f'{product} delivery contains unverified files')
    shared = {'README.md', 'ReleaseNotes.md', 'verification.json'}
    required = shared | {f'{product}-{version}-Setup-x64.exe', f'{product}-{version}-macOS-universal.dmg',
                         f'{product}-{version}-source.zip'}
    required |= {f'{product}-{version}-{platform}-app.asar.gz' for platform in ['windows', 'macos']}
    required |= {f'{product}-update-{platform}.json' for platform in ['windows', 'macos']}
    require(set(checksums) == required, f'{product} delivery has an unexpected asset inventory')

    combined = {}
    for name, digest in checksums.items():
        asset = 'mekiR-' + name if combined_release and product == 'mekiR' and name in shared else name
        target = output / asset
        require(not target.exists(), f'Duplicate release asset: {asset}')
        shutil.copy2(directory / name, target)
        require(sha256(target) == digest, 'Delivery checksum mismatch: ' + asset)
        combined[asset] = digest
    return combined


def publish(plan, directory):
    version, editions, tag = plan['version'], plan['editions'], plan['tag']
    require(re.fullmatch(VERSION, version), 'Invalid release version')
    prerelease = '-beta.' in version
    channel = '--prerelease=' + str(prerelease).lower()
    source_tags = {'Meki': 'v' + version, 'mekiR': 'mekir-v' + version}
    products = [edition['product'] for edition in editions]
    require(products and set(products) <= source_tags.keys() and len(set(products)) == len(products), 'Invalid release editions')
    for edition in editions:
        require(edition['tag'] == source_tags[edition['product']], 'Release plan has a mismatched source tag')
    require(tag == source_tags['Meki' if 'Meki' in products else 'mekiR'], 'Release plan has a mismatched publication tag')
    combined_release = len(products) == 2
    title = ' / '.join(products) + ' ' + version
    existing = gh('release', 'view', tag, '--json', 'isDraft,isPrerelease', check=False)
    if existing.returncode == 0 and not json.loads(existing.stdout)['isDraft']:
        require(json.loads(existing.stdout)['isPrerelease'] == prerelease, 'Published release is on the wrong channel')
        print(tag + ' is already published.')
        return

    with tempfile.TemporaryDirectory(prefix='meki-release-') as temporary:
        output = pathlib.Path(temporary) / 'assets'
        output.mkdir()
        checksums = {}
        release_notes = []
        for edition in editions:
            delivery = directory / edition['product'] / 'publish'
            checksums.update(collect_delivery(delivery, output, edition, version, combined_release))
            release_notes.append((delivery / 'ReleaseNotes.md').read_text(encoding='utf-8').strip())
        inventory = output / 'SHA256SUMS.txt'
        inventory.write_text(''.join(f'{checksums[name]}  {name}\n' for name in sorted(checksums)), encoding='utf-8')
        checksums[inventory.name] = sha256(inventory)

        notes = pathlib.Path(temporary) / 'release-body.md'
        body = '\n\n---\n\n'.join(release_notes) + '\n'
        if combined_release:
            body = '标准版的安装包以 `Meki-` 开头，研究版以 `mekiR-` 开头。\n\n' + body
        notes.write_text(body, encoding='utf-8')
        if existing.returncode:
            gh('release', 'create', tag, '--verify-tag', '--draft', channel, '--title', title, '--notes-file', str(notes))
        else:
            gh('release', 'edit', tag, channel, '--title', title, '--notes-file', str(notes))
        gh('release', 'upload', tag, *(str(output / name) for name in sorted(checksums)), '--clobber')

        repository = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').stdout.strip()
        release = json.loads(gh('api', '--paginate', 'repos/' + repository + '/releases?per_page=100',
                                '--jq', '.[] | select(.tag_name == "' + tag + '")').stdout)
        require(release['draft'] and release['prerelease'] == prerelease, 'Wrong draft state or release channel during upload')
        assets = release['assets']
        require(len(assets) == len(checksums) and {asset['name'] for asset in assets} == set(checksums),
                'Release asset inventory differs from the verified delivery')
        for asset in assets:
            file = output / asset['name']
            require(asset['state'] == 'uploaded' and asset['size'] == file.stat().st_size, 'Incomplete release upload')
            require(asset.get('digest') == 'sha256:' + checksums[file.name], 'Uploaded release checksum mismatch: ' + file.name)

        latest = '--latest' if 'Meki' in products and not prerelease else '--latest=false'
        gh('release', 'edit', tag, '--draft=false', channel, latest)
        published = json.loads(gh('release', 'view', tag, '--json', 'isDraft,isPrerelease,url').stdout)
        require(not published['isDraft'] and published['isPrerelease'] == prerelease, 'Unexpected published release channel')
        print(published['url'])


if __name__ == '__main__':
    publish(json.loads(os.environ['RELEASE_PLAN']), pathlib.Path(sys.argv[1]).resolve())
