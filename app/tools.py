"""The tool the policy agent calls. The bootstrap script creates the same tool in
the LaunchDarkly tool library, and the evals pass this implementation to the run."""

from . import retriever
from .members import get_member

MAX_EXCERPT_CHARS = 2500


def search_member_policy(args: dict) -> dict:
    """Look up the member's plan and search only that plan's documents.

    Resolving the plan here, rather than trusting the model to pass a plan ID,
    means the agent can't quote another plan's copays.
    """
    member = get_member(args["member_id"])
    docs = retriever.search(args["query"], member.plan_id)
    return {
        "plan_id": member.plan_id,
        "plan_name": member.plan_name,
        "network": member.network,
        "results": [{"doc_id": d.doc_id, "excerpt": d.text[:MAX_EXCERPT_CHARS]} for d in docs],
    }


TOOLS = {
    "search_member_policy": {
        "implementation": search_member_policy,
        "description": "Search the member's own plan documents. Returns the plan and excerpts with document IDs to cite.",
        "schema": {
            "type": "object",
            "properties": {
                "member_id": {"type": "string", "description": "Member ID, for example M-1001"},
                "query": {"type": "string", "description": "What to look for, for example 'specialist copay'"},
            },
            "required": ["member_id", "query"],
            "additionalProperties": False,
        },
    },
}

TOOL_HANDLERS = {key: tool["implementation"] for key, tool in TOOLS.items()}
