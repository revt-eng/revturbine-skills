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
//          tries again on its next attempt. A pnpm-lock.yaml is read by one
//          tokenizer (parsePnpmLock) that takes only the exact form pnpm
//          writes, on the branch and in the bundle. Which peers of a @revt-eng
//          package it marks optional is checked against the package's own
//          package.json, from the tarball the lockfile names, downloaded and
//          hashed here (exit 75 as well when that cannot be read).
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

/** The most git output this script reads at once (a lockfile, a file list). Node's default is 1 MB. */
export const GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
/** The error for git output larger than GIT_OUTPUT_BYTES: never taken for "the file is not there". */
export function gitOutputTooLarge(args) {
  return Object.assign(new Error(`git ${args.join(' ')} wrote more than ${GIT_OUTPUT_BYTES} bytes, more than this script reads`), { tooLarge: true });
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: GIT_OUTPUT_BYTES });
  if (result.error?.code === 'ENOBUFS') throw gitOutputTooLarge(args);
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
 * Refusal unless a pnpm-workspace.yaml differs only in the pinned packages' items of its top-level
 * `minimumReleaseAgeExclude:` list; null when it does. pnpm 11 lists a just-published version there, one item per
 * package ('<name>@<version> || <version> ...'), and adds the key when the file has none. Every other line of the
 * file is the same and in the same place, so nothing is read from it but that list: an item of a pinned package is
 * exactly a name and exact versions, and holds only versions it held on the branch and the pinned one.
 */
