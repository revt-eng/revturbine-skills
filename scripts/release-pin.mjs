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
//          records a just-published version there).
//
// Identical copies live in every repository with release-pin.yml; change them
// together.
//
// Usage:
//   node scripts/release-pin.mjs check --branch release/RL-<n> --packages "<name>@<version> ..."
//   node scripts/release-pin.mjs apply --branch release/RL-<n> --packages "<name>@<version> ..." [--dir <checkout>] [--out <file>]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

/** The lockfile-only install that settles a range written back after the exact add resolved the version. */
export function lockfileCommand(owner) {
  if (owner.pm === 'pnpm') return ['pnpm', ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts']];
  if (owner.pm === 'npm') return ['npm', ['install', '--package-lock-only', '--ignore-scripts']];
  throw new Error(`no package manager for ${JSON.stringify(owner)}`);
}

/** The package manager command that pins `specs` in one field. */
export function addCommand(owner, field, specs) {
  const flag = { dependencies: '--save-prod', devDependencies: '--save-dev', optionalDependencies: '--save-optional' }[field];
  if (owner.pm === 'pnpm') return ['pnpm', ['add', '--save-exact', '--ignore-scripts', flag, ...(owner.workspaceRoot ? ['--workspace-root'] : []), ...specs]];
  if (owner.pm === 'npm') return ['npm', ['install', '--save-exact', '--ignore-scripts', flag, ...specs]];
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

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    options[argv[i].slice(2)] = argv[i + 1];
  }
  return options;
}

function main(argv) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest);
  const { release, n } = releaseFromBranch(options.branch);
  const pins = parsePins(options.packages, n);
  if (command === 'check') {
    console.log(`${release}: ${pins.map((p) => `${p.name}@${p.version}`).join(', ')}`);
    return;
  }
  if (command !== 'apply') throw new Error('usage: release-pin.mjs check|apply --branch release/RL-<n> --packages "<name>@<version> ..."');
  const result = apply({ root: path.resolve(options.dir ?? '.'), pins, release });
  if (options.out) writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(result.files.length ? `Changed: ${result.files.join(', ')}` : 'Nothing to change: every manifest already pins these versions.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::release-pin: ${error.message}`);
    process.exit(1);
  }
}
