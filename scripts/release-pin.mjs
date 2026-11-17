#!/usr/bin/env node
// Release pins (EP-1747 phase 5): set one or more revt-eng packages to a version
// on a Release branch, with the lockfile, for .github/workflows/release-pin.yml.
// Backlog dispatches that workflow when a producer in the same Release publishes
// a prerelease (and, at the merge walk, its final version), because it cannot
// regenerate a lockfile over REST.
//
//   check  Validate the inputs and print the Release: the branch must be
//          release/RL-<n>; each package must be a revt-eng package at an exact
//          version, and a prerelease must be one of this Release's (-rl.<n>.<k>).
//   apply  In the checkout, pin every directory whose package.json already
//          depends on the package (a pin never adds a dependency), keeping the
//          dependency's field. What the manifest ends up with:
//            - a prerelease: exactly that version;
//            - a release where the manifest was exact: exactly that version;
//            - a release where the manifest held a range: the same range with
//              the version as its lower bound, e.g. ">=0.12.5 <1" pinned to
//              0.13.0 becomes ">=0.13.0 <1"; the lockfile resolves the version.
//          A prerelease pinned over a range records the range in
//          .release-pins.json at the root of the Release branch, so the final
//          version, pinned at the merge walk, gets the range back (and the record
//          is removed; the file goes when it is empty). A pin never moves back:
//          two builds of this Release compare by build number <k> (a reverted
//          version bump makes a newer build's version lower), anything else by
//          semver, and a release below a range's lower bound is refused. After
//          the package manager runs, the lockfile must resolve exactly the pinned
//          version. A directory with its own lockfile, or a member of a pnpm
//          workspace, gets the package manager's exact add (then, for a range, a
//          lockfile-only install after the range is written back); a manifest no
//          lockfile covers gets its specifier set. Lifecycle scripts never run.
//          Writes the changed files and the commit message to --out, and refuses
//          a change outside manifests, lockfiles and pnpm-workspace.yaml (pnpm 11
//          records a just-published version there). With --bundle <dir> it also
//          copies the changed files there with a manifest (the Release branch
//          head it pinned, the pins, which files it deleted): the artifact the
//          push job takes. The package manager runs with no lifecycle scripts, no
//          .pnpmfile.cjs and the runner's own git.
//   package-manager
//          Print the packageManager to install for the checkout at --dir, as
//          name@version, or nothing when it declares none; refuse anything but a
//          released npm, pnpm or yarn (corepack's +sha hash allowed, then dropped).
//   commit The push job's half. It runs no code from the Release branch: given a
//          bare repository holding only the branch head (--git-dir, --tip) and
//          the bundle, it checks that the bundle was pinned on that head (else
//          prints {"moved":true}), that it holds only pinnable files, that each
//          package.json differs from the head only in the dependencies being
//          pinned, each set to what `apply` would write, that .release-pins.json
//          and pnpm-workspace.yaml change only for the pinned packages, and that
//          the pins are the ones it was given. It then writes the commit with git
//          plumbing (no checkout, no hooks) and prints {"sha":...}. Author and
//          committer come from GIT_AUTHOR_* / GIT_COMMITTER_*. Lockfile entries are
//          checked against the registry; if a pinned package's registry entry
//          cannot be read it commits nothing and exits 75, so the workflow
//          tries again on its next attempt. A pnpm-lock.yaml is read only in
//          the exact form pnpm writes (pnpmFormRefusal), on the branch and in
//          the bundle. Which peers of a @revt-eng package it marks optional is
//          checked against the package's own package.json, from the tarball
//          the lockfile names, downloaded and hashed here (exit 75 as well
//          when that cannot be read).
//
// Identical copies live in every repository with release-pin.yml; change them
// together.
//
// Usage:
//   node scripts/release-pin.mjs check --branch release/RL-<n> --packages "<name>@<version> ..."
//   node scripts/release-pin.mjs apply --branch release/RL-<n> --packages "<name>@<version> ..." [--dir <checkout>] [--out <file>] [--bundle <dir>]
//   node scripts/release-pin.mjs package-manager [--dir <checkout>]
//   node scripts/release-pin.mjs commit --branch release/RL-<n> --packages "<name>@<version> ..." --git-dir <bare> --tip <sha> --bundle <dir>

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const RELEASE_BRANCH = /^release\/RL-([1-9][0-9]*)$/;
const SCOPED = /^@revt-eng\/[a-z0-9][a-z0-9._-]*$/;
/** revt-eng packages outside the @revt-eng scope (the public npm ones). */
export const KNOWN_PACKAGES = ['@revturbine/cli', '@revturbine/sdk', 'create-revturbine', 'revturbine'];
const EXACT = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
/** A version inside a range may be partial ("1", "1.2"); missing parts are 0. */
const PARTIAL = /^v?(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?(?:\.(0|[1-9][0-9]*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const PINNABLE_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
/** Ranges replaced by a prerelease pin, by manifest and package, so the final pin can restore them. */
export const PINS_FILE = '.release-pins.json';
/** A packageManager the pin job installs: a released npm, pnpm or yarn, optionally with corepack's hash. */
export const PACKAGE_MANAGER = /^(npm|pnpm|yarn)@\d+\.\d+\.\d+(\+sha\d+\.[A-Za-z0-9+/=]+)?$/;

export function releaseFromBranch(branch) {
  const match = RELEASE_BRANCH.exec(String(branch ?? ''));
  if (!match) throw new Error(`refusing branch ${JSON.stringify(branch)}: pins go only to a Release branch, release/RL-<n>`);
  return { release: `RL-${Number(match[1])}`, n: Number(match[1]) };
}

/** Parse "name@version name@version" into pins, refusing anything that is not an exact revt-eng version for this Release. */
export function parsePins(text, n) {
  const specs = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!specs.length) throw new Error('no package given (expected name@exact-version)');
  const pins = specs.map((spec) => {
    const at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : '';
    const version = at > 0 ? spec.slice(at + 1) : '';
    if (!SCOPED.test(name) && !KNOWN_PACKAGES.includes(name)) {
      throw new Error(`refusing ${JSON.stringify(spec)}: not a revt-eng package (@revt-eng/* or ${KNOWN_PACKAGES.join(', ')})`);
    }
    const match = EXACT.exec(version);
    if (!match) throw new Error(`refusing ${JSON.stringify(spec)}: the version must be exact (X.Y.Z or X.Y.Z-rl.<n>.<k>), not a range or tag`);
    if (match[4] !== undefined && !new RegExp(`^rl\\.${n}\\.[1-9][0-9]*$`).test(match[4])) {
      throw new Error(`refusing ${JSON.stringify(spec)}: a prerelease pinned on release/RL-${n} must be one of RL-${n}'s (-rl.${n}.<k>)`);
    }
    return { name, version };
  });
  if (new Set(pins.map((p) => p.name)).size !== pins.length) throw new Error('a package is given twice');
  return pins;
}

/** True for a version with a prerelease part. */
export function isPrerelease(version) {
  const match = EXACT.exec(String(version ?? ''));
  return Boolean(match && match[4] !== undefined);
}

/** Semver precedence: negative when a sorts before b, 0 when equal, positive after. */
export function compareSemver(a, b) {
  const pa = EXACT.exec(String(a ?? ''));
  const pb = EXACT.exec(String(b ?? ''));
  if (!pa || !pb) throw new Error(`not a semver version: ${JSON.stringify(pa ? b : a)}`);
  for (let i = 1; i <= 3; i += 1) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  if (pa[4] === undefined || pb[4] === undefined) return (pa[4] === undefined ? 1 : 0) - (pb[4] === undefined ? 1 : 0);
  const xa = pa[4].split('.');
  const xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i += 1) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^[0-9]+$/.test(xa[i]);
    const nb = /^[0-9]+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) - Number(xb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (!na && xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

function fullVersion(partial) {
  const match = PARTIAL.exec(partial);
  if (!match) return null;
  return `${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}${match[4] !== undefined ? `-${match[4]}` : ''}`;
}

/**
 * A range with `version` as its lower bound, keeping its form and upper bound:
 * ^A -> ^V, ~A -> ~V, >=A or >A -> >=V (any < or <= bound kept), A - B -> V - B.
 * Refuses a union (||), wildcards, a range without exactly one lower bound, a
 * version below the current lower bound, and one the upper bound excludes.
 */
export function raiseLowerBound(range, version) {
  const text = String(range ?? '');
  const refuse = (why) => new Error(`cannot move the range ${JSON.stringify(text)} to ${version}: ${why}; pin it by hand`);
  if (text.includes('||')) throw refuse('it is a union of ranges');
  const hyphen = /^(\s*)(\S+)(\s+-\s+)(\S+)(\s*)$/.exec(text);
  if (hyphen) {
    const lower = fullVersion(hyphen[2]);
    const upper = EXACT.test(hyphen[4]) ? hyphen[4] : null;
    if (!lower || !upper) throw refuse('a hyphen range needs full versions');
    if (compareSemver(version, lower) < 0) throw refuse(`that is below its lower bound ${lower}`);
    if (compareSemver(version, upper) > 0) throw refuse(`that is above its upper bound ${upper}`);
    return `${hyphen[1]}${version}${hyphen[3]}${hyphen[4]}${hyphen[5]}`;
  }
  const parts = text.split(/(\s+)/);
  let lowerAt = -1;
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i] || /^\s+$/.test(parts[i])) continue;
    const comparator = /^(\^|~|>=|>|<=|<)(.+)$/.exec(parts[i]);
    const bound = comparator && fullVersion(comparator[2]);
    if (!comparator || !bound) throw refuse(`"${parts[i]}" is not a comparator this pin understands`);
    const [, op] = comparator;
    if (['^', '~', '>=', '>'].includes(op)) {
      if (lowerAt >= 0) throw refuse('it has more than one lower bound');
      lowerAt = i;
      if (compareSemver(version, bound) < 0) throw refuse(`that is below its lower bound ${bound}`);
    } else if (op === '<' ? compareSemver(version, bound) >= 0 : compareSemver(version, bound) > 0) {
      throw refuse(`its upper bound ${parts[i]} excludes it`);
    }
  }
  if (lowerAt < 0) throw refuse('it has no lower bound');
  const op = /^(\^|~|>=|>)/.exec(parts[lowerAt])[1];
  parts[lowerAt] = `${op === '>' ? '>=' : op}${version}`;
  return parts.join('');
}

