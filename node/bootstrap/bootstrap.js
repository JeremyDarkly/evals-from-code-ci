/**
 * Create the LaunchDarkly resources this repo expects. Safe to re-run: anything
 * that already exists is left as it is. Creates the same resources as
 * bootstrap/bootstrap.py, so run either one.
 *
 *   npm run bootstrap
 *
 * Creates, in LD_PROJECT_KEY:
 * - tool `search_member_policy`
 * - judges `policy-accuracy` and `policy-tool-use`
 * - AI Config `policy-agent` (or LD_AI_CONFIG_KEY) with variations `grounded` and
 *   `concise`, the judges attached, `grounded` as the production fallthrough, and
 *   Platinum members targeted to `concise`
 *
 * Needs LD_API_TOKEN with permission to write AI Configs in the project.
 */

import { CONFIG_KEY } from '../src/agent.js';
import { TOOLS } from '../src/tools.js';

const BASE = (process.env.LD_API_BASE_URI ?? 'https://app.launchdarkly.com').replace(/\/+$/, '');
const ENVIRONMENT = process.env.LD_ENVIRONMENT_KEY ?? 'production';
const AGENT_MODEL = 'gpt-4.1-mini';
// gpt-5-mini rejects the temperature parameter, so judge variations set none.
const JUDGE_MODEL = 'gpt-5-mini';

const SYSTEM_PROMPT = `You are ToggleHealth's policy assistant. You are helping member {{member_id}}.

1. Call search_member_policy with member_id {{member_id}} and a short query before you answer.
   Never answer from memory, and never guess the member's plan.
2. Answer only from the excerpts it returns. Quote dollar amounts exactly.
3. If the excerpts don't answer the question, say so and suggest calling Member Services.
4. End with "Source:" followed by the doc_id of each excerpt you used.`;

const VARIATIONS = {
  grounded: SYSTEM_PROMPT,
  concise: `${SYSTEM_PROMPT}\n\nKeep the answer to two sentences before the Source line.`,
};

const JUDGES = {
  'policy-accuracy': `You grade a health insurance assistant's answer against a reference answer.

Reference answer: {{expected_output}}

Score 1.0 when every dollar amount, limit and yes/no fact in the reference appears in the answer and
nothing in the answer contradicts it. Score 0.5 when the answer is partly right or omits a required fact.
Score 0.0 when it states a wrong amount, quotes another plan, or invents coverage. Ignore wording and tone.`,
  'policy-tool-use': `You grade how a health insurance assistant used its tools. The conversation below includes
every tool call it made and every result it got back.

Score 1.0 when it called search_member_policy for the member it is helping, with a query that fits the
question, and every fact in the answer comes from what the tool returned.
Score 0.5 when the call was right but the answer adds facts that are not in any tool result.
Score 0.0 when it answered without calling search_member_policy, or searched for a different member.`,
};

const project = process.env.LD_PROJECT_KEY;

async function request(method, path, body, semantic = false) {
  const contentType = semantic ? 'application/json; domain-model=launchdarkly.semanticpatch' : 'application/json';
  const resp = await fetch(`${BASE}/api/v2/projects/${project}/${path}`, {
    method,
    headers: { Authorization: process.env.LD_API_TOKEN, 'LD-API-Version': 'beta', 'Content-Type': contentType },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return [resp.status, parse(await resp.text())];
}

/** Parse a response body. Gateways can return HTML or plain text on errors. */
function parse(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { message: raw.slice(0, 200) };
  }
}

function fail(message) {
  console.error(`failed   ${message}`);
  process.exit(1);
}

/** Create the resource unless it exists, and return it. */
async function create(label, path, body) {
  // Re-posting an existing AI Config can return 400 instead of 409, so check first.
  const [existing, found] = await request('GET', `${path}/${body.key}`);
  if (existing === 200) {
    console.log(`exists   ${label}`);
    return found;
  }
  const [status, data] = await request('POST', path, body);
  if (status !== 200 && status !== 201) fail(`${label}: ${status} ${data.message ?? JSON.stringify(data)}`);
  console.log(`created  ${label}`);
  return data;
}

async function patch(label, path, body, semantic = false) {
  const [status, data] = await request('PATCH', path, body, semantic);
  if (status !== 200 && status !== 201) fail(`${label}: ${status} ${data.message ?? JSON.stringify(data)}`);
  console.log(`updated  ${label}`);
}

const model = (name) => ({ modelName: name, parameters: {}, custom: {} });

const toolVersions = {};
for (const [key, tool] of Object.entries(TOOLS)) {
  const created = await create(`tool ${key}`, 'ai-tools', {
    key,
    name: key,
    description: tool.description,
    type: 'function',
    schema: tool.schema,
  });
  toolVersions[key] = created.version;
}

for (const [key, prompt] of Object.entries(JUDGES)) {
  await create(`judge ${key}`, 'ai-configs', {
    key,
    name: key,
    mode: 'judge',
    evaluationMetricKey: `$ld:ai:judge:${key}`,
    isInverted: false,
  });
  await create(`judge ${key} variation`, `ai-configs/${key}/variations`, {
    key: 'default',
    name: 'default',
    modelConfigKey: `OpenAI.${JUDGE_MODEL}`,
    model: model(JUDGE_MODEL),
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: '{{message_history}}' },
    ],
  });
}

await create(`config ${CONFIG_KEY}`, 'ai-configs', { key: CONFIG_KEY, name: 'Policy agent', mode: 'completion' });
for (const [key, prompt] of Object.entries(VARIATIONS)) {
  await create(`${CONFIG_KEY} variation ${key}`, `ai-configs/${CONFIG_KEY}/variations`, {
    key,
    name: key,
    modelConfigKey: `OpenAI.${AGENT_MODEL}`,
    model: model(AGENT_MODEL),
    messages: [{ role: 'system', content: prompt }],
    tools: Object.entries(toolVersions).map(([k, version]) => ({ key: k, version })),
  });
  await patch(`${CONFIG_KEY} variation ${key} judges`, `ai-configs/${CONFIG_KEY}/variations/${key}`, {
    judgeConfiguration: { judges: Object.keys(JUDGES).map((j) => ({ judgeConfigKey: j, samplingRate: 1 })) },
  });
}

const [status, targeting] = await request('GET', `ai-configs/${CONFIG_KEY}/targeting`);
if (status !== 200) fail(`read ${CONFIG_KEY} targeting: ${status} ${targeting.message ?? JSON.stringify(targeting)}`);
const env = targeting.environments?.[ENVIRONMENT];
if (!env) fail(`environment '${ENVIRONMENT}' not found in the project. Set LD_ENVIRONMENT_KEY.`);
const ids = Object.fromEntries(targeting.variations.map((v) => [v.value._ldMeta.variationKey, v._id]));
const instructions = [{ kind: 'updateFallthroughVariationOrRollout', variationId: ids.grounded }];
if (!env.rules?.length) {
  instructions.push({
    kind: 'addRule',
    description: 'Platinum members get concise answers',
    clauses: [{ contextKind: 'user', attribute: 'plan_tier', op: 'in', values: ['platinum'], negate: false }],
    variationId: ids.concise,
  });
}
await patch(
  `${CONFIG_KEY} targeting`,
  `ai-configs/${CONFIG_KEY}/targeting`,
  { environmentKey: ENVIRONMENT, instructions },
  true,
);

console.log('\nNext: upload evals/datasets/full.jsonl as dataset `policy-agent-full` under Library > Datasets.');
