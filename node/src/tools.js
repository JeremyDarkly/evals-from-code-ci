/**
 * The tool the policy agent calls. The bootstrap script creates the same tool in
 * the LaunchDarkly tool library, and the evals pass this implementation to the run.
 */

import { getMember } from './members.js';
import { search } from './retriever.js';

const MAX_EXCERPT_CHARS = 2500;

/**
 * Look up the member's plan and search only that plan's documents.
 *
 * Resolving the plan here, rather than trusting the model to pass a plan ID,
 * means the agent can't quote another plan's copays.
 */
export function searchMemberPolicy({ member_id, query }) {
  const member = getMember(member_id);
  return {
    plan_id: member.planId,
    plan_name: member.planName,
    network: member.network,
    results: search(query, member.planId).map((d) => ({ doc_id: d.docId, excerpt: d.text.slice(0, MAX_EXCERPT_CHARS) })),
  };
}

export const TOOLS = {
  search_member_policy: {
    implementation: searchMemberPolicy,
    description: "Search the member's own plan documents. Returns the plan and excerpts with document IDs to cite.",
    schema: {
      type: 'object',
      properties: {
        member_id: { type: 'string', description: 'Member ID, for example M-1001' },
        query: { type: 'string', description: "What to look for, for example 'specialist copay'" },
      },
      required: ['member_id', 'query'],
      additionalProperties: false,
    },
  },
};

export const TOOL_HANDLERS = Object.fromEntries(Object.entries(TOOLS).map(([key, tool]) => [key, tool.implementation]));
