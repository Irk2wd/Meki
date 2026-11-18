"""Publish both verified deliveries together as one GitHub Release."""
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

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


def collect_delivery(directory, output, product, version, tag):
    verification = json.loads((directory / 'verification.json').read_text(encoding='utf-8'))
    commit = subprocess.check_output(['git', 'rev-parse', f'refs/tags/{tag}^{{commit}}'], cwd=ROOT, text=True).strip()
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
        asset = 'mekiR-' + name if product == 'mekiR' and name in shared else name
        target = output / asset
        require(not target.exists(), f'Duplicate release asset: {asset}')
        shutil.copy2(directory / name, target)
        require(sha256(target) == digest, 'Delivery checksum mismatch: ' + asset)
        combined[asset] = digest
    return combined


def publish(version, directory):
    require(re.fullmatch(r'\d+\.\d+\.\d+', version), 'Invalid release version')
    tag = 'v' + version
    title = 'Meki / mekiR ' + version
    existing = gh('release', 'view', tag, '--json', 'isDraft', check=False)
    if existing.returncode == 0 and not json.loads(existing.stdout)['isDraft']:
        print(tag + ' is already published.')
        return

    with tempfile.TemporaryDirectory(prefix='meki-release-') as temporary:
        output = pathlib.Path(temporary) / 'assets'
        output.mkdir()
        checksums = collect_delivery(directory / 'Meki' / 'publish', output, 'Meki', version, tag)
        checksums.update(collect_delivery(directory / 'mekiR' / 'publish', output, 'mekiR', version, 'mekir-' + tag))
        inventory = output / 'SHA256SUMS.txt'
        inventory.write_text(''.join(f'{checksums[name]}  {name}\n' for name in sorted(checksums)), encoding='utf-8')
        checksums[inventory.name] = sha256(inventory)

        notes = pathlib.Path(temporary) / 'release-body.md'
        stable_notes = (output / 'ReleaseNotes.md').read_text(encoding='utf-8').strip()
        research_notes = (output / 'mekiR-ReleaseNotes.md').read_text(encoding='utf-8').strip()
        notes.write_text('标准版的安装包以 `Meki-` 开头，研究版以 `mekiR-` 开头。\n\n'
                         + stable_notes + '\n\n---\n\n' + research_notes + '\n', encoding='utf-8')
        if existing.returncode:
            gh('release', 'create', tag, '--verify-tag', '--draft', '--title', title, '--notes-file', str(notes))
        else:
            gh('release', 'edit', tag, '--title', title, '--notes-file', str(notes))
        gh('release', 'upload', tag, *(str(output / name) for name in sorted(checksums)), '--clobber')

        repository = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').stdout.strip()
        release = json.loads(gh('api', '--paginate', 'repos/' + repository + '/releases?per_page=100',
                                '--jq', '.[] | select(.tag_name == "' + tag + '")').stdout)
        require(release['draft'] and not release['prerelease'], 'Release must remain a draft during upload')
        assets = release['assets']
        require(len(assets) == len(checksums) and {asset['name'] for asset in assets} == set(checksums),
                'Release asset inventory differs from the verified delivery')
        for asset in assets:
            file = output / asset['name']
            require(asset['state'] == 'uploaded' and asset['size'] == file.stat().st_size, 'Incomplete release upload')
            require(asset.get('digest') == 'sha256:' + checksums[file.name], 'Uploaded release checksum mismatch: ' + file.name)

        gh('release', 'edit', tag, '--draft=false', '--latest')
        published = json.loads(gh('release', 'view', tag, '--json', 'isDraft,isPrerelease,url').stdout)
        require(not published['isDraft'] and not published['isPrerelease'], 'Release was not published')
        print(published['url'])


if __name__ == '__main__':
    publish(sys.argv[1], pathlib.Path(sys.argv[2]).resolve())
