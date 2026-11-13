#!/usr/bin/env node
// Release pins (EP-1747 phase 5): set one or more revt-eng packages to an exact
// version on a Release branch, with the lockfile, for
// .github/workflows/release-pin.yml. Backlog dispatches that workflow when a
// producer in the same Release publishes a prerelease (and, at the merge walk,
// its final version), because it cannot regenerate a lockfile over REST.
//
//   check  Validate the inputs and print the Release: the branch must be
//          release/RL-<n>; each package must be a revt-eng package at an exact
//          version, and a prerelease must be one of this Release's (-rl.<n>.<k>).
//   apply  In the checkout, run the package manager's exact add in every
//          directory whose package.json already depends on the package (a pin
//          never adds a dependency), keeping the dependency's field. A directory
//          with its own lockfile, or a member of a pnpm workspace, gets the add;
//          a manifest no lockfile covers gets its version string set. Lifecycle
//          scripts never run. Writes the changed files and the commit message to
//          --out, and refuses a change outside manifests, lockfiles and
//          pnpm-workspace.yaml (pnpm 11 records a just-published version there).
//
// Identical copies live in every repository with release-pin.yml; change them
// together.
//
// Usage:
//   node scripts/release-pin.mjs check --branch release/RL-<n> --packages "<name>@<version> ..."
//   node scripts/release-pin.mjs apply --branch release/RL-<n> --packages "<name>@<version> ..." [--dir <checkout>] [--out <file>]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const RELEASE_BRANCH = /^release\/RL-([1-9][0-9]*)$/;
const SCOPED = /^@revt-eng\/[a-z0-9][a-z0-9._-]*$/;
/** revt-eng packages outside the @revt-eng scope (the public npm ones). */
export const KNOWN_PACKAGES = ['@revturbine/cli', '@revturbine/sdk', 'create-revturbine', 'revturbine'];
const EXACT = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const PINNABLE_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);

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
  if (existsSync(path.join(abs, 'pnpm-lock.yaml'))) return { pm: 'pnpm', workspaceRoot: existsSync(path.join(abs, 'pnpm-workspace.yaml')) };
  if (existsSync(path.join(abs, 'package-lock.json')) || existsSync(path.join(abs, 'npm-shrinkwrap.json'))) return { pm: 'npm' };
  let parent = dir;
  while (parent !== '.') {
    parent = path.posix.dirname(parent);
    const workspace = path.join(root, parent, 'pnpm-workspace.yaml');
    if (existsSync(workspace) && existsSync(path.join(root, parent, 'pnpm-lock.yaml'))) {
      const relative = path.posix.relative(parent === '.' ? '' : parent, dir);
      if (matchesWorkspace(relative, workspacePackages(readFileSync(workspace, 'utf8')))) return { pm: 'pnpm', workspaceRoot: false };
    }
  }
  return { pm: null };
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
      targets.get(dir).push({ ...pin, field, current: manifest[field][pin.name] });
    }
  }
  const missing = pins.filter((pin) => !found.has(pin.name));
  if (missing.length) throw new Error(`refusing to add a dependency: ${missing.map((p) => p.name).join(', ')} is not a dependency of any package.json here`);

  for (const [dir, entries] of targets) {
    const pending = entries.filter((entry) => entry.current !== entry.version);
    if (!pending.length) {
      console.log(`${dir}: already pins ${entries.map((e) => `${e.name}@${e.version}`).join(', ')}`);
      continue;
    }
    const owner = ownerOf(root, dir);
    if (!owner.pm) {
      const file = path.join(root, dir, 'package.json');
      let text = readFileSync(file, 'utf8');
      for (const entry of pending) {
        const key = new RegExp(`("${entry.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"\\s*:\\s*)"[^"]*"`);
        text = text.replace(key, `$1"${entry.version}"`);
      }
      writeFileSync(file, text);
      console.log(`${dir}: no lockfile covers it; set ${pending.map((e) => `${e.name}@${e.version}`).join(', ')} in package.json`);
      continue;
    }
    for (const field of FIELDS) {
      const specs = pending.filter((entry) => entry.field === field).map((entry) => `${entry.name}@${entry.version}`);
      if (!specs.length) continue;
      const [command, args] = addCommand(owner, field, specs);
      console.log(`${dir}: ${command} ${args.join(' ')}`);
      const result = run(command, args, { cwd: path.join(root, dir), stdio: 'inherit', shell: process.platform === 'win32' });
      if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${dir} (exit ${result.status})`);
    }
  }

  for (const [dir, entries] of targets) {
    const manifest = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
    for (const entry of entries) {
      const now = manifest[entry.field]?.[entry.name];
      if (now !== entry.version) throw new Error(`${dir}/package.json ${entry.field}.${entry.name} is ${now}, not ${entry.version}`);
    }
  }

  const changed = [];
  const unexpected = [];
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  for (const record of status.split('\0').filter(Boolean)) {
    const file = record.slice(3);
    (PINNABLE_FILES.has(path.posix.basename(file)) ? changed : unexpected).push(file);
  }
  if (unexpected.length) throw new Error(`the pin changed files outside manifests and lockfiles: ${unexpected.join(', ')}`);
  return { release, pins, files: changed.sort(), message: commitMessage(pins, release) };
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
