// Tests for scripts/release-pin.mjs (EP-1747 phase 5): input validation, where
// each manifest takes its pin, and what the commit may contain.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  addCommand,
  apply,
  commitMessage,
  dependencyField,
  ownerOf,
  parsePins,
  releaseFromBranch,
  workspacePackages,
} from '../scripts/release-pin.mjs';

test('only a Release branch is accepted', () => {
  assert.deepEqual(releaseFromBranch('release/RL-7'), { release: 'RL-7', n: 7 });
  for (const branch of ['main', 'staging', 'release/0.2.0', 'release/RL-07', 'release/RL-7-x', 'refs/heads/release/RL-7', 'release/RL-', '']) {
    assert.throws(() => releaseFromBranch(branch), /refusing branch/, branch);
  }
});

test('pins are exact revt-eng versions, prereleases only from the same Release', () => {
  assert.deepEqual(parsePins('@revt-eng/schema@0.1.562-rl.7.40  @revturbine/sdk@0.17.1', 7), [
    { name: '@revt-eng/schema', version: '0.1.562-rl.7.40' },
    { name: '@revturbine/sdk', version: '0.17.1' },
  ]);
  const refused = {
    'left-pad@1.3.0': /not a revt-eng package/,
    '@revturbine/other@1.0.0': /not a revt-eng package/,
    '@revt-eng/schema@^0.1.562': /exact/,
    '@revt-eng/schema@latest': /exact/,
    '@revt-eng/schema@rl-7': /exact/,
    '@revt-eng/schema@0.1': /exact/,
    '@revt-eng/schema@0.1.562+build.1': /exact/,
    '@revt-eng/schema': /not a revt-eng package/,
    '@revt-eng/schema@0.1.562-rl.6.40': /one of RL-7's/,
    '@revt-eng/schema@0.1.562-beta.1': /one of RL-7's/,
    '@revt-eng/schema@0.1.562;rm -rf /': /exact/,
    '@revt-eng/a@1.0.0 @revt-eng/a@1.0.1': /given twice/,
    '': /no package given/,
  };
  for (const [text, error] of Object.entries(refused)) assert.throws(() => parsePins(text, 7), error, text);
});

test('the commit message names every pin and the Release', () => {
  assert.equal(commitMessage([{ name: '@revt-eng/sdk', version: '0.17.1-rl.7.3' }], 'RL-7'), 'Pin @revt-eng/sdk@0.17.1-rl.7.3 for RL-7');
  assert.equal(commitMessage([{ name: 'a', version: '1.0.0' }, { name: 'b', version: '2.0.0' }], 'RL-7'), 'Pin a@1.0.0, b@2.0.0 for RL-7');
});

test('a pin keeps the dependency field and skips peer-only and protocol specifiers', () => {
  assert.equal(dependencyField({ devDependencies: { '@revturbine/cli': '0.19.1' } }, '@revturbine/cli'), 'devDependencies');
  assert.equal(dependencyField({ dependencies: { '@revt-eng/schema': 'workspace:*' } }, '@revt-eng/schema'), null);
  assert.equal(dependencyField({ peerDependencies: { '@revt-eng/schema': '0.1.0' } }, '@revt-eng/schema'), null);
  assert.equal(dependencyField({}, '@revt-eng/schema'), null);
});

test('pnpm workspace package lists parse in block and inline form', () => {
  assert.deepEqual(workspacePackages("packages:\n  - web-sdk\n  - 'server-node'\nshamefullyHoist: true\n"), ['web-sdk', 'server-node']);
  assert.deepEqual(workspacePackages('packages: []\n'), []);
  assert.deepEqual(workspacePackages("packages: ['apps/*']\n"), ['apps/*']);
  assert.deepEqual(workspacePackages('useNodeVersion: 24.21.0\n'), []);
});

function repo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-pin-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'core.autocrlf=false', 'add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return root;
}

test('each manifest directory takes the pin through the lockfile that covers it', () => {
  const root = repo({
    'package.json': { name: 'root' },
    'pnpm-lock.yaml': '',
    'pnpm-workspace.yaml': 'packages:\n  - web-sdk\n',
    'web-sdk/package.json': { name: 'web-sdk' },
    'pages-build/package.json': { name: 'pages' },
    'pages-build/pnpm-lock.yaml': '',
    'pages-build/pnpm-workspace.yaml': 'packages: []\n',
    'examples/app/package.json': { name: 'app' },
    'examples/app/package-lock.json': '{}',
    'loose/package.json': { name: 'loose' },
  });
  assert.deepEqual(ownerOf(root, '.'), { pm: 'pnpm', workspaceRoot: true });
  assert.deepEqual(ownerOf(root, 'web-sdk'), { pm: 'pnpm', workspaceRoot: false });
  assert.deepEqual(ownerOf(root, 'pages-build'), { pm: 'pnpm', workspaceRoot: true });
  assert.deepEqual(ownerOf(root, 'examples/app'), { pm: 'npm' });
  assert.deepEqual(ownerOf(root, 'loose'), { pm: null });
  assert.deepEqual(addCommand({ pm: 'pnpm', workspaceRoot: true }, 'dependencies', ['a@1.0.0']), ['pnpm', ['add', '--save-exact', '--ignore-scripts', '--save-prod', '--workspace-root', 'a@1.0.0']]);
  assert.deepEqual(addCommand({ pm: 'npm' }, 'devDependencies', ['a@1.0.0']), ['npm', ['install', '--save-exact', '--ignore-scripts', '--save-dev', 'a@1.0.0']]);
});

