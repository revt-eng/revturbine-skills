// GENERATED from revt-eng/revturbine-devkit scripts/workflow-policy.mjs (v1.8.0). Do not edit here:
// this repository's guard (scripts/ci-guards.mjs) enforces the workflow policy, so the
// devkit keeps the master and `pnpm sync:copies` refreshes this copy (docs/ops/ci-levels.md).

/**
 * What a GitHub Actions workflow may do (EP-1747; docs/ops/ci-levels.md).
 *
 * CI checks (levels L1-L3) run before code reaches production; post-deployment
 * validation (L4) and operator scripts run against production on purpose. The
 * rules follow that line rather than banning production access outright:
 *
 *   1. LLM inference never runs in a workflow (QA runs as HELM agents).
 *   2. A production credential never appears in a workflow that a pull request
 *      (any `pull_request*` event) or the merge queue (`merge_group`) triggers:
 *      those are CI checks.
 *   3. Anywhere else (manual dispatch, deployment events, schedules, workflow
 *      chains, pushes, releases) a production credential appears only inside a
 *      job that declares `environment:`, so production access always goes
 *      through a GitHub environment that can be protected, and shows in the file.
 *
 * A workflow reads a secret as `secrets.NAME`, as `secrets['NAME']`, or by
 * listing NAME in the `secret-env` input of the shared ci-level.yml (on one line
 * or continued over several). Names match without regard to case, as GitHub
 * resolves them.
 *
 * Text-based on purpose (no YAML parser): comment lines are ignored, and the
 * triggers and jobs are read at whatever indentation the file uses. The devkit
 * keeps the master copy; `pnpm sync:copies` (scripts/sync-copies.mjs) copies it
 * into the repositories whose own guards enforce it.
 */

