"""Deliver the exact CI-tested installers, their provenance, and committed source."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import zipfile
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def read(filename):
    return json.loads(filename.read_text('utf-8-sig'))


def sha256(filename):
    with filename.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode('utf-8').strip()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('artifacts', type=pathlib.Path, help='Directory populated by gh run download')
parser.add_argument('output', type=pathlib.Path, help='New, empty versioned delivery directory')
parser.add_argument('--ci-json', required=True, type=pathlib.Path,
                    help='gh run view --json headSha,url,status,conclusion,jobs')
parser.add_argument('--source-archive', required=True, type=pathlib.Path,
                    help='Reviewed public source ZIP for this version')
args = parser.parse_args()
require(not git('status', '--porcelain', '--untracked-files=no'), 'Commit tracked changes before delivery')
commit = git('rev-parse', 'HEAD')
version = read(ROOT / 'package.json')['version']
ci = read(args.ci_json)
require(ci['headSha'] == commit, 'CI does not match the release commit')
require(ci['status'] == 'completed' and ci['conclusion'] == 'success', 'CI has not passed')
expected_jobs = {
    'Build installer (Windows x64)', 'Build installer (macOS universal)',
    'Verify installer (Windows x64)', 'Verify installer (macOS Apple Silicon)',
    'Verify installer (macOS Intel)',
}
require({job['name'] for job in ci['jobs']} == expected_jobs, 'Missing installer build/verification job')
require(all(job['conclusion'] == 'success' for job in ci['jobs']), 'An installer job did not pass')
manifests = {}
installers = {}
for platform in ['windows', 'macos']:
    files = list(args.artifacts.rglob(f'{platform}-build.json'))
    require(len(files) == 1, f'Expected one {platform} build manifest')
    manifest = read(files[0])
    require(manifest['version'] == version and manifest['sourceCommit'] == commit, 'Stale build manifest')
    require(manifest['platform'] == platform, 'Wrong build platform')
    expected_name = f'Meki-{version}-' + ('Setup-x64.exe' if platform == 'windows' else 'macOS-universal.dmg')
    require(manifest['installer'] == expected_name, 'Unexpected installer filename')
    installer = files[0].parent / expected_name
    require(sha256(installer) == manifest['sha256'], 'Installer digest mismatch')
    subprocess.run(['node', str(ROOT / 'scripts' / 'verify-update-assets.mjs'), str(files[0])], cwd=ROOT, check=True)
    manifests[platform] = manifest
    installers[platform] = installer

reports = {}
for filename in args.artifacts.rglob('report.json'):
    report = read(filename)
    if 'testedOn' not in report:
        continue
    target = report['testedOn']
    require(target not in reports, f'Duplicate validation for {target}')
    require(target in ['win32-x64', 'darwin-arm64', 'darwin-x64'], 'Unexpected validation target')
    manifest = manifests['windows' if target == 'win32-x64' else 'macos']
    for key in ['version', 'sourceCommit', 'installer', 'sha256', 'asarSha256', 'updateAssets', 'compatibilityInstaller']:
        require(report[key] == manifest[key], f'{target}: verified payload differs from delivered build')
    require(report.get('success') is True and not report.get('errors'), f'{target}: incomplete verification')
    require(report['unitTests'] >= 192 and report['uiChecks'] >= 190
            and len(report['ui']) == len(read(ROOT / 'package.json')['scripts']['test:ui'].split(' && ')),
            f'{target}: incomplete unit/desktop regression')
    require(any('uninstall removes' in check for check in report['checks']), f'{target}: missing uninstall check')
    reports[target] = report
require(set(reports) == {'win32-x64', 'darwin-arm64', 'darwin-x64'}, 'All three installed targets must pass')

output = args.output.resolve()
require(not output.exists() or not any(output.iterdir()), 'Delivery directory must be new or empty')
output.mkdir(parents=True, exist_ok=True)
for installer in installers.values():
    shutil.copy2(installer, output / installer.name)
    require(sha256(output / installer.name) == sha256(installer), 'Copied installer changed')
for platform, manifest in manifests.items():
    alias = installers[platform].parent / manifest['compatibilityInstaller']
    require(alias.name == manifest['compatibilityInstaller'] and sha256(alias) == manifest['sha256'], 'Compatibility installer differs')
    shutil.copy2(alias, output / alias.name)
    require(sha256(output / alias.name) == manifest['sha256'], 'Copied compatibility installer changed')
    for entry in manifest['updateAssets']:
        update_file = installers[platform].parent / entry['name']
        require(update_file.name == entry['name'] and sha256(update_file) == entry['sha256'], 'Invalid update asset')
        shutil.copy2(update_file, output / update_file.name)
        require(sha256(output / update_file.name) == entry['sha256'], 'Copied update asset changed')
source = output / f'Meki-{version}-source.zip'
with zipfile.ZipFile(args.source_archive) as archive:
    names = [name for name in archive.namelist() if not name.endswith('/')]
    require(len(set(names)) == len(names), 'Duplicate source archive entries')
    forbidden = {'.git', '.env', 'node_modules', 'research', 'evidence', 'publishing', 'test-results', 'release', 'outputs'}
    for name in names:
        parts = pathlib.PurePosixPath(name).parts
        require(parts and not name.startswith('/') and '\\' not in name and '..' not in parts, 'Unsafe source archive path')
        require(not (set(parts) & forbidden) and not any(part.startswith('.env.') for part in parts), 'Non-distributable source archive content')
    require({'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.md'} <= set(names), 'Incomplete source archive')
    package = json.loads(archive.read('package.json'))
    require(package['version'] == version and package['productName'] == 'Meki' and package['license'] == 'MIT', 'Wrong source archive version or license')
    public_readme = archive.read('README.md')
    release_notes = archive.read(f'docs/releases/{version}.md')
shutil.copy2(args.source_archive, source)
require(sha256(source) == sha256(args.source_archive), 'Copied source archive changed')
(output / 'README.md').write_bytes(public_readme)
(output / 'ReleaseNotes.md').write_bytes(release_notes)
verification = {
    'version': version, 'sourceCommit': commit, 'verifiedAt': datetime.now(timezone.utc).isoformat(),
    'ci': ci, 'builds': manifests, 'installedApplicationTests': reports,
    'sourceArchive': {'name': source.name, 'sha256': sha256(source)},
    'limitations': ['Windows installer is unsigned.', 'macOS app is ad-hoc signed, not Developer ID notarized.',
                    'Browser-download quarantine and first-trust prompts are not exercised by CI.'],
}
(output / 'verification.json').write_text(json.dumps(verification, ensure_ascii=False, indent=2) + '\n', 'utf-8')
checksums = [f'{sha256(file)}  {file.name}' for file in sorted(output.iterdir()) if file.is_file()]
(output / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n', 'utf-8')
print(json.dumps({'version': version, 'sourceCommit': commit, 'ci': ci['url'], 'output': str(output),
                  'installers': [file.name for file in installers.values()]}, ensure_ascii=False, indent=2))
