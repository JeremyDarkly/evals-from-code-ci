// Offline checks: no LaunchDarkly or OpenAI calls.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { EVAL_TOOLS, loadRows } from '../evals/runEvals.js';
import { citesSource, statesKeyFigures } from '../evals/scorers.js';
import { MEMBERS } from '../src/members.js';
import { loadCorpus, search } from '../src/retriever.js';
import { searchMemberPolicy, TOOLS } from '../src/tools.js';

const dataset = (name) => fileURLToPath(new URL(`../../evals/datasets/${name}`, import.meta.url));

test('corpus loads every policy document', () => {
  assert.equal(loadCorpus().length, 90);
});

for (const member of MEMBERS.values()) {
  test(`search never returns another plan's documents: ${member.planId}`, () => {
    for (const doc of search('copay deductible specialist emergency', member.planId)) {
      assert.ok(doc.planId === null || doc.planId === member.planId);
    }
  });
}

test('search finds the copays document', () => {
  const ids = search('specialist visit copay', 'TH-HMO-GOLD-2024').map((d) => d.docId);
  assert.ok(ids.includes('TH-HMO-GOLD-2024-copays-in-network'));
});

test('search rejects unknown plan', () => {
  assert.throws(() => search('copay', 'TH-NOPE-2024'));
});

test("tool resolves the member's plan", () => {
  const found = searchMemberPolicy({ member_id: 'M-1003', query: 'telemedicine copay' });
  assert.equal(found.plan_id, 'TH-EPO-SILVER-2024');
  assert.equal(found.results[0].doc_id, 'TH-EPO-SILVER-2024-telemedicine');
});

test('tool rejects unknown member', () => {
  assert.throws(() => searchMemberPolicy({ member_id: 'M-9999', query: 'copay' }));
});

test('eval tools match app tools', () => {
  assert.deepEqual(
    EVAL_TOOLS.map((t) => t.key),
    Object.keys(TOOLS),
  );
});

for (const name of ['pr.jsonl', 'full.jsonl']) {
  test(`dataset is answerable: ${name}`, () => {
    for (const row of loadRows(dataset(name))) {
      const member = MEMBERS.get(row.variables.member_id);
      const corpus = loadCorpus()
        .filter((d) => d.planId === null || d.planId === member.planId)
        .map((d) => d.text)
        .join(' ');
      assert.ok(row.input && row.expectedOutput);
      for (const figure of row.metadata.must_include) {
        assert.ok(row.expectedOutput.toLowerCase().includes(figure.toLowerCase()));
        if (/\d/.test(figure)) assert.ok(corpus.includes(figure), `${figure} not in ${member.planId} documents`);
      }
    }
  });
}

test('PR rows are in the full set', () => {
  const full = new Set(loadRows(dataset('full.jsonl')).map((r) => JSON.stringify(r)));
  for (const row of loadRows(dataset('pr.jsonl'))) assert.ok(full.has(JSON.stringify(row)));
});

test('states-key-figures is fractional', () => {
  const row = { metadata: { must_include: ['$6,500', '$750'] } };
  assert.equal(statesKeyFigures(row, 'Your deductible is $6,500.'), 0.5);
  assert.equal(statesKeyFigures(row, '$6,500 deductible, $750 HSA'), 1);
});

test('cites-source', () => {
  assert.equal(citesSource({}, 'Source: TH-HMO-GOLD-2024-copays-in-network'), 1);
  assert.equal(citesSource({}, 'Source: claims-preauth-frequently-asked-questions'), 1);
  assert.equal(citesSource({}, 'Your copay is $25.'), 0);
});