export function workspacePinRefusal(file, beforeText, afterText, pins) {
  const pinned = new Map(pins.map((pin) => [pin.name, pin.version]));
  const read = (text) => {
    const lines = String(text ?? '').split('\n'), kept = [], items = new Map();
    const at = lines.indexOf('minimumReleaseAgeExclude:');
    let end = at + 1, others = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (at >= 0 && i === end && lines[i].startsWith('  - ')) {
        end += 1;
        const item = /^ {2}- (?:'([^'"\\]+)'|"([^'"\\]+)"|([^\s'"\\#]+))$/.exec(lines[i]);
        const value = item ? item[1] ?? item[2] ?? item[3] : '', split = value.indexOf('@', 1), name = split > 0 ? value.slice(0, split) : null;
        if (name !== null && pinned.has(name)) {
          const versions = value.slice(split + 1).split(' || ');
          if (items.has(name) || !versions.every((version) => EXACT.test(version))) return null;
          items.set(name, versions);
          continue;
        }
        others += 1;
      }
      kept.push(lines[i]);
    }
    if (at >= 0 && !others) kept.splice(at, 1);
    return { text: kept.join('\n').replace(/\n+$/, '\n'), items };
  };
  const before = read(beforeText), after = read(afterText);
  if (!before || !after) return `${file} has a minimumReleaseAgeExclude item of a pinned package that is not '<name>@<version> || <version> ...', once`;
  if (before.text !== after.text) return `${file} changes more than the pinned packages' items under minimumReleaseAgeExclude: a line that names no pinned package, or names one anywhere else`;
  for (const [name, versions] of after.items) {
    const held = before.items.get(name) ?? [];
    const stray = versions.find((version) => version !== pinned.get(name) && !held.includes(version));
    if (stray !== undefined) return `${file} excludes ${name}@${stray} from the release age, which the branch does not and the pin is not`;
  }
  return null;
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

// --- pnpm-lock.yaml -------------------------------------------------------------------------------------------------
// The push job reads a pnpm-lock.yaml with one tokenizer, parsePnpmLock, and with nothing else: every rule below works
// on the tree it returns, and no line of the file is read a second time. The tokenizer takes only the exact form pnpm
// writes, so pnpm's YAML parser reads the same tree from any file it accepts.

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
/** A plain value inside the one-line `{...}` of engines: no quotes, commas, brackets or comments. */
const FLOW_PLAIN = String.raw`[^\s,[\]{}#&*!|=>'"%@\`?:-](?:[^\s,[\]{}#:'"]|:(?=[^\s,}])| (?=[^\s,}#:]))*`;
const FLOW_PAIR = new RegExp(String.raw`([A-Za-z][A-Za-z0-9]*|'[0-9]+'): ('(?:[^']|'')*'|${FLOW_PLAIN})(, |\}$)`, 'y');
const FLOW_ITEM = String.raw`(?:[A-Za-z0-9][A-Za-z0-9_.-]*|'[!A-Za-z0-9_.-]+')`;
const FLOW_LIST = new RegExp(`^\\[${FLOW_ITEM}(?:, ${FLOW_ITEM})*\\]$`);
/** The only keys of a resolution, and what each value is: one token, no whitespace. */
const RESOLUTION = new Map([['integrity', /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/], ['tarball', /^https:\/\/[A-Za-z0-9@._~:/+-]+$/]]);
const unquoted = (token) => token.slice(1, -1).replace(/''/g, "'");

/**
 * A one-line `{key: value, ...}` as { pairs } (a Map, in order) or { why }. The line must close on itself and hold at
 * least one pair; no key twice; every value a string. A resolution is exactly `{integrity: <hash>}` or
 * `{integrity: <hash>, tarball: <https url>}`: those keys only, plain, each value one token.
 */
function flowMap(value, resolution) {
  const pairs = new Map();
  if (value.length < 3 || !value.startsWith('{') || !value.endsWith('}')) return { why: 'a one-line mapping that is empty or does not close on its line' };
  for (let at = 1; at < value.length;) {
    FLOW_PAIR.lastIndex = at;
    const pair = FLOW_PAIR.exec(value);
    if (!pair) return { why: 'not a one-line mapping pnpm writes' };
    const quotedKey = pair[1].startsWith("'"), quotedValue = pair[2].startsWith("'");
    const key = quotedKey ? unquoted(pair[1]) : pair[1], text = quotedValue ? unquoted(pair[2]) : pair[2];
    if (pairs.has(key)) return { why: `the key ${key} twice` };
    if (!quotedValue && !plainScalar(text)) return { why: `a value of ${key} that is not a string` };
    if (resolution && (quotedKey || quotedValue || !RESOLUTION.get(key)?.test(text))) return { why: 'a resolution that is not {integrity: <hash>} or {integrity: <hash>, tarball: <https url>}' };
    pairs.set(key, text);
    at = FLOW_PAIR.lastIndex;
  }
  if (resolution && !pairs.has('integrity')) return { why: 'a resolution without an integrity' };
  return { pairs };
}

/** The escapes js-yaml reads in a double-quoted scalar. */
const ESCAPES = new Map([['0', '\0'], ['a', '\x07'], ['b', '\b'], ['t', '\t'], ['n', '\n'], ['v', '\v'], ['f', '\f'], ['r', '\r'], ['e', '\x1b'], [' ', ' '], ['"', '"'],
  ['/', '/'], ['\\', '\\'], ['N', '\x85'], ['_', '\xa0'], ['L', ' '], ['P', ' ']]);
/** The string a one-line double-quoted scalar holds, or null when it is not one js-yaml reads. */
function doubleQuoted(value) {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return null;
  let text = '';
  for (let at = 1; at < value.length - 1; at += 1) {
    const char = value[at];
    if (char === '"') return null;
    if (char !== '\\') { text += char; continue; }
    const next = value[at + 1], digits = { x: 2, u: 4, U: 8 }[next];
    if (at + 1 >= value.length - 1) return null;
    if (ESCAPES.has(next)) { text += ESCAPES.get(next); at += 1; continue; }
    const hex = digits ? value.slice(at + 2, at + 2 + digits) : '';
    if (!digits || at + 1 + digits >= value.length - 1 || !new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex) || parseInt(hex, 16) > 0x10ffff) return null;
    text += String.fromCodePoint(parseInt(hex, 16));
    at += 1 + digits;
  }
  return text;
}

/** One plain or single-quoted scalar as the value YAML gives it (a string, true, false or an integer), or undefined. */
function scalarValue(token) {
  if (token.startsWith("'")) return /^'(?:[^']|'')*'$/.test(token) ? unquoted(token) : undefined;
  if (token === 'true' || token === 'false') return token === 'true';
  if (/^(?:0|[1-9][0-9]{0,14})$/.test(token)) return Number(token);
  return plainScalar(token) ? token : undefined;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const PACKAGE_SHAPES = new Map([['resolution', 'map'], ['engines', 'map'], ['cpu', 'list'], ['os', 'list'], ['libc', 'list'], ['peerDependencies', 'block'],
  ['peerDependenciesMeta', 'block'], ['hasBin', 'true'], ['deprecated', 'string'], ['bundledDependencies', 'items']]);
const SNAPSHOT_SHAPES = new Map([['dependencies', 'block'], ['optionalDependencies', 'block'], ['transitivePeerDependencies', 'items'], ['optional', 'true']]);
/**
 * The one shape pnpm gives a key the check reads, by where it is (`parents`: the keys it is under, from the section
 * down): 'block' (keys on the lines below), 'items' (a list on the lines below), 'string', 'true', 'map' ({...}),
 * 'list' ([...]) or 'entry' (a block, or `{}`); undefined where the check reads nothing.
 */
function lockShape(parents, key) {
  const [section, , field] = parents, depth = parents.length;
  if (depth === 1) return section === 'packages' ? 'block' : section === 'importers' || section === 'snapshots' ? 'entry' : undefined;
  if (section === 'importers') {
    if (depth === 2) return DEP_FIELDS.includes(key) ? 'block' : undefined;
    return DEP_FIELDS.includes(field) ? (depth === 3 ? 'block' : 'string') : undefined;
  }
  if (section === 'packages') {
    if (depth === 2) return PACKAGE_SHAPES.get(key);
    if (field === 'peerDependencies') return 'string';
    return field === 'peerDependenciesMeta' ? (depth === 3 ? 'block' : undefined) : undefined;
  }
  if (section === 'snapshots') {
    if (depth === 2) return SNAPSHOT_SHAPES.get(key);
    return field === 'dependencies' || field === 'optionalDependencies' ? 'string' : undefined;
  }
  return undefined;
}

/**
 * A pnpm-lock.yaml as a tree, `lock`, or why it is not in the exact form pnpm writes, `error` ({ line, why }): one of
 * the two is undefined.
 * A mapping is a Map (in file order), a list an Array, a scalar a string, true, false or an integer. This is the only
 * reader of the file: it takes the subset of YAML pnpm emits and refuses the rest instead of interpreting it, so that
 * pnpm's YAML parser reads the same tree from every file it takes.
 *   - LF only, no tab, control or non-character, no lone surrogate, one final newline, no trailing space; the first
 *     line is `lockfileVersion: '9.0'`; a blank line only before a line indented 0 or 2, never two together;
 *   - every other line is `<key>:` (opening a block, whose first line is indented exactly two more), `<key>: <value>`
 *     or `- <value>`; indentation is in steps of two and a line dedents only to an open block; a block is either all
 *     keys or all list items; a key that opens a block has one (no empty values); no key twice in a block;
 *   - a key is plain or single-quoted, quoted exactly when js-yaml would quote it (in practice: it starts with `@`),
 *     and made of package-name, version, range and path characters only (no colon, space, `#` or quote);
 *   - a value is one plain or single-quoted scalar on its line (plain: no ": ", no " #", no leading indicator, so no
 *     anchor, alias, tag, merge key, comment, block scalar, directive or document marker); `true`, `false` and
 *     integers are the only plain values that are not strings; a list item is a string;
 *   - the inline forms, each only where pnpm writes it and each closed on its line: `{}` as a whole snapshots or
 *     importers entry; `resolution: {integrity: <hash>}` or `{integrity: <hash>, tarball: <https url>}` on a packages
 *     entry (those keys only, plain, one token each); `engines: {key: plain-or-quoted, ...}` on a packages entry (a
 *     key may be a quoted number: pnpm writes a package.json whose engines is a list as `{'0': ...}`); `cpu:`, `os:`,
 *     `libc: [a, b]` on a packages entry; `deprecated: "..."` on a packages entry, with the escapes js-yaml reads;
 *   - where the check reads a value, it has the one shape pnpm gives it (lockShape): an importer's dependencies are
 *     blocks of `specifier` and `version` strings; a snapshot's dependencies and optionalDependencies are blocks of
 *     strings, its transitivePeerDependencies a list and its optional `true`; a package's peerDependencies is a block
 *     of strings, its peerDependenciesMeta a block of blocks and its hasBin `true`.
 */
export function parsePnpmLock(text) {
  const fail = (line, why) => ({ lock: undefined, error: { line, why } });
  if (typeof text !== 'string' || !text.endsWith('\n') || text.endsWith('\n\n')) return fail(0, 'it must end with one newline');
  for (let at = 0, line = 1; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 10) line += 1;
    else if (code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 || code === 0xfeff || code >= 0xfffe) return fail(line, 'a tab, carriage return, control character or non-character');
    else if (code >= 0xd800 && code <= 0xdfff) {
      const next = text.charCodeAt(at + 1);
      if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return fail(line, 'half of a surrogate pair');
      at += 1;
    }
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines[0] !== "lockfileVersion: '9.0'") return fail(1, "the first line must be lockfileVersion: '9.0'");
  const lock = new Map();
  /** The open blocks, outermost first: their indentation, the Map or Array being filled, and the key that opened them. */
  const stack = [{ indent: 0, node: lock, name: null }];
  let opener = null, blank = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i], n = i + 1;
    if (line === '') {
      if (blank) return fail(n, 'two blank lines');
      blank = true;
      continue;
    }
    const indent = /^ */.exec(line)[0].length, rest = line.slice(indent);
    if (indent % 2 || line.endsWith(' ')) return fail(n, 'odd indentation or a trailing space');
    if (blank && indent > 2) return fail(n, 'a blank line inside an entry');
    blank = false;
    const item = rest.startsWith('- ') ? rest.slice(2) : null;
    if (opener) {
      if (indent !== opener.indent + 2) return fail(n, `${opener.key} has no value`);
      const shape = item !== null ? 'items' : 'block';
      if (opener.shape !== undefined && opener.shape !== shape && !(opener.shape === 'entry' && shape === 'block')) return fail(n, `${opener.key} is not written as pnpm writes it there`);
      const node = item !== null ? [] : new Map();
      opener.into.set(opener.key, node);
      stack.push({ indent, node, name: opener.key });
      opener = null;
    } else {
      while (stack.at(-1).indent > indent) stack.pop();
      if (stack.at(-1).indent !== indent) return fail(n, 'indentation that matches no open block');
    }
    const block = stack.at(-1);
    if (Array.isArray(block.node) !== (item !== null)) return fail(n, 'a list item and a key in one block');
    if (item !== null) {
      const value = scalarValue(item);
      if (typeof value !== 'string') return fail(n, 'a list item that is not one plain or single-quoted string');
      block.node.push(value);
      continue;
    }
    const quoted = /^'((?:[^']|'')*)'(?::$|: (.+)$)/.exec(rest), plain = quoted ? null : /^([^\s:'"]+)(?::$|: (.+)$)/.exec(rest);
    if (!quoted && !plain) return fail(n, 'not a key and a value');
    const key = quoted ? quoted[1].replace(/''/g, "'") : plain[1], value = (quoted ?? plain)[2];
    if (!LOCK_KEY.test(key) || key === '__proto__' || plainScalar(key) === Boolean(quoted) || (indent === 0 && !/^[A-Za-z][A-Za-z0-9]*$/.test(key))) return fail(n, 'a key pnpm would not write that way');
    if (block.node.has(key)) return fail(n, `the key ${key} twice`);
    const parents = stack.slice(1).map((open) => open.name), shape = lockShape(parents, key);
    const misplaced = `${key} is not written as pnpm writes it there`;
    if (value === undefined) {
      if (shape !== undefined && !['block', 'items', 'entry'].includes(shape)) return fail(n, misplaced);
      block.node.set(key, null);
      opener = { indent, key, shape, into: block.node };
    } else if (value === '{}') {
      if (shape !== 'entry') return fail(n, 'an empty mapping where pnpm writes none');
      block.node.set(key, new Map());
    } else if (value.startsWith('{')) {
      const map = shape === 'map' ? flowMap(value, key === 'resolution') : { why: 'a one-line mapping where pnpm writes none' };
      if (map.why) return fail(n, map.why);
      block.node.set(key, map.pairs);
    } else if (value.startsWith('[')) {
      const tokens = shape === 'list' && FLOW_LIST.test(value) ? value.slice(1, -1).split(', ') : [];
      if (!tokens.length || tokens.some((token) => !token.startsWith("'") && !plainScalar(token))) return fail(n, 'a one-line list where pnpm writes none, or not a list of strings pnpm writes');
      block.node.set(key, tokens.map((token) => (token.startsWith("'") ? unquoted(token) : token)));
    } else if (value.startsWith('"')) {
      const string = parents.length === 2 && parents[0] === 'packages' && key === 'deprecated' ? doubleQuoted(value) : null;
      if (string === null) return fail(n, 'a double-quoted value where pnpm writes none, or not one js-yaml reads');
      block.node.set(key, string);
    } else {
      const scalar = scalarValue(value);
      if (scalar === undefined) return fail(n, 'a value that is not one plain or single-quoted scalar');
      if (shape !== undefined && !(shape === 'string' ? typeof scalar === 'string' : shape === 'true' && scalar === true)) return fail(n, misplaced);
      block.node.set(key, scalar);
    }
  }
  return opener ? fail(lines.length, `${opener.key} has no value`) : { lock, error: undefined };
}

