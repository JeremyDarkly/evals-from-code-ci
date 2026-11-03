/**
 * Deterministic scorers. They run in this process next to the LaunchDarkly judges,
 * cost nothing, and catch regressions a judge might grade leniently.
 */

import { Scorer } from '@launchdarkly/ai-node';

const DOC_ID = /\b(TH-[A-Z]+-[A-Z]+-2024|claims-preauth|pharmacy-benefits|special-programs)-[a-z0-9-]+/;

/** Fraction of the row's `must_include` strings that appear in the answer. */
export function statesKeyFigures(row, output) {
  const required = row.metadata?.must_include ?? [];
  if (!required.length) return 1;
  const text = String(output ?? '').toLowerCase();
  return required.filter((s) => text.includes(s.toLowerCase())).length / required.length;
}

/** 1 if the answer names at least one policy document it relied on. */
export function citesSource(_row, output) {
  return DOC_ID.test(String(output ?? '')) ? 1 : 0;
}

export const SCORERS = [new Scorer('states-key-figures', statesKeyFigures), new Scorer('cites-source', citesSource)];
