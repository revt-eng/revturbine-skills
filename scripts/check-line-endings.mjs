#!/usr/bin/env node
/**
 * Pre-commit gate: refuse to commit a tracked text file that contains a
 * CRLF line ending — BL-0216 (follow-up to BL-0209, which shipped this same
 * check in revturbine-web #857, revturbine-scaffold #397 and
 * revturbine-sdk-internal #534).
 *
 * `.gitattributes` (`* text=auto eol=lf`) normalizes line endings on
 * checkin/checkout, but that alone does not stop a CRLF file from being
 * *staged* in the first place — a checkout with a stale git config, an
 * editor that writes CRLF, or a merge tool can still stage one. That has
 * repeatedly turned an ordinary merge into a whole-file conflict in the
 * product repos. This script is the second line of defense: it inspects
 * staged content directly, so it fails even when `.gitattributes` itself is
 * bypassed or misconfigured for a given path.
 *
 * Usage: node scripts/check-line-endings.mjs [--staged | --all] [file ...]
 *   --staged (default when no files given): check `git diff --cached`
 *   --all: check every tracked file at HEAD — this repo has no pre-commit
 *     hook, so CI runs this mode (a fresh checkout has nothing staged)
 *   file args: check exactly those files (used by the unit test and by
 *     callers that already have a file list, e.g. lint-staged-style hooks)
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** True if `buf` (a Buffer or string) contains a CRLF line ending. */
export function hasCRLF(buf) {
  const s = typeof buf === 'string' ? buf : buf.toString('utf8');
  return s.includes('\r\n');
}

/** @typedef {(cmd: string, args: string[], opts?: Record<string, unknown>) => string} ExecFile */

/**
 * True if git considers `file` binary per its attributes (`-text` or the
 * `binary` macro). Binary files are exempt — CRLF bytes there are just
 * data, not line endings.
 *
 * @param {string} file
 * @param {ExecFile} [execFile]
 */
export function isBinaryPath(file, execFile = execFileSync) {
  try {
    const out = execFile('git', ['check-attr', 'text', '--', file], {
      encoding: 'utf8',
    });
    // "path: text: unset" -> -text (binary); "path: text: set" -> text=auto
    return /:\s*text:\s*unset/.test(out);
  } catch {
    return false;
  }
}

/** @param {ExecFile} [execFile] */
function stagedFiles(execFile = execFileSync) {
  const out = execFile(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    { encoding: 'utf8' },
  );
  return out.split('\n').filter(Boolean);
}

/**
 * Every tracked file, read from HEAD rather than the index — used by
 * `--all`, the mode CI runs (there is no pre-commit hook in this repo, so
 * there is nothing staged in a fresh checkout; `--staged` alone would pass
 * vacuously). @param {ExecFile} [execFile]
 */
function trackedFiles(execFile = execFileSync) {
  const out = execFile('git', ['ls-files'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

/**
 * Check the given files for staged CRLF content. `readStaged` reads a
 * file's STAGED blob content (defaults to `git show :<path>`, matching
 * what will actually be committed) so a partially-staged file is judged
 * on what's staged, not the working tree.
 *
 * @param {string[]} files
 * @param {{ execFile?: ExecFile, readStaged?: (file: string) => string }} [opts]
 */
export function checkFiles(files, { execFile = execFileSync, readStaged } = {}) {
  const read =
    readStaged ??
    ((file) => execFile('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 }));
  const offenders = [];
  for (const file of files) {
    if (isBinaryPath(file, execFile)) continue;
    let content;
    try {
      content = read(file);
    } catch {
      continue; // deleted / unreadable — nothing to check
    }
    if (hasCRLF(content)) offenders.push(file);
  }
  return offenders;
}

function main() {
  const all = process.argv.includes('--all');
  const args = process.argv.slice(2).filter((a) => a !== '--staged' && a !== '--all');
  const files = args.length > 0 ? args : all ? trackedFiles() : stagedFiles();
  // --all reads HEAD content (via `git show HEAD:<path>`) rather than the
  // index, since a CI checkout has nothing staged.
  const readStaged = all
    ? (file) => execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 })
    : undefined;
  const offenders = checkFiles(files, { readStaged });

  if (offenders.length > 0) {
    console.error(
      `[check-line-endings] CRLF found in ${all ? 'tracked' : 'staged'} file(s) — refused:\n` +
        offenders.map((f) => `  - ${f}`).join('\n') +
        '\n\nFix: run `git add --renormalize <file>` (or resave with LF) and re-stage.' +
        '\nIf this is a genuine binary that .gitattributes should exempt, add it there instead.',
    );
    process.exit(1);
  }
  console.log(`[check-line-endings] OK — no ${all ? 'tracked' : 'staged'} CRLF.`);
}

// Only run as a script (not when imported for tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
