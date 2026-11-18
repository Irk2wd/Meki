"""Find both tagged builds and stage their exact CI artifacts."""
import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import zipfile
from pathlib import Path, PurePosixPath


def gh(*args):
    return json.loads(subprocess.check_output(['gh', *args], text=True))


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def resolve(tag, triggering_run):
    if not tag:
        tag = 'v' + json.loads(Path('package.json').read_text())['version']
    match = re.fullmatch(r'(?:mekir-)?v(\d+\.\d+\.\d+)', tag)
    if not match:
        print('Waiting for a versioned release tag.')
        return None
    version = match[1]
    release_tag = 'v' + version
    existing = subprocess.run(['gh', 'release', 'view', release_tag, '--json', 'isDraft'], capture_output=True, text=True)
    if existing.returncode == 0 and not json.loads(existing.stdout)['isDraft']:
        print(release_tag + ' is already published.')
        return None

    editions = []
    for product, branch, source_tag in [('Meki', 'main', release_tag), ('mekiR', 'research', 'mekir-' + release_tag)]:
        resolved = subprocess.run(['git', 'rev-parse', '--verify', '--quiet', f'refs/tags/{source_tag}^{{commit}}'],
                                  capture_output=True, text=True)
        if resolved.returncode:
            print(f'Waiting for the {source_tag} tag.')
            return None
        commit = resolved.stdout.strip()
        subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'origin/' + branch], check=True)
        package = json.loads(git('show', f'{commit}:package.json'))
        if (package['version'], package['productName']) != (version, product):
            raise RuntimeError(f'{source_tag} has the wrong package version or edition.')
        git('cat-file', '-e', f'{commit}:docs/releases/{version}.md')
        run = triggering_run if source_tag == tag else ''
        if not run:
            runs = gh('run', 'list', '--workflow', 'ci.yml', '--event', 'push', '--branch', source_tag,
                      '--commit', commit, '--status', 'success', '--limit', '1', '--json', 'databaseId')
            if not runs:
                print(f'Waiting for successful installer validation on {source_tag}.')
                return None
            run = str(runs[0]['databaseId'])
        tested = gh('run', 'view', run, '--json', 'headSha,event,headBranch,status,conclusion')
        if tested != dict(headSha=commit, event='push', headBranch=source_tag, status='completed', conclusion='success'):
            raise RuntimeError(f'Installer run {run} does not match {source_tag}.')
        editions.append(dict(product=product, branch=branch, commit=commit, run=run))
    return dict(version=version, editions=editions)


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
        branch, commit, run = edition['branch'], edition['commit'], edition['run']
        checks = gh('run', 'list', '--workflow', 'checks.yml', '--branch', branch, '--event', 'push',
                    '--commit', commit, '--limit', '1', '--json', 'databaseId')
        if not checks:
            raise RuntimeError(f'Missing source checks for {branch} at {commit}.')
        subprocess.run(['gh', 'run', 'watch', str(checks[0]['databaseId']), '--exit-status', '--interval', '15'], check=True)
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
    resolve_parser.add_argument('tag', nargs='?', default='')
    resolve_parser.add_argument('--run', default='')
    commands.add_parser('stage').add_argument('directory', type=Path)
    args = parser.parse_args()
    if args.command == 'stage':
        stage(json.loads(os.environ['RELEASE_PLAN']), args.directory.resolve())
    else:
        plan = resolve(args.tag, args.run)
        if plan:
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
                output.write(f'version={plan["version"]}\n')
                output.write('plan=' + json.dumps(plan) + '\n')


if __name__ == '__main__':
    main()