/**
 * The specifier a manifest gets for a pin: the exact version for a prerelease or
 * where the manifest was already exact; otherwise its range, raised to the version.
 */
export function pinnedSpec(current, version) {
  if (isPrerelease(version) || EXACT.test(String(current ?? '').trim())) return version;
  return raiseLowerBound(current, version);
}

/** The Release build a version is: <x.y.z>-rl.<n>.<k> -> { n, k }, else null. */
export function releaseBuild(version) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rl\.([1-9][0-9]*)\.([1-9][0-9]*)$/.exec(String(version ?? ''));
  return match ? { n: Number(match[4]), k: Number(match[5]) } : null;
}

/**
 * Why a pin would move an exact specifier back, or null. Two builds of one
 * Release compare by build number <k>: a reverted version bump makes a newer
 * build's version lower, so semver would call it older. Anything else (another
 * Release, a prerelease against a release, two releases) compares by semver.
 * A range is not compared here: raiseLowerBound refuses lowering it.
 */
export function backwardsRefusal(current, version, n, where) {
  if (!EXACT.test(String(current ?? '')) || current === version) return null;
  const was = releaseBuild(current);
  const now = releaseBuild(version);
  if (was && now && was.n === now.n) {
    if (now.k >= was.k) return null;
    return `refusing to pin ${where} back from ${current} to ${version}: build ${was.k} of RL-${was.n} is later than build ${now.k}, and a pin never moves back`;
  }
  if (compareSemver(version, current) >= 0) return null;
  return `refusing to pin ${where} back from ${current} to ${version}: ${current} is later, and a pin never moves back`;
}

/** The ranges recorded on this branch: { "<dir>/package.json": { "<package>": "<range>" } }. */
export function readPinRecords(root) {
  const file = path.join(root, PINS_FILE);
  if (!existsSync(file)) return {};
  const records = JSON.parse(readFileSync(file, 'utf8'));
  if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error(`${PINS_FILE} is not an object`);
  return records;
}

/**
 * What a pin writes, and what it records. A prerelease over a range writes the
 * version and records the range (unless one is recorded already); a release
 * restores a recorded range, or keeps the manifest's own, with the version as its
 * lower bound, and drops the record; an exact specifier stays exact.
 */
export function planPin(current, version, recorded) {
  if (isPrerelease(version)) {
    const range = recorded ?? (EXACT.test(String(current ?? '').trim()) ? undefined : current);
    return { spec: version, record: range };
  }
  const base = recorded ?? current;
  return { spec: pinnedSpec(base, version), record: undefined };
}

