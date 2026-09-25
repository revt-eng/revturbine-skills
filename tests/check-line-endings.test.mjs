/**
 * BL-0216 (follow-up to BL-0209) — the CRLF line-ending check.
 *
 * `.gitattributes` normalizes line endings on checkin/checkout, but a
 * stale git config, an editor that writes CRLF, or a merge tool can still
 * introduce one — that has repeatedly turned an ordinary merge into a
 * whole-file conflict in the product repos (web #852, BL-0065, #853).
 * `check-line-endings.mjs` inspects content directly so it catches that
 * regardless of `.gitattributes`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFiles, hasCRLF, isBinaryPath } from '../scripts/check-line-endings.mjs';

test('hasCRLF detects a CRLF line ending', () => {
  assert.equal(hasCRLF('line one\r\nline two\n'), true);
});

test('hasCRLF passes LF-only content', () => {
  assert.equal(hasCRLF('line one\nline two\n'), false);
});

test('hasCRLF passes content with no line breaks at all', () => {
  assert.equal(hasCRLF('no newline here'), false);
});

test('hasCRLF accepts a Buffer as well as a string', () => {
  assert.equal(hasCRLF(Buffer.from('a\r\nb')), true);
  assert.equal(hasCRLF(Buffer.from('a\nb')), false);
});

test('isBinaryPath treats a path git reports as -text (binary) as binary', () => {
  const execFile = () => 'assets/logo.png: text: unset\n';
  assert.equal(isBinaryPath('assets/logo.png', execFile), true);
});

test('isBinaryPath treats a path git reports as text=auto as non-binary', () => {
  const execFile = () => 'scripts/index.mjs: text: set\n';
  assert.equal(isBinaryPath('scripts/index.mjs', execFile), false);
});

test('isBinaryPath fails open (non-binary) when git check-attr errors', () => {
  const execFile = () => {
    throw new Error('git not found');
  };
  assert.equal(isBinaryPath('whatever.mjs', execFile), false);
});

test('checkFiles flags a file containing CRLF', () => {
  const offenders = checkFiles(['scripts/foo.mjs'], {
    execFile: () => 'scripts/foo.mjs: text: set\n',
    readStaged: () => 'const x = 1;\r\nconst y = 2;\n',
  });
  assert.deepEqual(offenders, ['scripts/foo.mjs']);
});

test('checkFiles passes a file with only LF', () => {
  const offenders = checkFiles(['scripts/foo.mjs'], {
    execFile: () => 'scripts/foo.mjs: text: set\n',
    readStaged: () => 'const x = 1;\nconst y = 2;\n',
  });
  assert.deepEqual(offenders, []);
});

test('checkFiles exempts a file git considers binary, even if its bytes contain \\r\\n', () => {
  const noExec = () => {
    throw new Error('execFile should not be called');
  };
  const offenders = checkFiles(['assets/logo.png'], {
    execFile: () => 'assets/logo.png: text: unset\n',
    readStaged: noExec,
  });
  assert.deepEqual(offenders, []);
});

test('checkFiles skips a file that cannot be read (e.g. deleted)', () => {
  const offenders = checkFiles(['gone.mjs'], {
    execFile: () => 'gone.mjs: text: set\n',
    readStaged: () => {
      throw new Error('no such blob');
    },
  });
  assert.deepEqual(offenders, []);
});

test('checkFiles checks multiple files independently', () => {
  const content = { 'good.mjs': 'a\nb\n', 'bad.mjs': 'a\r\nb\n' };
  const offenders = checkFiles(['good.mjs', 'bad.mjs'], {
    execFile: () => 'x: text: set\n',
    readStaged: (file) => content[file],
  });
  assert.deepEqual(offenders, ['bad.mjs']);
});
