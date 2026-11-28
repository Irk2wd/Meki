"""Select changed editions and stage their exact, tagged CI artifacts."""
import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import zipfile
from pathlib import Path, PurePosixPath
from release_version import VERSION, version_key

EDITIONS = {'Meki': ('main', 'v'), 'mekiR': ('meki-research-dev', 'mekir-v')}
RELEASE_TAG = re.compile(rf'(mekir-)?v({VERSION})')
RELEASE_METADATA = (
    'package.json', 'package-lock.json', 'AGENTS.md', 'docs/releases/**', 'docs/updates.md',
    '.github/workflows/checks.yml', '.github/workflows/ci.yml', '.github/workflows/release.yml',
    'scripts/prepare-release.py', 'scripts/publish-release.py', 'scripts/release_version.py',
)


def gh(*args):
    return json.loads(subprocess.check_output(['gh', *args], text=True))


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def tag_commit(tag):
    result = subprocess.run(['git', 'rev-parse', '--verify', '--quiet', f'refs/tags/{tag}^{{commit}}'],
                            capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def released_versions():
    repository = os.environ['GH_REPO']
    pages = gh('api', '--paginate', '--slurp', f'repos/{repository}/releases?per_page=100')
    released = {}
    for page in pages:
        for release in page:
            match = RELEASE_TAG.fullmatch(release['tag_name'])
            if not match or not release['published_at'] or release['draft'] or release['prerelease']:
                continue
            research_only, version = match.groups()
            if '-beta.' in version:
                continue
            uploaded = {asset['name'] for asset in release['assets'] if asset['state'] == 'uploaded'}
            for product in EDITIONS:
                if research_only and product == 'Meki':
                    continue
                installers = {f'{product}-{version}-Setup-x64.exe', f'{product}-{version}-macOS-universal.dmg'}
                if uploaded & installers and (product not in released or version_key(version) > version_key(released[product])):
                    released[product] = version
    return released


def package_content(commit, filename):
    package = json.loads(git('show', f'{commit}:{filename}'))
    package.pop('version', None)
    package.get('packages', {}).get('', {}).pop('version', None)
    return package


def has_changes(product, commit, released):
    if product not in released:
        return True
    tag = EDITIONS[product][1] + released[product]
    previous = tag_commit(tag)
    if not previous:
        raise RuntimeError(f'Missing the source tag {tag} for the last published {product} version.')
    if previous == commit:
        return False
    paths = [':(exclude)' + name for name in RELEASE_METADATA]
    # Only the branch-name correction in the packaged 1.5.5 README is release housekeeping.
    if product == 'mekiR' and released[product] == '1.5.5':
        original = subprocess.check_output(['git', 'show', f'{previous}:README.md'])
        renamed = original.replace(b'`research`', b'`meki-research-dev`', 1)
        blob = subprocess.check_output(['git', 'hash-object', '--stdin'], input=renamed).decode().strip()
        if git('ls-tree', commit, '--', 'README.md') == f'100644 blob {blob}\tREADME.md':
            paths.append(':(exclude)README.md')
    status = subprocess.run(['git', 'diff', '--quiet', '--no-ext-diff', previous, commit, '--', '.', *paths]).returncode
    if status not in (0, 1):
        raise RuntimeError(f'Could not compare {product} with {tag}.')
    return status == 1 or any(package_content(previous, name) != package_content(commit, name)
                              for name in ('package.json', 'package-lock.json'))


def resolve(tag):
    match = RELEASE_TAG.fullmatch(tag)
    if not match:
        raise RuntimeError('Provide a release tag such as vX.Y.Z or mekir-vX.Y.Z-beta.N.')
    research_only, version = match.groups()
    product = 'mekiR' if research_only else 'Meki'
    released = released_versions()
    if product in released and version_key(version) <= version_key(released[product]):
        print(f'{product} {released[product]} is already published. Prepare a newer version to release again.')
        return None

    commit = tag_commit(tag)
    if not commit:
        print(f'Waiting for the {tag} tag.')
        return None
    heads = {product: git('rev-parse', f'origin/{branch}') for product, (branch, _) in EDITIONS.items()}
    heads[product] = commit
    selected = [name for name, head in heads.items() if has_changes(name, head, released)]
    if product not in selected:
        print(f'{tag} contains no unpublished {product} changes.')
        return None
    for name in selected:
        if name in released and version_key(version) <= version_key(released[name]):
            raise RuntimeError(f'A joint release must be newer than {name} {released[name]}. Use a new shared version.')

    editions = []
    for name in selected:
        branch, prefix = EDITIONS[name]
        source_tag = prefix + version
        source = commit if source_tag == tag else tag_commit(source_tag)
        if not source:
            print(f'Waiting for the {source_tag} tag.')
            return None
        subprocess.run(['git', 'merge-base', '--is-ancestor', source, 'origin/' + branch], check=True)
        if source != heads[name] and not has_changes(name, source, released):
            raise RuntimeError(f'{source_tag} contains no unpublished {name} changes. Prepare both editions at a new shared version.')
        package = json.loads(git('show', f'{source}:package.json'))
        if (package['version'], package['productName']) != (version, name):
            raise RuntimeError(f'{source_tag} has the wrong package version or edition.')
        git('cat-file', '-e', f'{source}:docs/releases/{version}.md')
        runs = gh('run', 'list', '--workflow', 'ci.yml', '--event', 'push', '--branch', source_tag,
                  '--commit', source, '--status', 'success', '--limit', '1', '--json', 'databaseId')
        if not runs:
            print(f'Waiting for successful installer validation on {source_tag}.')
            return None
        run = str(runs[0]['databaseId'])
        tested = gh('run', 'view', run, '--json', 'headSha,event,headBranch,status,conclusion')
        if tested != dict(headSha=source, event='push', headBranch=source_tag, status='completed', conclusion='success'):
            raise RuntimeError(f'Installer run {run} does not match {source_tag}.')
        editions.append(dict(product=name, tag=source_tag, commit=source, run=run))
    target_tag = ('v' if 'Meki' in selected else 'mekir-v') + version
    print(f'Preparing {target_tag} for ' + ' and '.join(selected) + '.')
    return dict(version=version, tag=target_tag, editions=editions)


def download_artifacts(output, run, commit):
    repository = os.environ['GH_REPO']
    pages = gh('api', '--paginate', '--slurp', f'repos/{repository}/actions/runs/{run}/artifacts?per_page=100')
    artifacts = [item for page in pages for item in page['artifacts'] if not item['expired']]
    names = ['installer-windows', 'installer-macos', 'installer-evidence-win32-x64',
             'installer-evidence-darwin-arm64', 'installer-evidence-darwin-x64']
    output.mkdir()
    for name in names:
        matching = [item for item in artifacts if item['name'] == name]
        if not matching:
            raise RuntimeError(f'Missing {name} in run {run}.')
        item = max(matching, key=lambda artifact: (artifact['created_at'], artifact['id']))
        if item['workflow_run']['id'] != int(run) or item['workflow_run']['head_sha'] != commit:
            raise RuntimeError(f'{name} did not come from the tested commit.')
        archive = output / (name + '.zip')
        with archive.open('wb') as stream:
            subprocess.run(['gh', 'api', f'repos/{repository}/actions/artifacts/{item["id"]}/zip'], stdout=stream, check=True)
        with archive.open('rb') as stream:
            if item['digest'] != 'sha256:' + hashlib.file_digest(stream, 'sha256').hexdigest():
                raise RuntimeError(f'Digest mismatch for {name}.')
        with zipfile.ZipFile(archive) as contents:
            for entry in contents.infolist():
                path = PurePosixPath(entry.filename)
                if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or stat.S_ISLNK(entry.external_attr >> 16):
                    raise RuntimeError(f'Unsafe ZIP entry in {name}.')
            contents.extractall(output / name)
        archive.unlink()
        print(f'Verified {name} from run {run}.')


def stage(plan, directory):
    directory.mkdir()
    for edition in plan['editions']:
        commit, run = edition['commit'], edition['run']
        output = directory / edition['product']
        output.mkdir()
        source = output / 'source'
        subprocess.run(['git', 'worktree', 'add', '--detach', str(source), commit], check=True)
        download_artifacts(output / 'ci-artifacts', run, commit)
        ci = gh('run', 'view', run, '--json', 'headSha,url,status,conclusion,jobs')
        (output / 'installer-ci.json').write_text(json.dumps(ci) + '\n', encoding='utf-8')
        git('-C', str(source), 'archive', '--format=zip', f'--output={output / "source.zip"}', 'HEAD')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    resolve_parser = commands.add_parser('resolve')
    resolve_parser.add_argument('tag')
    commands.add_parser('stage').add_argument('directory', type=Path)
    args = parser.parse_args()
    if args.command == 'stage':
        stage(json.loads(os.environ['RELEASE_PLAN']), args.directory.resolve())
    else:
        plan = resolve(args.tag)
        if plan:
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
                output.write(f'version={plan["version"]}\n')
                output.write('plan=' + json.dumps(plan) + '\n')


if __name__ == '__main__':
    main()