/** Refusal unless a pnpm-lock.yaml is in the exact form pnpm writes (parsePnpmLock); null when it is. */
export function pnpmFormRefusal(file, text) {
  const { error } = parsePnpmLock(text);
  return error ? `${file}${error.line ? ` line ${error.line}` : ''} is not in the form pnpm writes (${error.why}), so it cannot be checked` : null;
}

/** A parsed lockfile value as plain JSON data (Maps as objects), to compare two of them whatever their key order. */
function plainValue(node) {
  if (node instanceof Map) return Object.fromEntries([...node].map(([key, value]) => [key, plainValue(value)]));
  return Array.isArray(node) ? node.map(plainValue) : node;
}
const sameValue = (a, b) => canonical(plainValue(a) ?? null) === canonical(plainValue(b) ?? null);
/** A section or field of a parsed lockfile as a Map (an absent one is empty). */
const mapOf = (node) => (node instanceof Map ? node : new Map());

const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * The name, exact version and peer suffix of a packages or snapshots key, '<name>@<version>' then '(...)'; null when
 * the key is anything else (an alias, a URL, a version that is not exact), and such an entry is never acted on.
 */
function packageKey(key) {
  const at = key.indexOf('@', 1);
  if (at < 0) return null;
  const rest = key.slice(at + 1), paren = rest.indexOf('(');
  const name = key.slice(0, at), version = paren < 0 ? rest : rest.slice(0, paren);
  return PACKAGE_NAME.test(name) && EXACT.test(version) ? { name, version, suffix: paren < 0 ? '' : rest.slice(paren) } : null;
}
/** The peers a snapshot key's suffix names, '(name@reference)(...)' -> [[name, reference]], or null when it is not that. */
function suffixPeers(suffix) {
  const peers = [];
  for (let at = 0; at < suffix.length;) {
    let depth = 0, end = at;
    if (suffix[at] !== '(') return null;
    for (; end < suffix.length; end += 1) {
      if (suffix[end] === '(') depth += 1;
      else if (suffix[end] === ')' && (depth -= 1) === 0) break;
    }
    const inner = suffix.slice(at + 1, end), split = inner.indexOf('@', 1);
    if (end >= suffix.length || split < 0) return null;
    peers.push([inner.slice(0, split), inner.slice(split + 1)]);
    at = end + 1;
  }
  return peers;
}
/** The GitHub Packages download URL of a @revt-eng package version, by its parts; `hash` is the registry's file id. */
const downloadUrl = (name, version) => new RegExp(`^https://npm\\.pkg\\.github\\.com/download/${escapeRe(name)}/${escapeRe(version)}/[0-9a-f]+$`);