/** The version a lockfile resolves for a dependency of one importer, or null. */
export function lockedVersion(lock, name) {
  if (lock.pm === 'npm') {
    const data = JSON.parse(lock.text);
    return data.packages?.[`node_modules/${name}`]?.version ?? data.dependencies?.[name]?.version ?? null;
  }
  // pnpm-lock.yaml (v9): importers: / <importer>: / <field>: / <name>: / version: <v>(peers)
  const lines = lock.text.split(/\r?\n/);
  const unquote = (value) => value.trim().replace(/^['"]|['"]$/g, '');
  let i = lines.findIndex((line) => /^importers:\s*$/.test(line));
  if (i < 0) return null;
  for (i += 1; i < lines.length && !/^\S/.test(lines[i]); i += 1) {
    const importer = /^ {2}(\S.*?):\s*$/.exec(lines[i]);
    if (!importer || unquote(importer[1]) !== lock.importer) continue;
    for (let j = i + 1; j < lines.length && !/^ {0,2}\S/.test(lines[j]); j += 1) {
      const dep = /^ {6}(\S.*?):\s*$/.exec(lines[j]);
      if (!dep || unquote(dep[1]) !== name) continue;
      for (let m = j + 1; m < lines.length && /^ {8}/.test(lines[m]); m += 1) {
        const version = /^ {8}version:\s*(.+)$/.exec(lines[m]);
        if (version) return unquote(version[1]).replace(/\(.*$/, '');
      }
    }
    return null;
  }
  return null;
}

/** Set one dependency's specifier in a package.json, keeping its indentation. */
function setSpecifier(file, field, name, spec) {
  const text = readFileSync(file, 'utf8');
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  ';
  const manifest = JSON.parse(text);
  manifest[field][name] = spec;
  writeFileSync(file, `${JSON.stringify(manifest, null, indent)}${text.endsWith('\n') ? '\n' : ''}`);
}

/** The commit message: "Pin <pkg>@<ver> for RL-<n>", several joined with commas. */
export function commitMessage(pins, release) {
  return `Pin ${pins.map((p) => `${p.name}@${p.version}`).join(', ')} for ${release}`;
}

/** Which dependency field of a manifest holds a package, or null (peer-only, protocol specifiers and absence are null). */
export function dependencyField(manifest, name) {
  for (const field of FIELDS) {
    const spec = manifest?.[field]?.[name];
    if (typeof spec === 'string' && !/^(workspace|file|link|portal|git|github|https?):/.test(spec)) return field;
  }
  return null;
}

/** The directories a pnpm-workspace.yaml `packages:` list names (plain paths and one trailing `/*` or `/**`). */
export function workspacePackages(yaml) {
  const lines = String(yaml ?? '').split(/\r?\n/);
  const at = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (at < 0) return [];
  const inline = lines[at].replace(/^packages\s*:/, '').trim();
  if (inline.startsWith('[')) return inline.replace(/[[\]'"]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const globs = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break;
    const item = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line);
    if (item) globs.push(item[1].trim());
  }
  return globs;
}

function matchesWorkspace(relative, globs) {
  return globs.some((glob) => {
    if (glob.startsWith('!')) return false;
    const clean = glob.replace(/^\.\//, '').replace(/\/$/, '');
    if (clean.endsWith('/**')) return relative.startsWith(`${clean.slice(0, -3)}/`);
    if (clean.endsWith('/*')) return path.posix.dirname(relative) === clean.slice(0, -2);
    return relative === clean;
  });
}

/** How a manifest directory takes the pin: its own pnpm or npm lockfile, a pnpm workspace member, or none. */
export function ownerOf(root, dir) {
  const abs = path.join(root, dir);
  if (existsSync(path.join(abs, 'pnpm-lock.yaml'))) return { pm: 'pnpm', workspaceRoot: existsSync(path.join(abs, 'pnpm-workspace.yaml')), lock: path.posix.join(dir, 'pnpm-lock.yaml'), importer: '.' };
  if (existsSync(path.join(abs, 'npm-shrinkwrap.json'))) return { pm: 'npm', lock: path.posix.join(dir, 'npm-shrinkwrap.json'), importer: '.' };
  if (existsSync(path.join(abs, 'package-lock.json'))) return { pm: 'npm', lock: path.posix.join(dir, 'package-lock.json'), importer: '.' };
  let parent = dir;
  while (parent !== '.') {
    parent = path.posix.dirname(parent);
    const workspace = path.join(root, parent, 'pnpm-workspace.yaml');
    if (existsSync(workspace) && existsSync(path.join(root, parent, 'pnpm-lock.yaml'))) {
      const relative = path.posix.relative(parent === '.' ? '' : parent, dir);
      if (matchesWorkspace(relative, workspacePackages(readFileSync(workspace, 'utf8')))) {
        return { pm: 'pnpm', workspaceRoot: false, lock: path.posix.join(parent, 'pnpm-lock.yaml'), importer: relative };
      }
    }
  }
  return { pm: null };
}

/**
 * What every package manager run gets: no lifecycle scripts, and git from PATH rather than whatever a checked-in
 * .npmrc names; pnpm also skips .pnpmfile.cjs hooks. The Release branch is not trusted to run code.
 */
const PNPM_SAFE = ['--ignore-scripts', '--ignore-pnpmfile', '--config.git=git'];
const NPM_SAFE = ['--ignore-scripts', '--git=git'];

/** The lockfile-only install that settles a range written back after the exact add resolved the version. */
export function lockfileCommand(owner) {
  if (owner.pm === 'pnpm') return ['pnpm', ['install', '--lockfile-only', '--no-frozen-lockfile', ...PNPM_SAFE]];
  if (owner.pm === 'npm') return ['npm', ['install', '--package-lock-only', ...NPM_SAFE]];
  throw new Error(`no package manager for ${JSON.stringify(owner)}`);
}

/** The package manager command that pins `specs` in one field. */
export function addCommand(owner, field, specs) {
  const flag = { dependencies: '--save-prod', devDependencies: '--save-dev', optionalDependencies: '--save-optional' }[field];
  if (owner.pm === 'pnpm') return ['pnpm', ['add', '--save-exact', ...PNPM_SAFE, flag, ...(owner.workspaceRoot ? ['--workspace-root'] : []), ...specs]];
  if (owner.pm === 'npm') return ['npm', ['install', '--save-exact', ...NPM_SAFE, flag, ...specs]];
  throw new Error(`no package manager for ${JSON.stringify(owner)}`);
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

/** Tracked package.json files, minus vendored and fixture trees. */
export function trackedManifests(root) {
  return git(root, ['ls-files', '-z', '--', 'package.json', '**/package.json'])
    .split('\0')
    .filter(Boolean)
    .filter((file) => !/(^|\/)(node_modules|fixtures?|__fixtures__)\//.test(file));
}

/** Pin every package in the checkout at `root` (see the header). */
export function apply({ root, pins, release, run = spawnSync }) {
  const { n } = releaseFromBranch(`release/${release}`);
  const records = readPinRecords(root);
  const recordsBefore = JSON.stringify(records);
  const targets = new Map();
  const found = new Set();
  for (const file of trackedManifests(root)) {
    const manifest = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
    for (const pin of pins) {
      const field = dependencyField(manifest, pin.name);
      if (!field) continue;
      found.add(pin.name);
      const dir = path.posix.dirname(file);
      if (!targets.has(dir)) targets.set(dir, []);
      const current = manifest[field][pin.name];
      const backwards = backwardsRefusal(current, pin.version, n, `${pin.name} in ${dir === '.' ? '' : `${dir}/`}package.json`);
      if (backwards) throw new Error(backwards);
      const { spec, record } = planPin(current, pin.version, records[file]?.[pin.name]);
      if (record === undefined) {
        if (records[file]) delete records[file][pin.name];
        if (records[file] && !Object.keys(records[file]).length) delete records[file];
      } else {
        records[file] = { ...records[file], [pin.name]: record };
      }
      targets.get(dir).push({ ...pin, field, current, spec });
    }
  }
  const missing = pins.filter((pin) => !found.has(pin.name));
  if (missing.length) throw new Error(`refusing to add a dependency: ${missing.map((p) => p.name).join(', ')} is not a dependency of any package.json here`);

  const exec = (dir, [command, args]) => {
    console.log(`${dir}: ${command} ${args.join(' ')}`);
    const result = run(command, args, { cwd: path.join(root, dir), stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${dir} (exit ${result.status})`);
  };
  for (const [dir, entries] of targets) {
    const pending = entries.filter((entry) => entry.current !== entry.spec);
    if (!pending.length) {
      console.log(`${dir}: already pins ${entries.map((e) => `${e.name}@${e.spec}`).join(', ')}`);
      continue;
    }
    const file = path.join(root, dir, 'package.json');
    const owner = ownerOf(root, dir);
    if (!owner.pm) {
      for (const entry of pending) setSpecifier(file, entry.field, entry.name, entry.spec);
      console.log(`${dir}: no lockfile covers it; set ${pending.map((e) => `${e.name}@${e.spec}`).join(', ')} in package.json`);
      continue;
    }
    for (const field of FIELDS) {
      const specs = pending.filter((entry) => entry.field === field).map((entry) => `${entry.name}@${entry.version}`);
      if (specs.length) exec(dir, addCommand(owner, field, specs));
    }
    const ranged = pending.filter((entry) => entry.spec !== entry.version);
    if (ranged.length) {
      for (const entry of ranged) setSpecifier(file, entry.field, entry.name, entry.spec);
      exec(dir, lockfileCommand(owner));
    }
    const lock = { pm: owner.pm, importer: owner.importer, text: readFileSync(path.join(root, owner.lock), 'utf8') };
    for (const entry of pending) {
      const locked = lockedVersion(lock, entry.name);
      if (locked !== entry.version) throw new Error(`${owner.lock} resolves ${entry.name} to ${locked ?? 'nothing'} for ${dir}, not the pinned ${entry.version}`);
    }
  }

  const pinsFile = path.join(root, PINS_FILE);
  const recordsChanged = JSON.stringify(records) !== recordsBefore;
  if (recordsChanged) {
    if (Object.keys(records).length) writeFileSync(pinsFile, `${JSON.stringify(records, null, 2)}\n`);
    else if (existsSync(pinsFile)) rmSync(pinsFile);
  }

  for (const [dir, entries] of targets) {
    const manifest = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
    for (const entry of entries) {
      const now = manifest[entry.field]?.[entry.name];
      if (now !== entry.spec) throw new Error(`${dir}/package.json ${entry.field}.${entry.name} is ${now}, not ${entry.spec}`);
    }
  }

  const changed = new Set();
  const unexpected = [];
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  for (const record of status.split('\0').filter(Boolean)) {
    const file = record.slice(3);
    if (PINNABLE_FILES.has(path.posix.basename(file)) || file === PINS_FILE) changed.add(file);
    else unexpected.push(file);
  }
  if (unexpected.length) throw new Error(`the pin changed files outside manifests and lockfiles: ${unexpected.join(', ')}`);
  // A new .release-pins.json is untracked, so status does not list it.
  if (recordsChanged && existsSync(pinsFile)) changed.add(PINS_FILE);
  return { release, pins, files: [...changed].sort(), message: commitMessage(pins, release) };
}

/** The packageManager to install (name@version, hash dropped), or null when none is declared; anything else is refused. */
export function packageManagerSpec(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !PACKAGE_MANAGER.test(value)) throw new Error(`refusing packageManager ${JSON.stringify(value)}: not a released npm, pnpm or yarn`);
  return value.split('+')[0];
}

/** A path a pin may write: a manifest, a lockfile, pnpm-workspace.yaml or .release-pins.json, inside the tree. */
export function pinnablePath(file) {
  if (typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\') || file.includes('\0')) return false;
  if (file.split('/').some((part) => part === '' || part === '.' || part === '..' || part === '.git' || part === 'node_modules')) return false;
  return PINNABLE_FILES.has(path.posix.basename(file)) || file === PINS_FILE;
}

/** Copy what `apply` changed into `dir`, with the manifest the push job checks. */
export function writeBundle(root, result, dir, base) {
  mkdirSync(path.join(dir, 'files'), { recursive: true });
  const files = result.files.map((file) => {
    if (!pinnablePath(file)) throw new Error(`refusing to bundle ${file}`);
    const deleted = !existsSync(path.join(root, file));
    if (!deleted) {
      mkdirSync(path.dirname(path.join(dir, 'files', file)), { recursive: true });
      copyFileSync(path.join(root, file), path.join(dir, 'files', file));
    }
    return { path: file, deleted };
  });
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ release: result.release, base, pins: result.pins, files }, null, 2)}\n`);
}

/** JSON with sorted keys, so two manifests compare by content, not key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Refusal unless `after` differs from `before` only in the pinned dependencies, each in the field it already had and
 * set to what `apply` writes for it (planPin with the head's record); null when it is a pin.
 */
export function manifestPinRefusal(file, beforeText, afterText, pins, n, records) {
  let before, after;
  try { before = JSON.parse(beforeText); after = JSON.parse(afterText); } catch { return `${file} is not JSON`; }
  const masked = (manifest) => {
    const copy = JSON.parse(JSON.stringify(manifest));
    for (const field of FIELDS) for (const pin of pins) if (copy[field] && Object.hasOwn(copy[field], pin.name)) copy[field][pin.name] = '<pinned>';
    return canonical(copy);
  };
  if (masked(before) !== masked(after)) return `${file} changes more than the pinned dependencies`;
  let changed = false;
  for (const field of FIELDS) {
    for (const pin of pins) {
      if (!before[field] || !Object.hasOwn(before[field], pin.name)) continue;
      const current = before[field][pin.name], now = after[field][pin.name];
      if (now === current) continue;
      const backwards = backwardsRefusal(current, pin.version, n, `${pin.name} in ${file}`);
      if (backwards) return backwards;
      const { spec } = planPin(current, pin.version, records[file]?.[pin.name]);
      if (now !== spec) return `${file} sets ${pin.name} to ${now}, not the pin's ${spec}`;
      changed = true;
    }
  }
  return changed ? null : `${file} is in the bundle but pins nothing`;
}

/**
 * Refusal unless every changed line of a pnpm-workspace.yaml names a pinned package (pnpm 11 lists a just-published
 * version under minimumReleaseAgeExclude, which it may add as a key); null when it does.
 */
export function workspacePinRefusal(file, beforeText, afterText, pins) {
  const count = (text) => { const lines = new Map(); for (const line of text.split('\n')) lines.set(line, (lines.get(line) ?? 0) + 1); return lines; };
  const a = count(beforeText ?? ''), b = count(afterText);
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter((line) => (a.get(line) ?? 0) !== (b.get(line) ?? 0) && line.trim() !== '');
  const stray = changed.find((line) => line !== 'minimumReleaseAgeExclude:' && !pins.some((pin) => line.includes(pin.name)));
  return stray === undefined ? null : `${file} changes a line that names no pinned package: ${stray.trim()}`;
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Refusal unless a lockfile entry's integrity (and tarball, when the lockfile names one) is the registry's for
 * name@version; `registry` maps name -> { [version]: { integrity, tarball } }. Without the package's registry entry
 * nothing is accepted (the commit command stops the attempt before it gets here when a read fails).
 */
export function resolutionRefusal(where, name, version, integrity, tarball, registry) {
  const known = registry?.get(name);
  if (!known) return `${where}: ${name}'s registry entry could not be read, so ${name}@${version} cannot be checked`;
  const dist = known[version];
  if (!dist) return `${where}: the registry has no ${name}@${version}`;
  if (integrity !== dist.integrity) return `${where}: the integrity of ${name}@${version} differs from the registry's`;
  if (tarball !== undefined && tarball !== dist.tarball) return `${where}: ${name}@${version} resolves from ${tarball}, not the registry's ${dist.tarball}`;
  return null;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** The pinned package a package-lock entry key installs (node_modules/<name>, at any depth), or undefined. */
const lockEntryPin = (key, pins) => pins.find((pin) => key === `node_modules/${pin.name}` || key.endsWith(`/node_modules/${pin.name}`));

/**
 * A package-lock.json or npm-shrinkwrap.json change that only re-pins (Backlog's lockfilePins rule, on the parsed
 * file): the same entries; inside a node_modules/<pkg> entry of a pinned package only "version" (to exactly the pin),
 * "resolved" and "integrity" (the registry's) change; elsewhere only the pinned packages' ranges in dependency fields.
 */
export function npmLockRefusal(file, beforeText, afterText, pins, registry) {
  let before, after;
  try { before = JSON.parse(beforeText); after = JSON.parse(afterText); } catch { return `${file} is not JSON`; }
  if (before.lockfileVersion !== 3 || after.lockfileVersion !== 3) return `${file} is not lockfileVersion 3, so its pin cannot be checked`;
  const rest = (lock) => { const others = { ...lock }; delete others.packages; return canonical(others); };
  if (rest(before) !== rest(after)) return `${file} changes more than its packages`;
  const was = before.packages ?? {}, now = after.packages ?? {};
  const keys = Object.keys(was);
  if (canonical(keys.sort()) !== canonical(Object.keys(now).sort())) return `${file} adds or removes entries, which a pin does not`;
  for (const key of keys) {
    const a = was[key], b = now[key];
    const pin = lockEntryPin(key, pins);
    if (pin) {
      const { version: v1, resolved: r1, integrity: i1, ...restA } = a;
      const { version: v2, resolved: r2, integrity: i2, ...restB } = b;
      if (canonical(restA) !== canonical(restB)) return `${file}: ${key} changes more than its version, resolved and integrity`;
      if (v1 === v2 && r1 === r2 && i1 === i2) continue;
      if (v2 !== pin.version) return `${file}: ${key} is ${v2}, not the pinned ${pin.version}`;
      const refused = resolutionRefusal(`${file} ${key}`, pin.name, pin.version, i2, r2, registry);
      if (refused) return refused;
      continue;
    }
    const masked = (entry) => {
      const copy = JSON.parse(JSON.stringify(entry ?? {}));
      for (const field of DEPENDENCY_FIELDS) for (const p of pins) if (copy[field] && Object.hasOwn(copy[field], p.name)) copy[field][p.name] = '<pinned>';
      return canonical(copy);
    };
    if (masked(a) !== masked(b)) return `${file}: ${key || 'the root entry'} changes more than the pinned packages' ranges`;
  }
  return null;
}

/** A pnpm-lock.yaml split into its blocks at one indentation: [{ key, lines }], each block's continuation attached. */
function yamlBlocks(lines, indent) {
  const blocks = [];
  const head = new RegExp(`^ {${indent}}('(?:[^']|'')*'|"[^"]*"|[^\\s'"#][^:]*?):(?:\\s|$)`);
  for (const line of lines) {
    const m = head.exec(line);
    if (m && !line.startsWith(`${' '.repeat(indent)} `)) {
      let key = m[1];
      if (key.startsWith("'")) key = key.slice(1, -1).replace(/''/g, "'");
      else if (key.startsWith('"')) key = key.slice(1, -1);
      blocks.push({ key, lines: [line] });
    } else if (blocks.length) blocks.at(-1).lines.push(line);
    else if (line.trim()) blocks.push({ key: null, lines: [line] });
  }
  for (const block of blocks) while (block.lines.length > 1 && !block.lines.at(-1).trim()) block.lines.pop();
  return blocks;
}
const blockText = (block) => block.lines.map((line) => line.trimEnd()).join('\n');
const byKey = (blocks) => new Map(blocks.map((block) => [block.key, block]));
/** name and version of a pnpm packages/snapshots key: '<name>@<version>' with an optional peer suffix '(...)'. */
function packageKey(key) {
  const at = key.indexOf('@', 1);
  if (at < 0) return null;
  const rest = key.slice(at + 1), paren = rest.indexOf('(');
  return { name: key.slice(0, at), version: paren < 0 ? rest : rest.slice(0, paren) };
}

/**
 * Whether js-yaml, which pnpm writes its lockfile with, writes a string plain (no quotes): not empty, not starting
 * with a YAML indicator, without ": " or " #", and not something YAML reads as a null, boolean, number or date.
 */
function plainScalar(text) {
  if (text === '' || /^[\s\-?:,[\]{}#&*!|=>'"%@`]|\s$|:$| #|: /.test(text)) return false;
  if (/^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|<<)$/.test(text)) return false;
  if (/^[-+]?(?:0b[01_]+|0o?[0-7_]+|0x[0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|\.(?:inf|Inf|INF))$|^\.(?:nan|NaN|NAN)$/.test(text)) return false;
  return !/^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt\s].*)?$/.test(text);
}

/** What a key of a pnpm-lock.yaml is made of: package names, versions, ranges, peer suffixes and importer paths. */
const LOCK_KEY = /^[A-Za-z0-9@._][A-Za-z0-9@/._()+^~<>=*|-]*$/;
/** A plain value inside the one-line `{...}` of resolution and engines: no quotes, commas, brackets or comments. */
const FLOW_PLAIN = String.raw`[^\s,[\]{}#&*!|=>'"%@\`?:-](?:[^\s,[\]{}#:'"]|:(?=[^\s,}])| (?=[^\s,}#:]))*`;
const FLOW_PAIR = new RegExp(String.raw`([A-Za-z][A-Za-z0-9]*|'[0-9]+'): ('(?:[^']|'')*'|${FLOW_PLAIN})(, |\}$)`, 'y');
const FLOW_LIST = /^\[(?:[A-Za-z0-9_.-]+|'[!A-Za-z0-9_.-]+')(?:, (?:[A-Za-z0-9_.-]+|'[!A-Za-z0-9_.-]+'))*\]$/;

/** Why a one-line `{key: value, ...}` is not one pnpm writes (unique keys; plain values only when `plainOnly`), or null. */
function flowMapRefusal(value, plainOnly) {
  const seen = new Set();
  let at = 1;
  if (value[0] !== '{') return 'not a one-line mapping';
  while (at < value.length) {
    FLOW_PAIR.lastIndex = at;
    const pair = FLOW_PAIR.exec(value);
    if (!pair) return 'not a one-line mapping pnpm writes';
    if (seen.has(pair[1])) return `the key ${pair[1]} twice`;
    if (plainOnly && (pair[1].startsWith("'") || pair[2].startsWith("'"))) return 'a quoted key or value in a resolution';
    seen.add(pair[1]);
    at = FLOW_PAIR.lastIndex;
  }
  return null;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const PACKAGE_SHAPES = new Map([['resolution', 'map'], ['engines', 'map'], ['cpu', 'list'], ['os', 'list'], ['libc', 'list'], ['peerDependencies', 'block'],
  ['peerDependenciesMeta', 'block'], ['hasBin', 'scalar'], ['deprecated', 'scalar'], ['bundledDependencies', 'items']]);
const SNAPSHOT_SHAPES = new Map([['dependencies', 'block'], ['optionalDependencies', 'block'], ['transitivePeerDependencies', 'items'], ['optional', 'scalar']]);
/**
 * The one shape pnpm gives a key the check reads, by where it is (`parents`: the keys it is under, from the section
 * down): 'block' (keys on the lines below), 'items' (a list on the lines below), 'scalar', 'map' ({...}), 'list'
 * ([...]) or 'entry' (a block, or `{}`); undefined where the check reads nothing.
 */
function lockShape(parents, key) {
  const [section, , field] = parents, depth = parents.length;
  if (depth === 1) return section === 'packages' ? 'block' : section === 'importers' || section === 'snapshots' ? 'entry' : undefined;
  if (section === 'importers') {
    if (depth === 2) return DEP_FIELDS.includes(key) ? 'block' : undefined;
    return DEP_FIELDS.includes(field) ? (depth === 3 ? 'block' : 'scalar') : undefined;
  }
  if (section === 'packages') {
    if (depth === 2) return PACKAGE_SHAPES.get(key);
    if (field === 'peerDependencies') return 'scalar';
    return field === 'peerDependenciesMeta' ? (depth === 3 ? 'block' : 'scalar') : undefined;
  }
  if (section === 'snapshots') {
    if (depth === 2) return SNAPSHOT_SHAPES.get(key);
    return field === 'dependencies' || field === 'optionalDependencies' ? 'scalar' : undefined;
  }
  return undefined;
}

/**
 * Refusal unless a pnpm-lock.yaml is in the exact form pnpm writes, so that this file's line reader and pnpm's YAML
 * parser cannot read it differently; null when it is. Everything YAML offers beyond this is refused, not parsed:
 *   - LF only, no tab or control character, one final newline, no trailing space; the first line is
 *     `lockfileVersion: '9.0'`; a blank line only before a line indented 0 or 2, never two together;
 *   - every other line is `<key>:` (opening a block, whose first line is indented exactly two more), `<key>: <value>`
 *     or `- <value>`; indentation is in steps of two and a line dedents only to an open block; a block is either all
 *     keys or all list items; a key that opens a block has one (no empty values); no key twice in a block;
 *   - a key is plain or single-quoted, quoted exactly when js-yaml would quote it (in practice: it starts with `@`),
 *     and made of package-name, version, range and path characters only (no colon, space, `#` or quote);
 *   - a value is one plain or single-quoted scalar on its line (plain: no ": ", no " #", no leading indicator, so no
 *     anchor, alias, tag, merge key, comment, block scalar, directive or document marker); `true`, `false` and
 *     integers are the only plain values that are not strings;
 *   - the inline forms, each only where pnpm writes it: `{}` as a whole snapshots or importers entry;
 *     `resolution: {key: plain, ...}` and `engines: {key: plain-or-quoted, ...}` on a packages entry (an engines
 *     key may be a quoted number: pnpm writes a package.json whose engines is a list as `{'0': ...}`);
 *     `cpu:`, `os:`, `libc: [a, b]` on a packages entry; `deprecated: "..."` on a packages entry (one line);
 *   - where the check reads a value, it has the one shape pnpm gives it (lockShape): an importer's dependencies are
 *     blocks of `specifier` and `version` scalars; a snapshot's dependencies and optionalDependencies are blocks of
 *     scalars and its transitivePeerDependencies a list; a package's peerDependencies is a block of scalars and its
 *     peerDependenciesMeta a block of blocks of scalars; a list on the lines below a key is written only for
 *     transitivePeerDependencies and bundledDependencies, and for keys the check does not read;
 *   - `optional:` on a snapshots entry is `true`.
 */
export function pnpmFormRefusal(file, text) {
  const refuse = (line, why) => `${file}${line ? ` line ${line}` : ''} is not in the form pnpm writes (${why}), so it cannot be checked`;
  if (typeof text !== 'string' || !text.endsWith('\n') || text.endsWith('\n\n')) return refuse(0, 'it must end with one newline');
  for (let at = 0, line = 1; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 10) line += 1;
    else if (code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 || code === 0xfeff) return refuse(line, 'a tab, carriage return or control character');
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines[0] !== "lockfileVersion: '9.0'") return refuse(1, "the first line must be lockfileVersion: '9.0'");
  /** The open blocks, outermost first: their indentation, whether they hold keys or list items, and the keys so far. */
  const stack = [{ indent: 0, list: false, keys: new Set(), name: null }];
  let opener = null, blank = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i], n = i + 1;
    if (line === '') {
      if (blank) return refuse(n, 'two blank lines');
      blank = true;
      continue;
    }
    const indent = /^ */.exec(line)[0].length, rest = line.slice(indent);
    if (indent % 2 || line.endsWith(' ')) return refuse(n, 'odd indentation or a trailing space');
    if (blank && indent > 2) return refuse(n, 'a blank line inside an entry');
    blank = false;
    const item = rest.startsWith('- ') ? rest.slice(2) : null;
    if (opener) {
      if (indent !== opener.indent + 2) return refuse(n, `${opener.key} has no value`);
      const shape = item !== null ? 'items' : 'block';
      if (opener.shape !== undefined && opener.shape !== shape && !(opener.shape === 'entry' && shape === 'block')) return refuse(n, `${opener.key} is not written as pnpm writes it there`);
      stack.push({ indent, list: item !== null, keys: new Set(), name: opener.key });
      opener = null;
    } else {
      while (stack.at(-1).indent > indent) stack.pop();
      if (stack.at(-1).indent !== indent) return refuse(n, 'indentation that matches no open block');
    }
    const block = stack.at(-1);
    if (block.list !== (item !== null)) return refuse(n, 'a list item and a key in one block');
    const scalar = (value) => (value.startsWith("'") ? /^'(?:[^']|'')*'$/.test(value) : plainScalar(value) || /^(?:true|false|0|[1-9][0-9]*)$/.test(value));
    if (item !== null) {
      if (!scalar(item)) return refuse(n, 'a list item that is not one plain or single-quoted value');
      continue;
    }
    const quoted = /^'((?:[^']|'')*)'(?::$|: (.+)$)/.exec(rest), plain = quoted ? null : /^([^\s:'"]+)(?::$|: (.+)$)/.exec(rest);
    if (!quoted && !plain) return refuse(n, 'not a key and a value');
    const key = quoted ? quoted[1].replace(/''/g, "'") : plain[1], value = (quoted ?? plain)[2];
    if (!LOCK_KEY.test(key) || plainScalar(key) === Boolean(quoted) || (indent === 0 && !/^[A-Za-z][A-Za-z0-9]*$/.test(key))) return refuse(n, 'a key pnpm would not write that way');
    if (block.keys.has(key)) return refuse(n, `the key ${key} twice`);
    block.keys.add(key);
    const parents = stack.slice(1).map((open) => open.name), shape = lockShape(parents, key);
    const onPackage = parents.length === 2 && parents[0] === 'packages';
    let why = null;
    if (value === undefined) {
      if (shape !== undefined && !['block', 'items', 'entry'].includes(shape)) why = `${key} is not written as pnpm writes it there`;
      opener = { indent, key, shape };
    } else if (value === '{}') why = shape === 'entry' ? null : 'an empty mapping where pnpm writes none';
    else if (value.startsWith('{')) why = shape === 'map' ? flowMapRefusal(value, key === 'resolution') : 'a one-line mapping where pnpm writes none';
    else if (value.startsWith('[')) why = shape === 'list' && FLOW_LIST.test(value) ? null : 'a one-line list where pnpm writes none';
    else if (value.startsWith('"')) why = onPackage && key === 'deprecated' && /^"(?:[^"\\]|\\.)*"$/.test(value) ? null : 'a double-quoted value where pnpm writes none';
    else if (!scalar(value)) why = 'a value that is not one plain or single-quoted scalar';
    else if (shape !== undefined && shape !== 'scalar') why = `${key} is not written as pnpm writes it there`;
    else if (parents.length === 2 && parents[0] === 'snapshots' && key === 'optional' && value !== 'true') why = 'optional is not true';
    if (why) return refuse(n, why);
  }
  return opener ? refuse(lines.length, `${opener.key} has no value`) : null;
}

/** The `name: value` lines of a mapping block, one indentation in: name -> value, both unquoted. */
function yamlPairs(block, indent) {
  const pairs = new Map();
  const unquote = (value) => { const text = value.trim(); return /^'.*'$/.test(text) ? text.slice(1, -1).replace(/''/g, "'") : text; };
  for (const item of block ? yamlBlocks(block.lines.slice(1), indent) : []) {
    if (item.key !== null) pairs.set(item.key, unquote(item.lines[0].replace(/^\s*(?:'(?:[^']|'')*'|[^:]*):/, '')));
  }
  return pairs;
}
/** The fields of a packages or snapshots entry (resolution, peerDependencies, dependencies, ...), by name. */
const entryFields = (block) => (/:\s*\{\}\s*$/.test(block.lines[0]) ? new Map() : byKey(yamlBlocks(block.lines.slice(1), 4)));
/** The integrity and tarball of a packages entry's `resolution: {integrity: ..., tarball: ...}` line. */
function entryResolution(block) {
  const resolution = block.lines.map((line) => line.trim()).find((line) => line.startsWith('resolution: '));
  return { integrity: /integrity: ([^,}\s]+)/.exec(resolution ?? '')?.[1], tarball: /tarball: ([^,}\s]+)/.exec(resolution ?? '')?.[1] };
}

/**
 * The peers a packages entry marks optional, as { flags } (peer -> true|false) or { refusal }: peerDependenciesMeta
 * may hold nothing but `optional: true|false` for peers the entry declares in peerDependencies.
 */
function optionalPeers(block) {
  const fields = entryFields(block);
  const declared = yamlPairs(fields.get('peerDependencies'), 6);
  const flags = new Map();
  for (const meta of fields.has('peerDependenciesMeta') ? yamlBlocks(fields.get('peerDependenciesMeta').lines.slice(1), 6) : []) {
    const body = meta.lines.slice(1).map((line) => line.trim()).filter(Boolean);
    if (meta.key === null || !/:\s*$/.test(meta.lines[0]) || body.length !== 1 || !/^optional: (true|false)$/.test(body[0])) return { refusal: 'gives peerDependenciesMeta more than optional flags' };
    if (!declared.has(meta.key)) return { refusal: `marks ${meta.key} optional, which is not one of its peers` };
    flags.set(meta.key, body[0] === 'optional: true');
  }
  return { flags };
}
/** The peers an entry marks `optional: true` (none when its flags are refused). */
const optionalPeerNames = (block) => new Set([...(optionalPeers(block).flags ?? [])].filter(([, optional]) => optional).map(([name]) => name));

/**
 * Why a packages entry's peerDependenciesMeta is not one pnpm writes for this package, or null. pnpm writes two forms:
 * none (the version was resolved from GitHub Packages' metadata, which omits the field) or exactly the
 * peerDependenciesMeta of the package's own package.json (read from its tarball). `manifests` maps name@version to
 * { integrity, manifest }: the package.json of the tarball with that sha512, which the push job downloaded and hashed
 * itself (readManifests). An entry with flags and no such manifest is refused.
 */
function peerMetaRefusal(key, block, manifests) {
  const peers = optionalPeers(block);
  if (peers.refusal) return peers.refusal;
  if (!entryFields(block).has('peerDependenciesMeta')) return null;
  const verified = manifests?.get(key);
  if (!verified || verified.integrity !== entryResolution(block).integrity) return "marks peers optional, which could not be checked against the package's own package.json";
  const published = verified.manifest?.peerDependenciesMeta;
  const written = Object.fromEntries([...peers.flags].map(([name, optional]) => [name, { optional }]));
  if (!published || typeof published !== 'object' || canonical(written) !== canonical(published)) return "marks other peers optional than the package's own package.json does";
  return null;
}

/**
 * Why a packages entry that keeps its key may not change from `a` to `b`, or null. Only a GitHub Packages package
 * (@revt-eng/*) may, and only in peerDependenciesMeta, to one of the two forms pnpm writes (peerMetaRefusal). The key
 * (name and version), the resolution (integrity and tarball), the peers and every other field stay byte for byte.
 */
function packagesEntryRefusal(key, a, b, manifests) {
  const parsed = packageKey(key);
  if (!parsed || !SCOPED.test(parsed.name) || a.lines[0].trimEnd() !== b.lines[0].trimEnd()) return 'changes';
  const fieldsA = entryFields(a), fieldsB = entryFields(b);
  for (const field of new Set([...fieldsA.keys(), ...fieldsB.keys()])) {
    if (field === 'peerDependenciesMeta') continue;
    if (!fieldsA.has(field) || !fieldsB.has(field) || blockText(fieldsA.get(field)) !== blockText(fieldsB.get(field))) return 'changes more than which of its peers are optional';
  }
  return peerMetaRefusal(key, b, manifests);
}

/** The fields pnpm writes on a packages entry and on a snapshots entry. */
const PACKAGE_FIELDS = new Set(['resolution', 'engines', 'peerDependencies', 'peerDependenciesMeta', 'hasBin', 'deprecated', 'cpu', 'os', 'libc', 'bundledDependencies']);
const SNAPSHOT_FIELDS = new Set(['dependencies', 'optionalDependencies', 'transitivePeerDependencies', 'optional']);
const names = (record) => new Set(record && typeof record === 'object' ? Object.keys(record) : []);

/**
 * Why a packages entry a pin adds is not that version as its registry publishes it, or null: only fields pnpm writes;
 * its peers are the registry's peerDependencies by name (plus a peer its verified package.json marks optional without
 * declaring); its optional peers are one of the two forms pnpm writes (peerMetaRefusal).
 */
function newPackageRefusal(key, block, declared, manifests) {
  const fields = entryFields(block);
  const unknown = [...fields.keys()].find((field) => !PACKAGE_FIELDS.has(field));
  if (unknown !== undefined) return `has ${unknown ?? 'a line'}, which pnpm does not write on a package`;
  const refused = peerMetaRefusal(key, block, manifests);
  if (refused) return refused;
  const peers = names(declared?.peerDependencies), flagged = optionalPeers(block).flags;
  const written = [...yamlPairs(fields.get('peerDependencies'), 6).keys()];
  const stray = written.find((name) => !peers.has(name) && !flagged.has(name)) ?? [...peers].find((name) => !written.includes(name));
  return stray === undefined ? null : `does not have the registry's peers (${stray})`;
}

/** A snapshots entry: its edges, whether it carries `optional: true`, and everything else as text. */
function snapshotEntry(block) {
  const fields = entryFields(block);
  const flag = fields.has('optional') ? blockText(fields.get('optional')).trim() : null;
  const rest = [...fields].filter(([field]) => !['dependencies', 'optionalDependencies'].includes(field) && !(field === 'optional' && flag === 'optional: true'));
  return {
    fields: [...fields.keys()],
    dependencies: yamlPairs(fields.get('dependencies'), 6),
    optionalDependencies: yamlPairs(fields.get('optionalDependencies'), 6),
    optional: flag === 'optional: true',
    rest: rest.map(([, field]) => blockText(field)).join('\n'),
  };
}

/**
 * Why a snapshots entry a pin adds is not an install of that version as its registry publishes it, or null:
 *   - only the fields pnpm writes, and `optional` only as `optional: true`;
 *   - under dependencies, only names the registry lists in the version's dependencies, or a peer the entry does not
 *     mark optional; under optionalDependencies, only its optionalDependencies, or a peer the entry marks optional
 *     (flags checked against the package's own package.json, peerMetaRefusal); no name under both.
 * That every edge names a snapshot the lockfile has, that something depends on the entry and that its `optional: true`
 * is the graph's are checked for the whole lockfile (lockGraph). Not checked: that the version an edge points at
 * satisfies the declared range, and the peer suffix in the key.
 */
function newSnapshotRefusal(block, declared, optional) {
  const entry = snapshotEntry(block);
  const unknown = entry.fields.find((field) => !SNAPSHOT_FIELDS.has(field));
  if (unknown !== undefined || (entry.fields.includes('optional') && !entry.optional)) return `has ${unknown ?? 'an optional that is not true'}, which pnpm does not write on a snapshot`;
  const dependencies = names(declared?.dependencies), optionals = names(declared?.optionalDependencies), peers = names(declared?.peerDependencies);
  for (const name of entry.dependencies.keys()) {
    if (entry.optionalDependencies.has(name)) return `lists ${name} under dependencies and optionalDependencies`;
    if (!dependencies.has(name) && !(peers.has(name) && !optional.has(name))) return `depends on ${name}, which the registry does not list as a dependency or required peer of it`;
  }
  for (const name of entry.optionalDependencies.keys()) {
    if (!optionals.has(name) && !(peers.has(name) && optional.has(name))) return `optionally depends on ${name}, which the registry does not list as an optional dependency or optional peer of it`;
  }
  return null;
}

/** The snapshots key a dependency reference names (pnpm's refToRelative), or null for a link. */
function snapshotKey(name, reference) {
  if (reference.startsWith('link:')) return null;
  if (reference.startsWith('@')) return reference;
  const at = reference.indexOf('@'), colon = reference.indexOf(':'), bracket = reference.indexOf('(');
  if (at >= 0 && (colon < 0 || at < colon) && (bracket < 0 || at < bracket)) return reference;
  return `${name}@${reference}`;
}

/**
 * A lockfile's own dependency graph:
 *   required    the snapshots reachable from an importer's dependencies or devDependencies through snapshots'
 *               dependencies; pnpm marks every other snapshot `optional: true`;
 *   referenced  every snapshot an importer or a snapshot depends on, optionally or not;
 *   dangling    a referenced key the lockfile has no snapshot for, or undefined.
 */
export function lockGraph(importers, snapshots) {
  const roots = [], referenced = new Set(), edges = new Map();
  for (const importer of importers.values()) {
    const fields = entryFields(importer);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const dep of fields.has(field) ? yamlBlocks(fields.get(field).lines.slice(1), 6) : []) {
        const version = yamlPairs(dep, 8).get('version');
        const key = dep.key !== null && version !== undefined ? snapshotKey(dep.key, version) : null;
        if (key === null) continue;
        referenced.add(key);
        if (field !== 'optionalDependencies') roots.push(key);
      }
    }
  }
  for (const [key, block] of snapshots) {
    const entry = snapshotEntry(block);
    const keys = (pairs) => [...pairs].map(([name, reference]) => snapshotKey(name, reference)).filter((target) => target !== null);
    edges.set(key, keys(entry.dependencies));
    for (const target of [...edges.get(key), ...keys(entry.optionalDependencies)]) referenced.add(target);
  }
  const required = new Set();
  while (roots.length) {
    const key = roots.pop();
    if (required.has(key) || !edges.has(key)) continue;
    required.add(key);
    roots.push(...edges.get(key));
  }
  return { required, referenced, dangling: [...referenced].find((key) => !snapshots.has(key)) };
}
/** The snapshots a lockfile's own graph requires (lockGraph). */
export const requiredSnapshots = (importers, snapshots) => lockGraph(importers, snapshots).required;

