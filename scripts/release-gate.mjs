import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillsRoot = join(root, 'skills');
const cliBin = join(root, 'node_modules', '@revturbine', 'cli', 'dist', 'cli.js');
const requiredMetadata = ['author', 'version', 'safety_class', 'schema_version', 'tier'];
const stopWords = new Set(['a', 'also', 'and', 'for', 'from', 'if', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'this', 'to', 'use', 'when', 'with']);

export function parseSkill(source, file) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  const frontmatter = YAML.parse(match[1]);
  return { frontmatter, body: source.slice(match[0].length) };
}

export function discoverSkills() {
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = join(skillsRoot, entry.name, 'SKILL.md');
      const source = readFileSync(file, 'utf8');
      return { directory: entry.name, file, source, ...parseSkill(source, relative(root, file)) };
    });
}

export function validateCatalog(skills, registry) {
  const errors = [];
  const names = skills.map((skill) => skill.frontmatter.name);
  const registered = registry.groupings.flatMap((group) => group.skills);
  for (const skill of skills) {
    const meta = skill.frontmatter.metadata ?? {};
    if (skill.frontmatter.name !== skill.directory) errors.push(`${relative(root, skill.file)}: name must match directory`);
    if (!skill.frontmatter.description) errors.push(`${relative(root, skill.file)}: description is required`);
    for (const key of requiredMetadata) if (meta[key] === undefined) errors.push(`${relative(root, skill.file)}: metadata.${key} is required`);
    if (meta.sdk !== undefined) errors.push(`${relative(root, skill.file)}: metadata.sdk was retired by Plan 171`);
  }
  for (const name of names) if (names.filter((candidate) => candidate === name).length !== 1) errors.push(`duplicate skill name: ${name}`);
  for (const name of names) if (!registered.includes(name)) errors.push(`${name}: missing from skills.sh.json`);
  for (const name of registered) if (!names.includes(name)) errors.push(`${name}: registry entry has no skill directory`);
  return errors;
}