/**
 * Whether an exact version is in an npm range, for the ranges this reads: comparators (^ ~ >= > <= < =), bare and
 * partial versions (1, 1.2, 1.x), `*`, hyphen ranges and `||`. A prerelease is in a range only when a comparator
 * names a prerelease of the same version, as in npm. Anything it does not read is not in range.
 */
export function inRange(version, range) {
  if (!EXACT.test(String(version ?? '')) || typeof range !== 'string') return false;
  const below = (upper) => compareSemver(version, `${upper}-0`) < 0;
  const core = (text) => text.replace(/-.*$/, '');
  return range.split('||').some((alternative) => {
    const text = alternative.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1');
    if (text === '' || text === '*' || text === 'x') return !isPrerelease(version);
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    const comparators = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : text.split(/\s+/);
    let named = !isPrerelease(version);
    return comparators.every((comparator) => {
      const match = /^(\^|~|>=|<=|>|<|=)?v?([0-9][0-9A-Za-z.+-]*?)((?:\.[xX*]){0,2})$/.exec(comparator);
      const parts = match && PARTIAL.exec(match[2]);
      if (!parts || (match[3] && parts[4] !== undefined)) return false;
      const [major, minor, patch] = [parts[1], match[3].length > 2 ? undefined : parts[2], match[3] ? undefined : parts[3]].map((part) => (part === undefined ? undefined : Number(part)));
      const lower = `${major}.${minor ?? 0}.${patch ?? 0}${parts[4] !== undefined ? `-${parts[4]}` : ''}`, whole = patch !== undefined;
      if (parts[4] !== undefined && core(lower) === core(version)) named = true;
      const next = minor === undefined ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
      switch (match[1] ?? (whole ? '=' : 'x')) {
        case '=': return whole && compareSemver(version, lower) === 0;
        case '>=': return compareSemver(version, lower) >= 0;
        case '>': return whole && compareSemver(version, lower) > 0;
        case '<': return compareSemver(version, lower) < 0;
        case '<=': return whole && compareSemver(version, lower) <= 0;
        case '~': case 'x': return compareSemver(version, lower) >= 0 && below(next);
        default: {
          const caret = major > 0 || minor === undefined ? `${major + 1}.0.0` : minor > 0 || patch === undefined ? `0.${minor + 1}.0` : `0.0.${patch + 1}`;
          return compareSemver(version, lower) >= 0 && below(caret);
        }
      }
    }) && named;
  });
}

/**
 * The peers a packages entry marks optional, as { flags } (peer -> true|false) or { refusal }: peerDependenciesMeta
 * may hold nothing but `optional: true|false` for peers the entry declares in peerDependencies.
 */
function optionalPeers(entry) {
  const declared = mapOf(entry.get('peerDependencies')), flags = new Map();
  for (const [name, meta] of mapOf(entry.get('peerDependenciesMeta'))) {
    if (!(meta instanceof Map) || meta.size !== 1 || typeof meta.get('optional') !== 'boolean') return { refusal: 'gives peerDependenciesMeta more than optional flags' };
    if (!declared.has(name)) return { refusal: `marks ${name} optional, which is not one of its peers` };
    flags.set(name, meta.get('optional'));
  }
  return { flags };
}
/** The peers an entry marks `optional: true` (none when its flags are refused). */
const optionalPeerNames = (entry) => new Set([...(optionalPeers(entry).flags ?? [])].filter(([, optional]) => optional).map(([name]) => name));

/**
 * Why a packages entry's peerDependenciesMeta is not one pnpm writes for this package, or null. pnpm writes two forms:
 * none (the version was resolved from GitHub Packages' metadata, which omits the field) or exactly the
 * peerDependenciesMeta of the package's own package.json (read from its tarball). `manifests` maps name@version to
 * { integrity, manifest }: the package.json of the tarball with that sha512, which the push job downloaded and hashed
 * itself (readManifests). An entry with flags and no such manifest is refused.
 */
function peerMetaRefusal(key, entry, manifests) {
  const peers = optionalPeers(entry);
  if (peers.refusal) return peers.refusal;
  if (!entry.has('peerDependenciesMeta')) return null;
  const verified = manifests?.get(key);
  if (!verified || verified.integrity !== mapOf(entry.get('resolution')).get('integrity')) return "marks peers optional, which could not be checked against the package's own package.json";
  const published = verified.manifest?.peerDependenciesMeta;
  const written = Object.fromEntries([...peers.flags].map(([name, optional]) => [name, { optional }]));
  if (!published || typeof published !== 'object' || canonical(written) !== canonical(published)) return "marks other peers optional than the package's own package.json does";
  return null;
}

/**
 * Why a packages entry that keeps its key may not change from `a` to `b`, or null. Only a GitHub Packages package
 * (@revt-eng/*) may, and only in peerDependenciesMeta, to one of the two forms pnpm writes (peerMetaRefusal). The
 * resolution (integrity and tarball), the peers and every other field stay as they are, value for value.
 */