// A fake package manager: rewrites the spec in package.json and touches the lockfile, as an exact add would.
function fakeAdd(root, calls, extra) {
  return (command, args, { cwd }) => {
    calls.push([path.relative(root, cwd).replaceAll('\\', '/') || '.', command, ...args]);
    const file = path.join(cwd, 'package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    for (const spec of args.filter((arg) => arg.includes('@') && !arg.startsWith('-'))) {
      const at = spec.lastIndexOf('@');
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        if (manifest[field]?.[spec.slice(0, at)]) manifest[field][spec.slice(0, at)] = spec.slice(at + 1);
      }
    }
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    const name = command === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
    const lock = existsSync(path.join(cwd, name)) ? path.join(cwd, name) : path.join(root, name); // a workspace member's lock is the root's
    writeFileSync(lock, `${readFileSync(lock, 'utf8')}# ${args.join(' ')}\n`);
    extra?.(cwd);
    return { status: 0 };
  };
}

test('apply pins every manifest that depends on the package and reports only manifests and lockfiles', () => {
  const root = repo({
    'package.json': { name: 'root', dependencies: { '@revt-eng/schema': '0.1.561' } },
    'pnpm-lock.yaml': '',
    'pnpm-workspace.yaml': 'packages:\n  - web-sdk\n',
    'web-sdk/package.json': { name: 'web-sdk', devDependencies: { '@revt-eng/schema': '0.1.561' } },
    'loose/package.json': { name: 'loose', dependencies: { '@revt-eng/schema': '0.1.500' } },
    'tests/fixtures/x/package.json': { name: 'fixture', dependencies: { '@revt-eng/schema': '0.0.1' } },
    'README.md': 'readme\n',
  });
  const calls = [];
  const pins = parsePins('@revt-eng/schema@0.1.562-rl.7.40', 7);
  const result = apply({ root, pins, release: 'RL-7', run: fakeAdd(root, calls) });
  assert.deepEqual(calls, [
    ['.', 'pnpm', 'add', '--save-exact', '--ignore-scripts', '--save-prod', '--workspace-root', '@revt-eng/schema@0.1.562-rl.7.40'],
    ['web-sdk', 'pnpm', 'add', '--save-exact', '--ignore-scripts', '--save-dev', '@revt-eng/schema@0.1.562-rl.7.40'],
  ]);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'loose/package.json'), 'utf8')).dependencies['@revt-eng/schema'], '0.1.562-rl.7.40');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'tests/fixtures/x/package.json'), 'utf8')).dependencies['@revt-eng/schema'], '0.0.1');
  assert.deepEqual(result.files, ['loose/package.json', 'package.json', 'pnpm-lock.yaml', 'web-sdk/package.json']);
  assert.equal(result.message, 'Pin @revt-eng/schema@0.1.562-rl.7.40 for RL-7');

  const again = apply({ root, pins, release: 'RL-7', run: fakeAdd(root, []) });
  assert.equal(again.files.length, 4, 'nothing new was run; the earlier changes are still uncommitted');
});

test('apply refuses a package the repository does not depend on, and a change outside manifests and lockfiles', () => {
  const root = repo({ 'package.json': { name: 'root', dependencies: { '@revt-eng/schema': '0.1.561' } }, 'package-lock.json': '{}', 'README.md': 'readme\n' });
  assert.throws(() => apply({ root, pins: parsePins('@revt-eng/core@0.1.562', 7), release: 'RL-7', run: fakeAdd(root, []) }), /not a dependency/);
  const touchReadme = (cwd) => writeFileSync(path.join(cwd, 'README.md'), 'changed\n');
  assert.throws(() => apply({ root, pins: parsePins('@revt-eng/schema@0.1.562', 7), release: 'RL-7', run: fakeAdd(root, [], touchReadme) }), /outside manifests and lockfiles: README\.md/);
});

test('a manifest that already pins the version is left alone', () => {
  const root = repo({ 'package.json': { name: 'root', devDependencies: { '@revturbine/cli': '0.21.20' } }, 'package-lock.json': '{}' });
  const calls = [];
  const result = apply({ root, pins: parsePins('@revturbine/cli@0.21.20', 7), release: 'RL-7', run: fakeAdd(root, calls) });
  assert.deepEqual(calls, []);
  assert.deepEqual(result.files, []);
});