function cli(args) {
  return execFileSync(process.execPath, [cliBin, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function parseHelpCommands(help) {
  const section = help.match(/(?:^|\n)Commands:\r?\n([\s\S]*?)(?:\n\S|$)/)?.[1] ?? '';
  return section.split(/\r?\n/).map((line) => line.trim().match(/^([a-z][a-z-]*)\b/)?.[1]).filter(Boolean);
}

export function loadCliContract() {
  const versionOutput = cli(['--version']).trim();
  const match = versionOutput.match(/^(\d+\.\d+\.\d+) \(schema (\d+\.\d+\.\d+)\)$/);
  if (!match) throw new Error(`Unable to parse CLI version contract: ${versionOutput}`);
  const roots = parseHelpCommands(cli(['--help']));
  const paths = new Set(roots);
  for (const command of roots) {
    for (const child of parseHelpCommands(cli([command, '--help']))) paths.add(`${command} ${child}`);
  }
  return { cliVersion: match[1], schemaVersion: match[2], paths };
}

export function extractCliReferences(source) {
  return [...source.matchAll(/\brevturbine[ \t]+([a-z][a-z-]*)(?:[ \t]+([a-z][a-z-]*))?/g)].map((match) => ({ root: match[1], child: match[2] }));
}

export function validateCliReferences(skills, contract) {
  const errors = [];
  for (const skill of skills) {
    const file = relative(root, skill.file);
    const pin = skill.frontmatter.metadata?.schema_version;
    if (!semver.validRange(pin) || !semver.satisfies(contract.schemaVersion, pin)) errors.push(`${file}: schema pin ${JSON.stringify(pin)} does not cover ${contract.schemaVersion}`);
    for (const ref of extractCliReferences(skill.source)) {
      if (!contract.paths.has(ref.root)) errors.push(`${file}: unknown CLI command "revturbine ${ref.root}"`);
      else if (ref.child && contract.paths.has(`${ref.root} ${ref.child}`) === false && [...contract.paths].some((path) => path.startsWith(`${ref.root} `))) {
        const commandLike = !['a', 'an', 'and', 'file', 'for', 'from', 'in', 'is', 'it', 'or', 'the', 'this', 'to', 'with'].includes(ref.child);
        if (commandLike && ['generate', 'ingest-keys'].includes(ref.root)) errors.push(`${file}: unknown CLI command "revturbine ${ref.root} ${ref.child}"`);
      }
    }
  }
  return errors;
}

function packageContract() {
  const packageFile = join(root, 'node_modules', '@revturbine', 'sdk', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
  const files = Object.values(packageJson.exports).flatMap((value) => typeof value === 'object' && value.types ? [value.types] : []);
  const declarations = files.map((file) => readFileSync(join(dirname(packageFile), file), 'utf8')).join('\n');
  return { version: packageJson.version, declarations };
}

export function extractSdkReferences(source) {
  const references = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]@revturbine\/sdk(?:\/headless)?['"]/g)) {
    for (const name of match[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)) references.add(name);
  }
  for (const match of source.matchAll(/<\/?(Gate|Slot|RevTurbineProvider)\b/g)) references.add(match[1]);
  for (const match of source.matchAll(/\b(useCan|useEntitlement|usePlacement)\s*\(/g)) references.add(match[1]);
  for (const match of source.matchAll(/\b(rt|rtServer)\.(can|gate|track|update|identify)\s*\(/g)) references.add(match[2]);
  // A method call on the client was invisible here, which made this check
  // narrower than it reads: a skill could teach `sdk.somethingUnpublished()`
  // and the gate passed. Found when plan 236 TASK-4 added the first such call
  // and the gate stayed green against a pin that did not contain it — after
  // plan 233 had cited this very gate as the reason NOT to teach those APIs
  // early. The restraint was right; the guard behind it was not there.
  for (const match of source.matchAll(/\b(?:sdk|rt|rtServer)\.([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g)) references.add(match[1]);
  for (const match of source.matchAll(/\b(RevTurbineServer|RuntimeMode)\b/g)) references.add(match[1]);
  return [...references];
}

export function validateSdkReferences(skills, contract = packageContract()) {
  const errors = [];
  if (semver.major(contract.version) !== 0) errors.push(`SDK gate expects the current pre-1.0 public major, found ${contract.version}`);
  for (const skill of skills) for (const name of extractSdkReferences(skill.source)) {
    if (!new RegExp(`\\b${name}\\b`).test(contract.declarations)) errors.push(`${relative(root, skill.file)}: SDK identifier ${name} is absent from @revturbine/sdk@${contract.version} declarations`);
  }
  return errors;
}

function words(value) {
  return new Set(value.toLowerCase().match(/[a-z][a-z-]+/g)?.filter((word) => !stopWords.has(word)) ?? []);
}

export function routePrompt(prompt, skills) {
  const promptWords = words(prompt);
  return skills.map((skill) => {
    const descriptionWords = words(skill.frontmatter.description);
    const score = [...promptWords].filter((word) => descriptionWords.has(word)).length;
    return { name: skill.frontmatter.name, score };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))[0];
}

export function validateTriggers(skills, fixtures) {
  const errors = [];
  const covered = new Set();
  for (const fixture of fixtures) {
    covered.add(fixture.expected);
    const routed = routePrompt(fixture.prompt, skills);
    if (routed.name !== fixture.expected || routed.score === 0) errors.push(`trigger ${JSON.stringify(fixture.prompt)} routed to ${routed.name}, expected ${fixture.expected}`);
  }
  for (const skill of skills) if (!covered.has(skill.frontmatter.name)) errors.push(`${skill.frontmatter.name}: no trigger fixture`);
  return errors;
}

export function extractUrls(source) {
  return [...new Set([...source.matchAll(/https?:\/\/[^\s)`>]+/g)].map((match) => match[0].replace(/[.,;:]$/, '')).filter((url) => !url.includes('…')))];
}

async function validateLinks(skills) {
  const errors = [];
  const urls = [...new Set(skills.flatMap((skill) => extractUrls(skill.source)))];
  for (const url of urls) {
    try {
      let response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'revturbine-skills-release-gate' } });
      if (response.status === 405) response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'revturbine-skills-release-gate' } });
      if (!response.ok) errors.push(`${url}: HTTP ${response.status}`);
    } catch (error) { errors.push(`${url}: ${error.message}`); }
  }
  return errors;
}

async function main() {
  const skills = discoverSkills();
  const registry = JSON.parse(readFileSync(join(root, 'skills.sh.json'), 'utf8'));
  const cliContract = loadCliContract();
  const fixtures = JSON.parse(readFileSync(join(root, 'evals', 'trigger-fixtures.json'), 'utf8'));
  const errors = [
    ...validateCatalog(skills, registry),
    ...validateCliReferences(skills, cliContract),
    ...validateSdkReferences(skills),
    ...validateTriggers(skills, fixtures),
  ];
  if (process.argv.includes('--links') || process.env.CHECK_LINKS === '1') errors.push(...await validateLinks(skills));
  if (errors.length) {
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
  } else console.log(`release-gate: ${skills.length} skills; CLI ${cliContract.cliVersion} / schema ${cliContract.schemaVersion}; all checks passed`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