function packagesEntryRefusal(key, a, b, manifests) {
  const parsed = packageKey(key);
  if (!parsed || !SCOPED.test(parsed.name)) return 'changes';
  for (const field of new Set([...a.keys(), ...b.keys()])) {
    if (field === 'peerDependenciesMeta') continue;
    if (!a.has(field) || !b.has(field) || !sameValue(a.get(field), b.get(field))) return 'changes more than which of its peers are optional';
  }
  return peerMetaRefusal(key, b, manifests);
}

/** The fields pnpm writes on a packages entry and on a snapshots entry. */
const PACKAGE_FIELDS = new Set(['resolution', 'engines', 'peerDependencies', 'peerDependenciesMeta', 'hasBin', 'deprecated', 'cpu', 'os', 'libc', 'bundledDependencies']);
const SNAPSHOT_FIELDS = new Set(['dependencies', 'optionalDependencies', 'transitivePeerDependencies', 'optional']);
const names = (record) => new Set(record && typeof record === 'object' ? Object.keys(record) : []);

/**
 * Why a packages entry a pin adds is not that version as its registry publishes it, or null: only fields pnpm writes;
 * for a @revt-eng package, the tarball is the GitHub Packages download of exactly that name and version; its peers are
 * the registry's peerDependencies by name (plus a peer its verified package.json marks optional without declaring);
 * its optional peers are one of the two forms pnpm writes (peerMetaRefusal); and engines, cpu, os, libc, hasBin and
 * deprecated are what the registry lists for the version (hasBin: whether it has a bin), where it lists them. A field
 * the registry does not list for the version is not compared: GitHub Packages leaves fields out of its metadata.
 */
function newPackageRefusal(key, parsed, entry, declared, manifests) {
  const unknown = [...entry.keys()].find((field) => !PACKAGE_FIELDS.has(field));
  if (unknown !== undefined) return `has ${unknown}, which pnpm does not write on a package`;
  if (SCOPED.test(parsed.name) && !downloadUrl(parsed.name, parsed.version).test(mapOf(entry.get('resolution')).get('tarball') ?? '')) return 'does not resolve from the GitHub Packages download of that name and version';
  const refused = peerMetaRefusal(key, entry, manifests);
  if (refused) return refused;
  const peers = names(declared?.peerDependencies), flagged = optionalPeers(entry).flags;
  const written = [...mapOf(entry.get('peerDependencies')).keys()];
  const stray = written.find((name) => !peers.has(name) && !flagged.has(name)) ?? [...peers].find((name) => !written.includes(name));
  if (stray !== undefined) return `does not have the registry's peers (${stray})`;
  const engines = Array.isArray(declared?.engines) ? Object.fromEntries(declared.engines.map((value, index) => [String(index), value])) : declared?.engines;
  const bin = declared?.bin, hasBin = typeof bin === 'string' ? bin !== '' : Boolean(bin && typeof bin === 'object' && Object.keys(bin).length) || Boolean(declared?.directories?.bin);
  // [field, what the entry has, what the registry lists]: compared where the registry lists the field.
  const differs = [
    ['engines', plainValue(entry.get('engines')) ?? {}, engines],
    ['cpu', entry.get('cpu') ?? [], declared?.cpu], ['os', entry.get('os') ?? [], declared?.os], ['libc', entry.get('libc') ?? [], declared?.libc],
    ['hasBin', entry.get('hasBin') === true, bin === undefined && declared?.directories?.bin === undefined ? undefined : hasBin],
    ['deprecated', entry.get('deprecated') ?? '', declared?.deprecated],
  ].find(([, wrote, published]) => published !== undefined && canonical(wrote) !== canonical(published));
  return differs ? `does not have the registry's ${differs[0]}` : null;
}

/** The edges of a snapshots entry: its dependencies and optionalDependencies (name -> reference). */
const edgesOf = (entry) => ({ dependencies: mapOf(entry.get('dependencies')), optionalDependencies: mapOf(entry.get('optionalDependencies')) });

/**
 * Why a snapshots entry a pin adds is not an install of that version as its registry publishes it, or null:
 *   - only the fields pnpm writes;
 *   - under dependencies, only names the registry lists in the version's dependencies, or a peer the entry does not
 *     mark optional; under optionalDependencies, only its optionalDependencies, or a peer the entry marks optional
 *     (flags checked against the package's own package.json, peerMetaRefusal); no name under both;
 *   - the peer suffix of its key names exactly its own peer edges, each at the reference the edge has (or at that
 *     reference without its own suffix, which is how pnpm writes a peer that depends back on it), plus peers it
 *     lists under transitivePeerDependencies and the lockfile has a snapshot of (`exists`).
 * Where each edge points is checked by the caller (edgeRefusal); that every edge names a snapshot the lockfile has,
 * that something depends on the entry and that its `optional: true` is the graph's, for the whole lockfile (lockGraph).
 */