/** Lines that run LLM inference wherever they appear: an Anthropic action or image, Claude Code. */
export const INFERENCE = [/anthropics?\//i, /claude-code/i];

/** Secret names that are model API keys: reading one is inference. */
export const INFERENCE_SECRET_NAME = /^(?:ANTHROPIC|OPENAI)_API_KEY/i;

/** Secret names that reach production: PROD_*, *_PROD, Stripe secret keys, database URLs, the Neon API key. */
export const PRODUCTION_SECRET_NAME = /^(?:PROD_\w*|\w+_PROD|STRIPE_SECRET_KEY\w*|POSTGRES_URL|DATABASE_URL|NEON_API_KEY)$/i;

/** Events that make a workflow a CI check: every `pull_request*` event, and the merge queue's `merge_group`. */
export const CI_CHECK_EVENT = /^(?:pull_request\w*|merge_group)$/;

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_REFERENCE = /secrets(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;
const SECRET_ENV_KEY = /^(\s*)['"]?secret-env['"]?\s*:(.*)$/;

const indentOf = (line) => line.length - line.trimStart().length;
/** Blank lines and comment lines say nothing about what a workflow does. */
const ignorable = (line) => line.trim() === '' || /^\s*#/.test(line);

/** Names a `secret-env` value lists: comma- or space-separated; quotes, block-scalar indicators and a trailing comment ignored. */
export function listedNames(value) {
  return String(value ?? '').replace(/(?:^|\s)#.*$/, '').split(/[\s,'"]+/).filter((name) => SECRET_NAME.test(name));
}

/** Secret names one line reads: `secrets.NAME`, `secrets['NAME']`, and the names a `secret-env:` line lists. */
export function secretNames(line) {
  const text = String(line ?? '');
  const names = [...text.matchAll(SECRET_REFERENCE)].map((m) => m[1] ?? m[2]);
  const listed = SECRET_ENV_KEY.exec(text);
  if (listed) names.push(...listedNames(listed[2]));
  return names;
}

/** Production secret names one line reads (see secretNames). */
export function productionSecrets(line) {
  return secretNames(line).filter((name) => PRODUCTION_SECRET_NAME.test(name));
}

/** Event names a workflow's `on:` declares, in scalar, list or mapping form. */
export function triggers(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const events = new Set();
  const at = lines.findIndex((line) => /^['"]?on['"]?\s*:/.test(line));
  if (at < 0) return events;
  const inline = lines[at].replace(/^['"]?on['"]?\s*:/, '').replace(/(?:^|\s)#.*$/, '').trim();
  if (inline) {
    for (const name of inline.match(/[A-Za-z_]+/g) ?? []) events.add(name);
    return events;
  }
  let childIndent = -1;
  for (const line of lines.slice(at + 1)) {
    if (ignorable(line)) continue;
    // A block sequence may sit at the key's own indentation (`on:` then `- push`).
    if (indentOf(line) === 0 && !/^-\s/.test(line)) break;
    if (childIndent < 0) childIndent = indentOf(line);
    if (indentOf(line) !== childIndent) continue;
    const event = /^(?:-\s*)?['"]?([A-Za-z_]+)['"]?\s*(?::|$)/.exec(line.trim());
    if (event) events.add(event[1]);
  }
  return events;
}

/**
 * The top-level jobs of a workflow: the 0-based line range each spans
 * (`start` is the job's own key line, `end` is exclusive) and whether the job
 * declares `environment:` as one of its own keys.
 * @returns {{ id: string, start: number, end: number, environment: boolean }[]}
 */
export function workflowJobs(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const at = lines.findIndex((line) => /^['"]?jobs['"]?\s*:\s*(?:#.*)?$/.test(line));
  if (at < 0) return [];
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (!ignorable(lines[i]) && indentOf(lines[i]) === 0) {
      end = i;
      break;
    }
  }
  const first = lines.slice(at + 1, end).find((line) => !ignorable(line));
  if (!first) return [];
  const jobIndent = indentOf(first);
  const jobs = [];
  for (let i = at + 1; i < end; i += 1) {
    if (ignorable(lines[i]) || indentOf(lines[i]) !== jobIndent) continue;
    const id = /^['"]?([A-Za-z0-9_-]+)['"]?\s*:\s*(?:#.*)?$/.exec(lines[i].trim());
    if (!id) continue;
    if (jobs.length) jobs[jobs.length - 1].end = i;
    jobs.push({ id: id[1], start: i, end, environment: false });
  }
  for (const job of jobs) {
    const body = lines.slice(job.start + 1, job.end).filter((line) => !ignorable(line));
    const keyIndent = body.length ? indentOf(body[0]) : -1;
    job.environment = body.some((line) => indentOf(line) === keyIndent && /^environment\s*:/.test(line.trim()));
  }
  return jobs;
}

/**
 * Every policy violation in one workflow file.
 * @returns {{ line: number, id: 'inference' | 'production-credential', why: string, text: string }[]}
 */
export function checkWorkflowPolicy(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const ciCheck = [...triggers(text)].some((event) => CI_CHECK_EVENT.test(event));
  const jobs = workflowJobs(text);
  const findings = [];
  // Indentation of a `secret-env:` key whose value may continue on the lines below
  // it (a block scalar, or a plain or quoted scalar over several lines), else -1.
  let secretEnvIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (ignorable(line)) continue;
    const names = secretNames(line);
    if (secretEnvIndent >= 0 && indentOf(line) > secretEnvIndent) names.push(...listedNames(line));
    else secretEnvIndent = SECRET_ENV_KEY.test(line) ? indentOf(line) : -1;
    if (INFERENCE.some((pattern) => pattern.test(line)) || names.some((name) => INFERENCE_SECRET_NAME.test(name)))
      findings.push({ line: i + 1, id: 'inference', why: 'LLM inference runs in a workflow (QA runs as HELM agents)', text: line.trim() });
    const production = [...new Set(names.filter((name) => PRODUCTION_SECRET_NAME.test(name)))];
    if (!production.length) continue;
    if (ciCheck) {
      findings.push({ line: i + 1, id: 'production-credential', why: `a pull-request or merge-queue workflow (a CI check) reads ${production.join(', ')}`, text: line.trim() });
      continue;
    }
    const job = jobs.find((candidate) => i > candidate.start && i < candidate.end);
    if (!job?.environment)
      findings.push({ line: i + 1, id: 'production-credential', why: `${production.join(', ')} is read outside a job that declares an environment`, text: line.trim() });
  }
  return findings;
}
