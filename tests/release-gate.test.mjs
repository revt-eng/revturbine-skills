import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCliReferences, extractSdkReferences, parseHelpCommands, routePrompt, validateCatalog, validateCliReferences, validateSdkReferences } from '../scripts/release-gate.mjs';

test('extracts root and nested CLI commands', () => {
  assert.deepEqual(extractCliReferences('run revturbine validate file and revturbine generate types'), [
    { root: 'validate', child: 'file' }, { root: 'generate', child: 'types' },
  ]);
  assert.deepEqual(parseHelpCommands('Commands:\n  validate [file]  Validate\n  generate           Generate\n\nOptions:\n'), ['validate', 'generate']);
});

test('negative fixture rejects an unknown CLI command and stale schema pin', () => {
  const skill = { file: 'fixture.md', source: 'revturbine imaginary', frontmatter: { metadata: { schema_version: '<0.1.0' } } };
  const errors = validateCliReferences([skill], { schemaVersion: '0.1.261', paths: new Set(['validate']) });
  assert.equal(errors.length, 2);
});

test('negative fixture rejects an unknown SDK identifier', () => {
  const skill = { file: 'fixture.md', source: "import { ImaginaryGate } from '@revturbine/sdk'" };
  assert.deepEqual(extractSdkReferences(skill.source), ['ImaginaryGate']);
  assert.equal(validateSdkReferences([skill], { version: '0.7.4', declarations: 'export declare const Gate: unknown' }).length, 1);
});

test('negative fixture rejects registry drift', () => {
  const skill = { directory: 'revturbine-one', file: 'fixture.md', frontmatter: { name: 'revturbine-one', description: 'one', metadata: { author: 'x', version: '1.0.0', safety_class: 'read-only-inspection', schema_version: '*', tier: 'free' } } };
  assert.equal(validateCatalog([skill], { groupings: [] }).length, 1);
});

test('routes a prompt from description overlap', () => {
  const skills = [
    { frontmatter: { name: 'billing', description: 'Connect Stripe billing products and prices' } },
    { frontmatter: { name: 'sdk', description: 'Install the SDK and mount the provider' } },
  ];
  assert.equal(routePrompt('Please install the SDK provider', skills).name, 'sdk');
});