/**
 * A pnpm-lock.yaml change that only re-pins. Both files must be in the form pnpm writes (pnpmFormRefusal), checked
 * before anything is read from them. Then: every section but importers, packages and snapshots unchanged; in the
 * importers only the pinned packages' specifier and version change (the version to exactly the pin, peers allowed);
 * in packages and snapshots only the pinned packages' entries go and come, the new ones exactly at the pin: a new
 * packages entry has the registry's resolution and peers (newPackageRefusal), a new snapshots entry only edges the
 * registry declares for that version (newSnapshotRefusal).
 *
 * An entry that stays may change in one way, which pnpm does on its own whenever it runs (packagesEntryRefusal): which
 * peers of a @revt-eng package are optional, to none or to exactly what the package's own package.json says. What
 * follows from that is allowed and nothing else: in that package's snapshots, exactly the peers whose flag differs
 * move between dependencies and optionalDependencies, at the same versions; and a snapshot gains or loses
 * `optional: true` only when the new lockfile's own graph says so (lockGraph). In the new lockfile every edge names a
 * snapshot it has, and something depends on every snapshot the pin adds.
 */
export function pnpmLockRefusal(file, beforeText, afterText, pins, registry, manifests = new Map()) {
  const malformed = pnpmFormRefusal(`${file} on the branch`, beforeText) ?? pnpmFormRefusal(file, afterText);
  if (malformed) return malformed;
  const pinned = new Map(pins.map((pin) => [pin.name, pin.version]));
  const top = (text) => byKey(yamlBlocks(text.split(/\r?\n/), 0));
  const before = top(beforeText), after = top(afterText);
  if (canonical([...before.keys()].sort()) !== canonical([...after.keys()].sort())) return `${file} adds or removes a section`;
  for (const [key, block] of before) {
    if (['importers', 'packages', 'snapshots'].includes(key)) continue;
    if (blockText(block) !== blockText(after.get(key))) return `${file} changes its ${key ?? 'header'}`;
  }
  // importers -> <importer> -> <field> -> <name> -> specifier / version
  const level = (block, indent) => byKey(yamlBlocks(block.lines.slice(1), indent));
  const sameKeys = (a, b) => canonical([...a.keys()].sort()) === canonical([...b.keys()].sort());
  const importersA = before.get('importers') ? level(before.get('importers'), 2) : new Map();
  const importersB = after.get('importers') ? level(after.get('importers'), 2) : new Map();
  if (!sameKeys(importersA, importersB)) return `${file} adds or removes an importer`;
  for (const [importer, blockA] of importersA) {
    const fieldsA = level(blockA, 4), fieldsB = level(importersB.get(importer), 4);
    if (!sameKeys(fieldsA, fieldsB)) return `${file}: importer ${importer} adds or removes a field`;
    for (const [field, fA] of fieldsA) {
      const fB = fieldsB.get(field);
      if (!['dependencies', 'devDependencies', 'optionalDependencies'].includes(field)) {
        if (blockText(fA) !== blockText(fB)) return `${file}: importer ${importer} changes ${field}`;
        continue;
      }
      const depsA = level(fA, 6), depsB = level(fB, 6);
      if (!sameKeys(depsA, depsB)) return `${file}: importer ${importer} adds or removes a dependency`;
      for (const [name, dA] of depsA) {
        const dB = depsB.get(name);
        if (blockText(dA) === blockText(dB)) continue;
        if (!pinned.has(name)) return `${file}: importer ${importer} changes ${name}, which is not being pinned`;
        const body = dB.lines.slice(1).map((line) => line.trim()).filter(Boolean);
        const version = body.find((line) => line.startsWith('version: '))?.slice('version: '.length);
        if (body.length !== 2 || !body.some((line) => line.startsWith('specifier: ')) || !version)
          return `${file}: importer ${importer} gives ${name} more than a specifier and a version`;
        if (!new RegExp(`^${escapeRe(pinned.get(name))}(?:\\(.*\\))?$`).test(version)) return `${file}: importer ${importer} locks ${name} at ${version}, not the pinned ${pinned.get(name)}`;
      }
    }
  }
  const entries = (lock, section) => (lock.get(section) ? level(lock.get(section), 2) : new Map());
  const packagesA = entries(before, 'packages'), packagesB = entries(after, 'packages'), snapshotsB = entries(after, 'snapshots');
  /** The snapshots whose `optional: true` must be the graph's: the ones that changed it, and the ones the pin adds. */
  const flips = [], added = [];
  /** Why a snapshots entry that keeps its key may not change, or null; `flips` collects a changed `optional: true`. */
  const snapshotRefusal = (key, blockA, blockB) => {
    const a = snapshotEntry(blockA), b = snapshotEntry(blockB);
    const edges = (entry) => canonical([...entry.dependencies, ...entry.optionalDependencies].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
    const twice = (entry) => [...entry.optionalDependencies.keys()].some((name) => entry.dependencies.has(name));
    if (a.rest !== b.rest || twice(a) || twice(b) || edges(a) !== edges(b)) return 'changes';
    const moved = [...b.dependencies.keys(), ...b.optionalDependencies.keys()].filter((name) => a.optionalDependencies.has(name) !== b.optionalDependencies.has(name));
    if (moved.length) {
      const parsed = packageKey(key);
      const entry = parsed && SCOPED.test(parsed.name) ? `${parsed.name}@${parsed.version}` : null;
      if (!entry || !packagesA.has(entry) || !packagesB.has(entry)) return 'changes';
      const was = optionalPeerNames(packagesA.get(entry)), now = optionalPeerNames(packagesB.get(entry));
      const stray = moved.find((name) => was.has(name) !== a.optionalDependencies.has(name) || now.has(name) !== b.optionalDependencies.has(name));
      if (stray !== undefined) return `moves ${stray} between dependencies and optionalDependencies, which its peers' optional flags do not explain`;
    }
    if (a.optional !== b.optional) flips.push(key);
    return null;
  };
  for (const section of ['packages', 'snapshots']) {
    const a = entries(before, section), b = entries(after, section);
    for (const [key, block] of a) {
      if (b.has(key)) {
        if (blockText(block) === blockText(b.get(key))) continue;
        const refused = section === 'packages' ? packagesEntryRefusal(key, block, b.get(key), manifests) : snapshotRefusal(key, block, b.get(key));
        if (refused) return `${file}: ${section} ${key} ${refused}`;
        continue;
      }
      const parsed = packageKey(key);
      if (!parsed || !pinned.has(parsed.name)) return `${file}: ${section} drops ${key}, which is not being pinned`;
    }
    for (const [key, block] of b) {
      if (a.has(key)) continue;
      const parsed = packageKey(key);
      if (!parsed || pinned.get(parsed.name) !== parsed.version) return `${file}: ${section} adds ${key}, which is not a pinned package at its pin`;
      const declared = registry?.get(parsed.name)?.[parsed.version];
      if (section === 'packages') {
        const { integrity, tarball } = entryResolution(block);
        const refused = resolutionRefusal(`${file} packages ${key}`, parsed.name, parsed.version, integrity, tarball, registry);
        if (refused) return refused;
        const shaped = newPackageRefusal(key, block, declared, manifests);
        if (shaped) return `${file}: packages ${key} ${shaped}`;
        continue;
      }
      const entry = `${parsed.name}@${parsed.version}`;
      if (!declared || !packagesB.has(entry)) return `${file}: snapshots ${key} is of a package the lockfile or the registry does not have`;
      const refused = newSnapshotRefusal(block, declared, optionalPeerNames(packagesB.get(entry)));
      if (refused) return `${file}: snapshots ${key} ${refused}`;
      added.push(key);
    }
  }
  const graph = lockGraph(importersB, snapshotsB);
  if (graph.dangling !== undefined) return `${file}: ${graph.dangling} is depended on, and the lockfile has no snapshot of it`;
  const orphan = added.find((key) => !graph.referenced.has(key));
  if (orphan !== undefined) return `${file}: snapshots adds ${orphan}, which nothing depends on`;
  const stray = [...flips, ...added].find((key) => snapshotEntry(snapshotsB.get(key)).optional === graph.required.has(key));
  if (stray !== undefined) return `${file}: snapshots ${stray} ${added.includes(stray) ? 'is' : 'changes whether it is'} optional, which the lockfile's dependencies do not explain`;
  return null;
}

/**
 * The @revt-eng packages entries of a new pnpm-lock.yaml whose optional peers have to be checked against the package
 * itself: entries with a peerDependenciesMeta the branch head's lockfile does not have in that form. Each is
 * { key, integrity, tarball }, read from the entry's resolution, and only when that is a sha512 and a GitHub Packages
 * download URL of exactly that name and version; anything else is left out and so refused by the check. At most 32.
 */
export function peerMetaToVerify(beforeText, afterText) {
  if (pnpmFormRefusal('', beforeText) || pnpmFormRefusal('', afterText)) return [];
  const packages = (text) => { const top = byKey(yamlBlocks(text.split('\n'), 0)); return top.has('packages') ? byKey(yamlBlocks(top.get('packages').lines.slice(1), 2)) : new Map(); };
  const was = packages(beforeText), entries = [];
  for (const [key, block] of packages(afterText)) {
    const parsed = packageKey(key), meta = entryFields(block).get('peerDependenciesMeta');
    if (!parsed || !SCOPED.test(parsed.name) || !meta) continue;
    const old = was.has(key) ? entryFields(was.get(key)).get('peerDependenciesMeta') : undefined;
    if (old && blockText(old) === blockText(meta)) continue;
    const { integrity, tarball } = entryResolution(block);
    const download = new RegExp(`^https://npm\\.pkg\\.github\\.com/download/${escapeRe(parsed.name)}/${escapeRe(parsed.version)}/[0-9a-f]+$`);
    if (/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity ?? '') && download.test(tarball ?? '')) entries.push({ key, integrity, tarball });
  }
  return entries.slice(0, 32);
}