function newSnapshotRefusal(parsed, entry, declared, optional, exists) {
  const unknown = [...entry.keys()].find((field) => !SNAPSHOT_FIELDS.has(field));
  if (unknown !== undefined) return `has ${unknown}, which pnpm does not write on a snapshot`;
  const { dependencies, optionalDependencies } = edgesOf(entry);
  const listed = names(declared?.dependencies), optionals = names(declared?.optionalDependencies), peers = names(declared?.peerDependencies);
  for (const name of dependencies.keys()) {
    if (optionalDependencies.has(name)) return `lists ${name} under dependencies and optionalDependencies`;
    if (!listed.has(name) && !(peers.has(name) && !optional.has(name))) return `depends on ${name}, which the registry does not list as a dependency or required peer of it`;
  }
  for (const name of optionalDependencies.keys()) {
    if (!optionals.has(name) && !(peers.has(name) && optional.has(name))) return `optionally depends on ${name}, which the registry does not list as an optional dependency or optional peer of it`;
  }
  const suffix = suffixPeers(parsed.suffix), transitive = new Set(Array.isArray(entry.get('transitivePeerDependencies')) ? entry.get('transitivePeerDependencies') : []);
  if (suffix === null) return 'has a peer suffix this check cannot read; pin it by hand';
  const edge = (name) => dependencies.get(name) ?? optionalDependencies.get(name);
  const stray = suffix.find(([name, reference]) => (edge(name) === undefined ? !transitive.has(name) || !exists(snapshotKey(name, reference)) : edge(name) !== reference && !edge(name).startsWith(`${reference}(`)))?.[0]
    ?? [...peers].find((name) => edge(name) !== undefined && !listed.has(name) && !optionals.has(name) && !suffix.some(([peer]) => peer === name));
  return stray === undefined ? null : `has a peer suffix that does not match its peer ${stray}`;
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
 * A parsed lockfile's own dependency graph, from its importers and snapshots sections:
 *   required    the snapshots reachable from an importer's dependencies or devDependencies through snapshots'
 *               dependencies; pnpm marks every other snapshot `optional: true`;
 *   referenced  every snapshot an importer or a snapshot depends on, optionally or not;
 *   dangling    a referenced key the lockfile has no snapshot for, or undefined.
 */
export function lockGraph(importers, snapshots) {
  const roots = [], referenced = new Set(), edges = new Map();
  for (const importer of importers.values()) {
    for (const field of DEP_FIELDS) {
      for (const [name, dep] of mapOf(importer.get(field))) {
        const version = mapOf(dep).get('version'), key = typeof version === 'string' ? snapshotKey(name, version) : null;
        if (key === null) continue;
        referenced.add(key);
        if (field !== 'optionalDependencies') roots.push(key);
      }
    }
  }
  for (const [key, entry] of snapshots) {
    const { dependencies, optionalDependencies } = edgesOf(entry);
    const keys = (pairs) => [...pairs].map(([name, reference]) => snapshotKey(name, reference)).filter((target) => target !== null);
    edges.set(key, keys(dependencies));
    for (const target of [...edges.get(key), ...keys(optionalDependencies)]) referenced.add(target);
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
 * A pnpm-lock.yaml change that only re-pins. Both files are read with parsePnpmLock, so both must be in the form pnpm
 * writes. Then: every section but importers, packages and snapshots unchanged; in the importers only the pinned
 * packages' specifier and version change (the version to exactly the pin, peers allowed); in packages and snapshots
 * only the pinned packages' entries go and come, the new ones exactly at the pin; a pinned package's entry has the
 * registry's integrity and tarball whether the pin adds it or the branch had it already; a new packages entry has the
 * registry's resolution, peers and metadata (newPackageRefusal), a new snapshots entry only edges the registry
 * declares for that version (newSnapshotRefusal), each pointing at a pinned package's pin, where the snapshot it
 * replaces pointed or, for a new name, in the range the registry declares (edgeRefusal below).
 *
 * An entry that stays may change in one way, which pnpm does on its own whenever it runs (packagesEntryRefusal): which
 * peers of a @revt-eng package are optional, to none or to exactly what the package's own package.json says. What
 * follows from that is allowed and nothing else: in that package's snapshots, exactly the peers whose flag differs
 * move between dependencies and optionalDependencies, at the same references; and a snapshot gains or loses
 * `optional: true` only when the new lockfile's own graph says so (lockGraph). In the new lockfile every edge names a
 * snapshot it has, and something depends on every snapshot the pin adds.
 */
export function pnpmLockRefusal(file, beforeText, afterText, pins, registry, manifests = new Map()) {
  const malformed = pnpmFormRefusal(`${file} on the branch`, beforeText) ?? pnpmFormRefusal(file, afterText);
  if (malformed) return malformed;
  const pinned = new Map(pins.map((pin) => [pin.name, pin.version]));
  const before = parsePnpmLock(beforeText).lock, after = parsePnpmLock(afterText).lock;
  const sameKeys = (a, b) => canonical([...a.keys()].sort()) === canonical([...b.keys()].sort());
  if (!sameKeys(before, after)) return `${file} adds or removes a section`;
  for (const [key, value] of before) {
    if (['importers', 'packages', 'snapshots'].includes(key)) continue;
    if (!sameValue(value, after.get(key))) return `${file} changes its ${key}`;
  }
  const section = (lock, name) => mapOf(lock.get(name));
  const importersA = section(before, 'importers'), importersB = section(after, 'importers');
  if (!sameKeys(importersA, importersB)) return `${file} adds or removes an importer`;
  for (const [importer, fieldsA] of importersA) {
    const fieldsB = importersB.get(importer);
    if (!sameKeys(fieldsA, fieldsB)) return `${file}: importer ${importer} adds or removes a field`;
    for (const [field, valueA] of fieldsA) {
      const valueB = fieldsB.get(field);
      if (!DEP_FIELDS.includes(field)) {
        if (!sameValue(valueA, valueB)) return `${file}: importer ${importer} changes ${field}`;
        continue;
      }
      if (!sameKeys(valueA, valueB)) return `${file}: importer ${importer} adds or removes a dependency`;
      for (const [name, depA] of valueA) {
        const depB = valueB.get(name);
        if (sameValue(depA, depB)) continue;
        if (!pinned.has(name)) return `${file}: importer ${importer} changes ${name}, which is not being pinned`;
        const version = depB.get('version');
        if (depB.size !== 2 || typeof depB.get('specifier') !== 'string' || typeof version !== 'string') return `${file}: importer ${importer} gives ${name} more than a specifier and a version`;
        const locked = packageKey(`${name}@${version}`);
        if (locked?.version !== pinned.get(name)) return `${file}: importer ${importer} locks ${name} at ${version}, not the pinned ${pinned.get(name)}`;
      }
    }
  }
  const packagesA = section(before, 'packages'), packagesB = section(after, 'packages');
  const snapshotsA = section(before, 'snapshots'), snapshotsB = section(after, 'snapshots');
  /** The snapshots whose `optional: true` must be the graph's: the ones that changed it, and the ones the pin adds. */
  const flips = [], added = [];
  /** Why a snapshots entry that keeps its key may not change, or null; `flips` collects a changed `optional: true`. */
  const snapshotRefusal = (key, entryA, entryB) => {
    const a = edgesOf(entryA), b = edgesOf(entryB);
    const rest = (entry) => new Map([...entry].filter(([field]) => !['dependencies', 'optionalDependencies', 'optional'].includes(field)));
    const edges = (entry) => new Map([...entry.dependencies, ...entry.optionalDependencies]);
    const twice = (entry) => [...entry.optionalDependencies.keys()].some((name) => entry.dependencies.has(name));
    if (!sameValue(rest(entryA), rest(entryB)) || twice(a) || twice(b) || !sameValue(edges(a), edges(b))) return 'changes';
    const moved = [...b.dependencies.keys(), ...b.optionalDependencies.keys()].filter((name) => a.optionalDependencies.has(name) !== b.optionalDependencies.has(name));
    if (moved.length) {
      const parsed = packageKey(key);
      const entry = parsed && SCOPED.test(parsed.name) ? `${parsed.name}@${parsed.version}` : null;
      if (!entry || !packagesA.has(entry) || !packagesB.has(entry)) return 'changes';
      const was = optionalPeerNames(packagesA.get(entry)), now = optionalPeerNames(packagesB.get(entry));
      const stray = moved.find((name) => was.has(name) !== a.optionalDependencies.has(name) || now.has(name) !== b.optionalDependencies.has(name));
      if (stray !== undefined) return `moves ${stray} between dependencies and optionalDependencies, which its peers' optional flags do not explain`;
    }
    if ((entryA.get('optional') === true) !== (entryB.get('optional') === true)) flips.push(key);
    return null;
  };
  /** The branch head's snapshots by package name, and the ones of a package that the pin drops. */
  const headKeys = new Map();
  for (const key of snapshotsA.keys()) {
    const name = packageKey(key)?.name;
    if (name !== undefined) headKeys.set(name, [...(headKeys.get(name) ?? []), key]);
  }
  const replaced = (name) => (headKeys.get(name) ?? []).filter((key) => !snapshotsB.has(key)).map((key) => edgesOf(snapshotsA.get(key)));
  /**
   * Why an edge of a snapshot the pin adds does not point where a pin may point it, or null. It points at a pinned
   * package only at its pin. An edge whose name a snapshot of the package that the pin replaces already had points
   * where one of those did. An edge with a new name points at the branch head's only snapshot of the named package,
   * or at a version in the range the registry declares for the name. Anything else is for a person to pin.
   */
  const edgeRefusal = (owner, name, reference, range) => {
    const target = snapshotKey(name, reference), to = target === null ? null : packageKey(target);
    if (!to) return `depends on ${name} at ${reference}, which this check cannot place; pin it by hand`;
    if (pinned.has(to.name)) return to.version === pinned.get(to.name) ? null : `depends on ${to.name} at ${to.version}, not at its pin ${pinned.get(to.name)}`;
    const was = replaced(owner).map((edges) => edges.dependencies.get(name) ?? edges.optionalDependencies.get(name)).filter((old) => old !== undefined);
    if (was.length) return was.some((old) => snapshotKey(name, old) === target) ? null : `depends on ${name} at ${to.version}, not where the snapshot it replaces pointed; pin it by hand`;
    const only = headKeys.get(to.name) ?? [];
    if ((only.length === 1 && only[0] === target) || (to.name === name && inRange(to.version, range))) return null;
    return `depends on ${name} at ${to.version}, which is neither the branch's only snapshot of it nor in the registry's range ${JSON.stringify(range ?? null)}; pin it by hand`;
  };
  for (const [sectionName, a, b] of [['packages', packagesA, packagesB], ['snapshots', snapshotsA, snapshotsB]]) {
    for (const [key, entry] of a) {
      if (b.has(key)) {
        if (sameValue(entry, b.get(key))) continue;
        const refused = sectionName === 'packages' ? packagesEntryRefusal(key, entry, b.get(key), manifests) : snapshotRefusal(key, entry, b.get(key));
        if (refused) return `${file}: ${sectionName} ${key} ${refused}`;
        continue;
      }
      const parsed = packageKey(key);
      if (!parsed || !pinned.has(parsed.name)) return `${file}: ${sectionName} drops ${key}, which is not being pinned`;
    }
    for (const [key, entry] of b) {
      if (a.has(key)) continue;
      const parsed = packageKey(key);
      if (!parsed || pinned.get(parsed.name) !== parsed.version) return `${file}: ${sectionName} adds ${key}, which is not a pinned package at its pin`;
      const declared = registry?.get(parsed.name)?.[parsed.version];
      if (sectionName === 'packages') {
        const resolution = mapOf(entry.get('resolution'));
        const refused = resolutionRefusal(`${file} packages ${key}`, parsed.name, parsed.version, resolution.get('integrity'), resolution.get('tarball'), registry);
        if (refused) return refused;
        const shaped = parsed.suffix ? 'has a peer suffix' : newPackageRefusal(key, parsed, entry, declared, manifests);
        if (shaped) return `${file}: packages ${key} ${shaped}`;
        continue;
      }
      const owner = `${parsed.name}@${parsed.version}`;
      if (!declared || !packagesB.has(owner)) return `${file}: snapshots ${key} is of a package the lockfile or the registry does not have`;
      const { dependencies, optionalDependencies } = edgesOf(entry);
      const refused = newSnapshotRefusal(parsed, entry, declared, optionalPeerNames(packagesB.get(owner)), (target) => target !== null && snapshotsB.has(target))
        ?? [...dependencies, ...optionalDependencies].map(([name, reference]) => edgeRefusal(parsed.name, name, reference,
          (dependencies.has(name) ? declared.dependencies?.[name] : declared.optionalDependencies?.[name]) ?? declared.peerDependencies?.[name])).find((why) => why !== null);
      if (refused) return `${file}: snapshots ${key} ${refused}`;
      added.push(key);
    }
  }
  // A pinned package resolves from its registry whether the pin adds its entry or the branch already had one.
  for (const [name, version] of pinned) {
    const key = `${name}@${version}`, resolution = mapOf(packagesB.get(key)?.get('resolution'));
    if (!packagesB.has(key)) continue;
    const refused = resolutionRefusal(`${file} packages ${key}`, name, version, resolution.get('integrity'), resolution.get('tarball'), registry);
    if (refused) return refused;
    if (SCOPED.test(name) && !downloadUrl(name, version).test(resolution.get('tarball') ?? '')) return `${file}: packages ${key} does not resolve from the GitHub Packages download of that name and version`;
  }
  const graph = lockGraph(importersB, snapshotsB);
  if (graph.dangling !== undefined) return `${file}: ${graph.dangling} is depended on, and the lockfile has no snapshot of it`;
  const orphan = added.find((key) => !graph.referenced.has(key));
  if (orphan !== undefined) return `${file}: snapshots adds ${orphan}, which nothing depends on`;
  const stray = [...flips, ...added].find((key) => (snapshotsB.get(key).get('optional') === true) === graph.required.has(key));
  if (stray !== undefined) return `${file}: snapshots ${stray} ${added.includes(stray) ? 'is' : 'changes whether it is'} optional, which the lockfile's dependencies do not explain`;
  return null;
}

/**
 * The @revt-eng packages entries of a new pnpm-lock.yaml whose optional peers have to be checked against the package
 * itself: entries with a peerDependenciesMeta the branch head's lockfile does not have in that form. Each is
 * { key, integrity, tarball }, taken from the entry's resolution, and only when the key is a name and an exact
 * version, the integrity a sha512 and the tarball the GitHub Packages download of exactly that name and version;
 * anything else is left out and so refused by the check. At most 32.
 */
export function peerMetaToVerify(beforeText, afterText) {
  const before = parsePnpmLock(beforeText).lock, after = parsePnpmLock(afterText).lock;
  if (!before || !after) return [];
  const was = mapOf(before.get('packages')), entries = [];
  for (const [key, entry] of mapOf(after.get('packages'))) {
    const parsed = packageKey(key), meta = entry.get('peerDependenciesMeta');
    if (!parsed || parsed.suffix || !SCOPED.test(parsed.name) || !meta) continue;
    if (was.has(key) && was.get(key).has('peerDependenciesMeta') && sameValue(was.get(key).get('peerDependenciesMeta'), meta)) continue;
    const resolution = mapOf(entry.get('resolution')), integrity = resolution.get('integrity'), tarball = resolution.get('tarball');
    if (/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity ?? '') && downloadUrl(parsed.name, parsed.version).test(tarball ?? '')) entries.push({ key, integrity, tarball });
  }
  return entries.slice(0, 32);
}

/** The most a tarball may unpack to, and the most of it that is downloaded. */
const TARBALL_UNPACKED_BYTES = 256 * 1024 * 1024, TARBALL_BYTES = 64 * 1024 * 1024, TARBALL_MS = 60_000;
/**
 * package/package.json of an npm tarball (a gzipped tar), parsed. The last one wins, as it does when the tarball is
 * unpacked; a pax or GNU long-name header renames the entry after it, as tar does.
 */
export function tarballManifest(tgz) {
  let tar;
  try { tar = gunzipSync(tgz, { maxOutputLength: TARBALL_UNPACKED_BYTES }); } catch (error) { throw new Error(`the tarball is not a gzip archive, or unpacks to more than ${TARBALL_UNPACKED_BYTES} bytes (${error.message})`); }
  let found = null, renamed = null;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (from, to) => { const end = header.indexOf(0, from); return header.toString('utf8', from, end < 0 || end > to ? to : end); };
    const size = parseInt(field(124, 136).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('the tarball is not a tar archive');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]), body = () => tar.toString('utf8', at + 512, at + 512 + size);
    if (type === 'x' || type === 'L') {
      renamed = type === 'L' ? body().replace(/\0.*$/s, '') : /(?:^|\n)[0-9]+ path=([^\n]*)\n/.exec(body())?.[1] ?? renamed;
    } else if (type !== 'g') {
      const name = renamed ?? `${field(345, 500) ? `${field(345, 500)}/` : ''}${field(0, 100)}`;
      if (type === '0' && name === 'package/package.json') found = body();
      renamed = null;
    }
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
  const atTip = (file) => { try { return git(['cat-file', 'blob', `${tip}:${file}`]); } catch (error) { if (error?.tooLarge) throw error; return null; } };
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

/** What a registry lists for a version besides its dist, which a pnpm lockfile entry is held to. */
const PACKUMENT_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'engines', 'cpu', 'os', 'libc', 'bin', 'directories', 'deprecated'];
/**
 * The registry entries of the pinned packages, name -> { [version]: { integrity, tarball } }: GitHub Packages for
 * @revt-eng/* (REGISTRY_TOKEN, packages: read), npm for the rest. A version also carries the PACKUMENT_FIELDS its
 * registry lists, when it lists them. Fails closed: an entry it cannot read throws RegistryUnavailable.
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
        for (const field of PACKUMENT_FIELDS) if (entry?.[field] !== undefined && entry[field] !== null) versions[version][field] = entry[field];
      }
      registry.set(name, versions);
    } catch (error) {
      throw new RegistryUnavailable(`could not read ${name} from its registry (${error.message})`);
    }
  }
  return registry;
}

/** The bytes of a response, refused (`tooLarge`) past `maxBytes`: by its content-length, and while it is read. */
async function limitedBody(response, maxBytes) {
  const tooLarge = () => Object.assign(new Error(`it is larger than ${maxBytes} bytes`), { tooLarge: true });
  if (Number(response.headers?.get?.('content-length') ?? 0) > maxBytes) throw tooLarge();
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw tooLarge();
    return bytes;
  }
  const reader = response.body.getReader(), chunks = [];
  for (let total = 0; ;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.length;
    if (total > maxBytes) { await reader.cancel(); throw tooLarge(); }
    chunks.push(value);
  }
}

