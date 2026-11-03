/** The production entry point: answer one member question with the policy-agent config. */

import { config, initClient, shutdown } from '@launchdarkly/ai-node';
import { createOpenAIMessagesHandler } from '@launchdarkly/ai-openai-messages';

import { isMain, loadEnv } from './env.js';
import { getMember } from './members.js';
import { TOOL_HANDLERS } from './tools.js';

loadEnv();
export const CONFIG_KEY = process.env.LD_AI_CONFIG_KEY ?? 'policy-agent';

let cachedHandler;

/**
 * The handler that serves production traffic. The evals call this too, so a
 * run tests exactly the code path members hit.
 *
 * Built on first use because the OpenAI client reads OPENAI_API_KEY when it's created.
 */
export function handler() {
  cachedHandler ??= createOpenAIMessagesHandler();
  return cachedHandler;
}

export async function answer(question, member) {
  const result = await config({ key: CONFIG_KEY, handler: handler(), toolHandlers: TOOL_HANDLERS }).invoke(
    question,
    member.context(),
    { member_id: member.memberId },
  );
  return result.response;
}

if (isMain(import.meta.url)) {
  const [memberId, question] = process.argv.slice(2);
  if (!memberId || !question) {
    console.error('Usage: npm run agent -- <member_id> "<question>"');
    process.exit(1);
  }
  await initClient({ sdkKey: process.env.LD_SDK_KEY });
  try {
    console.log(await answer(question, getMember(memberId)));
  } finally {
    await shutdown();
  }
}
