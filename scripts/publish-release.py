"""Upload a verified delivery to a draft, then publish the complete release."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys

# The release workflow runs this pinned publishing tool from the tested source checkout.
ROOT = pathlib.Path.cwd().resolve()


def gh(*args, check=True):
    result = subprocess.run(['gh', *args], cwd=ROOT, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or 'GitHub CLI command failed')
    return result


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


version = json.loads((ROOT / 'package.json').read_text())['version']
require(re.fullmatch(r'\d+\.\d+\.\d+', version), 'Invalid release version')
tag = 'v' + version
directory = pathlib.Path(sys.argv[1]).resolve()
notes = ROOT / 'docs' / 'releases' / (version + '.md')
verification = json.loads((directory / 'verification.json').read_text())
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
require(verification['version'] == version and verification['sourceCommit'] == commit, 'Delivery does not match this release')
require(verification['ci']['conclusion'] == 'success', 'Installer verification did not pass')
require(subprocess.check_output(['git', 'rev-parse', tag + '^{commit}'], cwd=ROOT, text=True).strip() == commit, 'Tag differs from the tested source')

files = sorted(file for file in directory.iterdir() if file.is_file())
checksums = {}
for line in (directory / 'SHA256SUMS.txt').read_text().splitlines():
    digest, name = line.split('  ', 1)
    require(re.fullmatch(r'[a-f0-9]{64}', digest) and pathlib.Path(name).name == name, 'Invalid checksum entry')
    require(name not in checksums, 'Duplicate checksum entry')
    checksums[name] = digest
require(set(checksums) | {'SHA256SUMS.txt'} == {file.name for file in files}, 'Delivery contains unverified files')
for file in files:
    with file.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    require(file.name == 'SHA256SUMS.txt' or checksums[file.name] == actual, 'Delivery checksum mismatch: ' + file.name)
    checksums[file.name] = actual

existing = gh('release', 'view', tag, '--json', 'isDraft', check=False)
if existing.returncode == 0:
    require(json.loads(existing.stdout)['isDraft'], 'Refusing to replace an already published release')
else:
    gh('release', 'create', tag, '--verify-tag', '--draft', '--title', 'Meki ' + version, '--notes-file', str(notes))
gh('release', 'edit', tag, '--title', 'Meki ' + version, '--notes-file', str(notes))
gh('release', 'upload', tag, *(str(file) for file in files), '--clobber')

repository = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').stdout.strip()
release = json.loads(gh('api', '--paginate', 'repos/' + repository + '/releases?per_page=100',
                        '--jq', '.[] | select(.tag_name == "' + tag + '")').stdout)
require(release['draft'] and not release['prerelease'], 'Release must remain a draft during upload')
assets = release['assets']
require(len(assets) == len(files) and {asset['name'] for asset in assets} == set(checksums), 'Release asset inventory differs from the verified delivery')
for asset in assets:
    file = directory / asset['name']
    require(asset['state'] == 'uploaded' and asset['size'] == file.stat().st_size, 'Incomplete release upload')
    require(asset.get('digest') == 'sha256:' + checksums[file.name], 'Uploaded release checksum mismatch: ' + file.name)

gh('release', 'edit', tag, '--draft=false', '--latest')
published = json.loads(gh('release', 'view', tag, '--json', 'isDraft,isPrerelease,url').stdout)
require(not published['isDraft'] and not published['isPrerelease'], 'Release was not published')
print(published['url'])