/**
 * The package.json of each tarball in `entries` (peerMetaToVerify), name@version -> { integrity, manifest }. The
 * tarball is downloaded from GitHub Packages (REGISTRY_TOKEN), at most `maxBytes` of it and within `timeoutMs`, and
 * its sha512 must be the integrity the lockfile records. Fails closed: a tarball it cannot download throws
 * RegistryUnavailable; one that is too large, has another hash or has no package.json is an error.
 */
export async function readManifests(entries, { token = process.env.REGISTRY_TOKEN, fetchImpl = fetch, maxBytes = TARBALL_BYTES, timeoutMs = TARBALL_MS } = {}) {
  const manifests = new Map();
  for (const entry of entries) {
    let bytes;
    try {
      const response = await fetchImpl(entry.tarball, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = await limitedBody(response, maxBytes);
    } catch (error) {
      if (error?.tooLarge) throw new Error(`the tarball of ${entry.key} was not read: ${error.message}`);
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
    try { before = git(['cat-file', 'blob', `${tip}:${entry.path}`]); } catch (error) { if (error?.tooLarge) throw error; continue; }
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
        { encoding: 'utf8', input, env: { ...process.env, ...env }, maxBuffer: GIT_OUTPUT_BYTES });
      if (result.error?.code === 'ENOBUFS') throw gitOutputTooLarge(args);
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
