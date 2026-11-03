/**
 * Run the policy agent against a dataset and gate CI on the result.
 *
 *   npm run evals -- --dataset ../evals/datasets/pr.jsonl
 *   npm run evals -- --dataset-key policy-agent-full --variation grounded --blocking
 *
 * Each member in the dataset is a LaunchDarkly context, so different members can
 * be served different policy-agent variations. The script asks LaunchDarkly which
 * variation each member gets and runs one evaluation per variation, using the
 * same handler and tool implementations the app uses in production.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { EvalTool, initClient, initEvaluations, inspectConfig, Judge, shutdown } from '@launchdarkly/ai-node';

import { CONFIG_KEY, handler } from '../src/agent.js';
import { isMain, loadEnv } from '../src/env.js';
import { getMember } from '../src/members.js';
import { TOOLS } from '../src/tools.js';
import { SCORERS } from './scorers.js';

export const EVAL_TOOLS = Object.entries(TOOLS).map(
  ([key, tool]) => new EvalTool(key, tool.implementation, tool.schema, tool.description),
);
const CRITERIA = [new Judge('policy-accuracy'), new Judge('policy-tool-use'), ...SCORERS];

/** Read a JSONL dataset in upload shape and return inline rows in wire shape. */
export function loadRows(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const row = JSON.parse(line);
      return {
        input: row.input,
        expectedOutput: row.expected_output,
        variables: row.variables ?? {},
        metadata: row.metadata ?? {},
      };
    });
}

async function servedVariation(memberId) {
  const inspected = await inspectConfig(CONFIG_KEY, getMember(memberId).context());
  if (!inspected.enabled || !inspected.meta) {
    throw new Error(`${CONFIG_KEY} is off or unreachable for member ${memberId}`);
  }
  return inspected.meta.variationKey;
}

async function groupByVariation(rows) {
  const groups = new Map();
  const variations = new Map();
  for (const row of rows) {
    const memberId = row.variables.member_id;
    if (!variations.has(memberId)) variations.set(memberId, await servedVariation(memberId));
    const variation = variations.get(memberId);
    if (!groups.has(variation)) groups.set(variation, []);
    groups.get(variation).push(row);
  }
  return groups;
}

function report(results, blocking) {
  const passed = [...results.values()].every((r) => r.passed);
  const lines = [
    `## Policy agent evals (Node.js): ${passed ? 'passed' : 'failed'} (${blocking ? 'blocking' : 'advisory'})`,
    '',
    '| Variation | Result | Passed | Failed | Errored | Run |',
    '|---|---|---|---|---|---|',
  ];
  for (const [variation, r] of results) {
    const s = r.summary;
    lines.push(
      `| \`${variation}\` | ${r.passed ? 'pass' : 'fail'} | ${s.passedRows}/${s.totalRows} | ${s.failedRows} ` +
        `| ${s.errorRows} | [results](${r.url}) |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  loadEnv();
  const { values: args } = parseArgs({
    options: {
      dataset: { type: 'string' },
      'dataset-key': { type: 'string' },
      variation: { type: 'string' },
      blocking: { type: 'boolean', default: false },
    },
  });
  if (Boolean(args.dataset) === Boolean(args['dataset-key'])) {
    throw new Error('Pass exactly one of --dataset and --dataset-key');
  }
  if (args['dataset-key'] && !args.variation) {
    throw new Error('--dataset-key needs --variation: every row of a hosted dataset runs against one variation');
  }

  await initClient({ sdkKey: process.env.LD_SDK_KEY });
  const evals = initEvaluations();
  // Run keys must be unique, and a re-run of a workflow keeps its GITHUB_RUN_ID.
  const runId =
    [process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT].filter(Boolean).join('-') ||
    String(Math.floor(Date.now() / 1000));
  const results = new Map();
  try {
    const groups = args.dataset
      ? await groupByVariation(loadRows(args.dataset))
      : new Map([[args.variation, args['dataset-key']]]);

    for (const [variation, dataset] of groups) {
      results.set(
        variation,
        await evals.run({
          key: `${CONFIG_KEY}-${variation}-node-${runId}`,
          dataset,
          handler: handler(),
          aiConfig: { key: CONFIG_KEY, variation },
          tools: EVAL_TOOLS,
          criteria: CRITERIA,
        }),
      );
    }
  } finally {
    await shutdown();
  }

  const summary = report(results, args.blocking);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  const passed = [...results.values()].every((r) => r.passed);
  return args.blocking && !passed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
