// Where the push App's key may go in the Release pin workflows (EP-1747 phase 7). Textual, because nothing of ours
// runs a workflow. The first Backlog-dispatched pins (2026-11-16) failed in the push job with "Input required and not
// supplied: private-key": a called workflow's secrets context holds only what its caller passes, and release-pin.yml
// passed nothing, so the ci-push environment's key read as empty. The caller now passes that one name. The key still
// reaches the push job alone: it is an environment secret, and only that job declares the environment. The pin job
// runs the Release branch's package manager, so it must never be able to read a secret.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const caller = workflow('release-pin.yml');
const attempt = workflow('release-pin-attempt.yml');

/** Comment lines say nothing about what a workflow does. */
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
/** Every use of the secrets context: secrets.NAME by name, anything else (secrets['NAME'], toJSON(secrets)) as '*'. */
const secretUses = (text) => [...code(text).matchAll(/\bsecrets\b(?!:)(?:\.(\w+))?/g)].map((m) => m[1] ?? '*');
/** A workflow's top-level jobs: id -> the job's text. */
const jobs = (text) => Object.fromEntries(code(text.slice(text.indexOf('\njobs:\n') + 1)).split(/\n(?= {2}[\w-]+:\n)/).slice(1)
  .map((block) => [/^ {2}([\w-]+):/.exec(block)[1], block]));

test('release-pin-attempt.yml takes the push key and no other secret', () => {
  const declared = /\n {4}secrets:\n((?: {6,}.*\n)+)/.exec(code(attempt.slice(0, attempt.indexOf('\njobs:\n') + 1)))?.[1] ?? '';
  assert.deepEqual([...declared.matchAll(/^ {6}(\w+):/gm)].map((m) => m[1]), ['CI_PUSH_APP_PRIVATE_KEY']);
});

test('each attempt passes the push key by name and never inherits secrets', () => {
  assert.doesNotMatch(code(caller), /secrets:\s*inherit/);
  const calls = Object.entries(jobs(caller)).filter(([, job]) => job.includes('uses: ./.github/workflows/release-pin-attempt.yml'));
  assert.deepEqual(calls.map(([id]) => id), ['attempt-1', 'attempt-2', 'attempt-3']);
  for (const [id, job] of calls) {
    assert.match(job, /\n {4}secrets:\n {6}CI_PUSH_APP_PRIVATE_KEY: \$\{\{ secrets\.CI_PUSH_APP_PRIVATE_KEY \}\}(?:\n(?! {6})|$)/, id);
    assert.doesNotMatch(job, /^ {4}environment:/m, id);
  }
  assert.deepEqual(secretUses(caller), ['CI_PUSH_APP_PRIVATE_KEY', 'CI_PUSH_APP_PRIVATE_KEY', 'CI_PUSH_APP_PRIVATE_KEY']);
});

test('the pin job declares no environment and never names the secrets context', () => {
  const { pin } = jobs(attempt);
  assert.deepEqual(secretUses(pin), []);
  assert.doesNotMatch(pin, /^ {4}environment:/m);
});

test('the push key is read only in the job that declares the ci-push environment', () => {
  const all = jobs(attempt);
  assert.deepEqual(Object.keys(all), ['pin', 'push']);
  assert.deepEqual(secretUses(all.push), ['CI_PUSH_APP_PRIVATE_KEY']);
  assert.match(all.push, /^ {4}environment: ci-push$/m);
});
