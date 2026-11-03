/**
 * Keyword retriever over the ToggleHealth policy documents in data/policies.
 *
 * The original policy_agent retrieved from an AWS Bedrock knowledge base. This
 * version scores the same markdown files locally, so the agent and its evals run
 * without an AWS account. Swap `search` for your own retriever; nothing else in
 * the app depends on how documents are found.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_DIR = fileURLToPath(new URL('../../data/policies', import.meta.url));
export const PLAN_PREFIXES = ['TH-HMO-GOLD-2024', 'TH-PPO-PLATINUM-2024', 'TH-EPO-SILVER-2024', 'TH-HDHP-BRONZE-2024'];
const STOPWORDS = new Set(
  ('a an and are as at be by can do does for from how i if in is it my of on or ' +
    'the to what when where which who will with you your me am').split(' '),
);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOPWORDS.has(t));
}

function countTerms(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

let corpus;

/** Every policy document, parsed once. */
export function loadCorpus() {
  corpus ??= readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const docId = basename(file, '.md');
      const text = readFileSync(join(DOCS_DIR, file), 'utf8');
      const terms = countTerms(tokenize(`${docId} ${text}`));
      const length = [...terms.values()].reduce((a, b) => a + b, 0);
      return { docId, planId: PLAN_PREFIXES.find((p) => docId.startsWith(p)) ?? null, text, terms, length };
    });
  return corpus;
}

/**
 * Return the best matches among the member's plan documents and the shared ones.
 *
 * Shared documents (claims, pharmacy, special programs) apply to every plan.
 * Another plan's documents are never returned, so an answer can't quote the
 * wrong plan's copays.
 */
export function search(query, planId, limit = 4) {
  if (!PLAN_PREFIXES.includes(planId)) {
    throw new Error(`Unknown plan_id '${planId}'. Expected one of: ${PLAN_PREFIXES.join(', ')}`);
  }
  const candidates = loadCorpus().filter((d) => d.planId === null || d.planId === planId);
  const docFreq = new Map();
  for (const d of candidates) for (const t of d.terms.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const queryTerms = tokenize(query);

  const score = (doc) =>
    queryTerms.reduce((sum, t) => {
      const tf = doc.terms.get(t);
      return tf ? sum + (tf / doc.length) * Math.log(1 + candidates.length / docFreq.get(t)) : sum;
    }, 0);

  return candidates
    .map((doc) => ({ doc, score: score(doc) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((r) => r.score > 0)
    .map((r) => r.doc);
}