/** package/package.json of an npm tarball (a gzipped tar), parsed. The last one wins, as it does when unpacked. */
export function tarballManifest(tgz) {
  const tar = gunzipSync(tgz, { maxOutputLength: 512 * 1024 * 1024 });
  let found = null;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (from, to) => { const end = header.indexOf(0, from); return header.toString('utf8', from, end < 0 || end > to ? to : end); };
    const size = parseInt(field(124, 136).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('the tarball is not a tar archive');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (type === '0' && `${field(345, 500) ? `${field(345, 500)}/` : ''}${field(0, 100)}` === 'package/package.json') found = tar.toString('utf8', at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  if (found === null) throw new Error('the tarball has no package/package.json');
  return JSON.parse(found);
}

/** Refusal unless a new .release-pins.json keeps the head's records and adds or drops only pinned packages'. */
export function recordsRefusal(beforeRecords, afterText, pins) {
  let after;
  try { after = afterText === null ? {} : JSON.parse(afterText); } catch { return `${PINS_FILE} is not JSON`; }
  if (!after || typeof after !== 'object' || Array.isArray(after)) return `${PINS_FILE} is not an object`;
  const pinned = new Set(pins.map((pin) => pin.name));
  const keys = new Set([...Object.keys(beforeRecords), ...Object.keys(after)]);
  for (const file of keys) {
    if (!pinnablePath(file) || path.posix.basename(file) !== 'package.json') return `${PINS_FILE} records ${file}, which is not a manifest`;
    const was = beforeRecords[file] ?? {}, now = after[file] ?? {};
    if (typeof now !== 'object' || Array.isArray(now)) return `${PINS_FILE} records ${file} as ${JSON.stringify(now)}`;
    for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (typeof (now[name] ?? '') !== 'string') return `${PINS_FILE} records ${name} in ${file} as ${JSON.stringify(now[name])}`;
      if (was[name] !== now[name] && !pinned.has(name)) return `${PINS_FILE} changes the record of ${name}, which is not being pinned`;
    }
  }
  return null;
}

/**
 * The push job's check and commit (see the header). `git(args, input)` runs git against the bare repository and
 * returns stdout; nothing from the Release branch is executed.
 */
export function commitBundle({ bundle, tip, pins, release, n, git, registry = new Map(), manifests = new Map() }) {
  const manifest = JSON.parse(readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  if (manifest.base !== tip) return { moved: true, reason: `the branch moved from ${manifest.base} to ${tip} after the pin` };
  if (manifest.release !== release) throw new Error(`the bundle is for ${manifest.release}, not ${release}`);
  if (canonical(manifest.pins) !== canonical(pins)) throw new Error('the bundle pins other packages than this run was given');
  const files = manifest.files;
  if (!Array.isArray(files) || !files.length) throw new Error('the bundle changes nothing');
  const seen = new Set();
  const atTip = (file) => { try { return git(['cat-file', 'blob', `${tip}:${file}`]); } catch { return null; } };
  const tipRecordsText = atTip(PINS_FILE);
  const records = tipRecordsText === null ? {} : JSON.parse(tipRecordsText);
  const entries = [];
  for (const entry of files) {
    const file = entry?.path;
    if (!pinnablePath(file) || seen.has(file)) throw new Error(`refusing ${JSON.stringify(file)} in the bundle`);
    seen.add(file);
    const before = atTip(file);
    if (entry.deleted === true) {
      if (file !== PINS_FILE) throw new Error(`the bundle deletes ${file}; a pin deletes only ${PINS_FILE}`);
      if (before === null) throw new Error(`the bundle deletes ${file}, which the branch does not have`);
      const refused = recordsRefusal(records, null, pins);
      if (refused) throw new Error(refused);
      entries.push({ file, remove: true });
      continue;
    }
    if (entry.deleted !== false) throw new Error(`the bundle does not say whether ${file} was deleted`);
    const after = readFileSync(path.join(bundle, 'files', file), 'utf8');
    const name = path.posix.basename(file);
    let refused;
    if (file === PINS_FILE) refused = recordsRefusal(records, after, pins);
    else if (before === null) refused = `the bundle adds ${file}; a pin only changes files the branch has`;
    else if (name === 'package.json') refused = manifestPinRefusal(file, before, after, pins, n, records);
    else if (name === 'pnpm-workspace.yaml') refused = workspacePinRefusal(file, before, after, pins);
    else if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') refused = npmLockRefusal(file, before, after, pins, registry);
    else if (name === 'pnpm-lock.yaml') refused = pnpmLockRefusal(file, before, after, pins, registry, manifests);
    else refused = `${file} is not a file a pin changes`;
    if (refused) throw new Error(refused);
    const mode = before === null ? '100644' : git(['ls-tree', tip, '--', file]).split(/\s/)[0];
    if (mode !== '100644' && mode !== '100755') throw new Error(`${file} is not a regular file on the branch`);
    entries.push({ file, mode, blob: git(['hash-object', '-w', '--stdin'], after).trim() });
  }
  const index = path.join(bundle, '.index');
  rmSync(index, { force: true });
  const withIndex = (args, input) => git(args, input, { GIT_INDEX_FILE: index });
  withIndex(['read-tree', tip]);
  for (const entry of entries) {
    if (entry.remove) withIndex(['update-index', '--force-remove', '--', entry.file]);
    else withIndex(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.blob},${entry.file}`]);
  }
  const tree = withIndex(['write-tree']).trim();
  const sha = git(['commit-tree', tree, '-p', tip], commitMessage(pins, release)).trim();
  rmSync(index, { force: true });
  return { sha, files: entries.map((entry) => entry.file) };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    options[argv[i].slice(2)] = argv[i + 1];
  }
  return options;
}

/** A registry entry the push job could not read: the attempt stops and the next one tries again (exit 75). */
export class RegistryUnavailable extends Error {}

/**
 * The registry entries of the pinned packages, name -> { [version]: { integrity, tarball } }: GitHub Packages for
 * @revt-eng/* (REGISTRY_TOKEN, packages: read), npm for the rest. A version also carries the dependencies,
 * optionalDependencies and peerDependencies its registry lists, when it lists them. Fails closed: an entry it cannot
 * read throws RegistryUnavailable.
 */
export async function readRegistry(pins, { token = process.env.REGISTRY_TOKEN, fetchImpl = fetch } = {}) {
  const registry = new Map();
  for (const name of new Set(pins.map((pin) => pin.name))) {
    const scoped = SCOPED.test(name);
    const encoded = name.replaceAll('/', '%2f');
    const url = scoped ? `https://npm.pkg.github.com/${encoded}` : `https://registry.npmjs.org/${encoded}`;
    try {
      const response = await fetchImpl(url, { headers: { Accept: 'application/json', ...(scoped && token ? { Authorization: `Bearer ${token}` } : {}) } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const packument = await response.json();
      const versions = {};
      for (const [version, entry] of Object.entries(packument.versions ?? {})) {
        versions[version] = { integrity: entry?.dist?.integrity, tarball: entry?.dist?.tarball };
        for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) if (entry?.[field] && typeof entry[field] === 'object') versions[version][field] = entry[field];
      }
      registry.set(name, versions);
    } catch (error) {
      throw new RegistryUnavailable(`could not read ${name} from its registry (${error.message})`);
    }
  }
  return registry;
}

/**
 * The package.json of each tarball in `entries` (peerMetaToVerify), name@version -> { integrity, manifest }. The
 * tarball is downloaded from GitHub Packages (REGISTRY_TOKEN), and its sha512 must be the integrity the lockfile
 * records. Fails closed: a tarball it cannot download throws RegistryUnavailable; one with another hash, or without a
 * package.json, is an error.
 */
export async function readManifests(entries, { token = process.env.REGISTRY_TOKEN, fetchImpl = fetch } = {}) {
  const manifests = new Map();
  for (const entry of entries) {
    let bytes;
    try {
      const response = await fetchImpl(entry.tarball, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new RegistryUnavailable(`could not read the tarball of ${entry.key} (${error.message})`);
    }
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== entry.integrity) throw new Error(`the tarball of ${entry.key} does not have the integrity the lockfile records`);
    manifests.set(entry.key, { integrity: entry.integrity, manifest: tarballManifest(bytes) });
  }
  return manifests;
}

/** The entries to verify (peerMetaToVerify) across the pnpm lockfiles of a bundle pinned on `tip`. */
export function bundlePeerMeta(bundle, tip, git) {
  const manifest = JSON.parse(readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  const entries = new Map();
  for (const entry of manifest.base === tip && Array.isArray(manifest.files) ? manifest.files : []) {
    if (!pinnablePath(entry?.path) || path.posix.basename(entry.path) !== 'pnpm-lock.yaml' || entry.deleted !== false) continue;
    let before;
    try { before = git(['cat-file', 'blob', `${tip}:${entry.path}`]); } catch { continue; }
    for (const found of peerMetaToVerify(before, readFileSync(path.join(bundle, 'files', entry.path), 'utf8'))) entries.set(`${found.key} ${found.integrity}`, found);
  }
  return [...entries.values()].slice(0, 32);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest);
  if (command === 'package-manager') {
    const manifest = JSON.parse(readFileSync(path.join(path.resolve(options.dir ?? '.'), 'package.json'), 'utf8'));
    process.stdout.write(packageManagerSpec(manifest.packageManager) ?? '');
    return;
  }
  const { release, n } = releaseFromBranch(options.branch);
  const pins = parsePins(options.packages, n);
  if (command === 'check') {
    console.log(`${release}: ${pins.map((p) => `${p.name}@${p.version}`).join(', ')}`);
    return;
  }
  if (command === 'commit') {
    const gitDir = path.resolve(options['git-dir']);
    if (!/^[0-9a-f]{40}$/.test(options.tip ?? '')) throw new Error('--tip must be a full commit sha');
    const git = (args, input, env = {}) => {
      const result = spawnSync('git', ['--git-dir', gitDir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
        { encoding: 'utf8', input, env: { ...process.env, ...env } });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      return result.stdout;
    };
    const bundle = path.resolve(options.bundle);
    let registry, manifests;
    try {
      registry = await readRegistry(pins);
      manifests = await readManifests(bundlePeerMeta(bundle, options.tip, git));
    } catch (error) {
      if (!(error instanceof RegistryUnavailable)) throw error;
      console.error(`::warning::release-pin: ${error.message}; nothing is committed, and the next attempt tries again.`);
      process.exit(75);
    }
    process.stdout.write(`${JSON.stringify(commitBundle({ bundle, tip: options.tip, pins, release, n, git, registry, manifests }))}\n`);
    return;
  }
  if (command !== 'apply') throw new Error('usage: release-pin.mjs check|apply|commit|package-manager --branch release/RL-<n> --packages "<name>@<version> ..."');
  const root = path.resolve(options.dir ?? '.');
  const result = apply({ root, pins, release });
  if (options.out) writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
  if (options.bundle && result.files.length) writeBundle(root, result, path.resolve(options.bundle), git(root, ['rev-parse', 'HEAD']).trim());
  console.log(result.files.length ? `Changed: ${result.files.join(', ')}` : 'Nothing to change: every manifest already pins these versions.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::release-pin: ${error.message}`);
    process.exit(1);
  });
}
