"""Run the policy agent against a dataset and gate CI on the result.

    python -m evals.run_evals --dataset evals/datasets/pr.jsonl
    python -m evals.run_evals --dataset-key policy-agent-full --variation grounded --blocking

Each member in the dataset is a LaunchDarkly context, so different members can
be served different policy-agent variations. The script asks LaunchDarkly which
variation each member gets and runs one evaluation per variation, using the
same handler and tool implementations the app uses in production.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv
from launchdarkly_ai_server import init_client, inspect_config, shutdown
from launchdarkly_ai_server.evaluations import (
    AIConfig,
    EvalRunResult,
    EvalTool,
    Judge,
    init_evaluations,
)

from app.agent import CONFIG_KEY, handler
from app.members import get_member
from app.tools import TOOLS

from .scorers import SCORERS

EVAL_TOOLS = [
    EvalTool(key, tool["implementation"], schema=tool["schema"], description=tool["description"])
    for key, tool in TOOLS.items()
]
CRITERIA = [Judge("policy-accuracy"), Judge("policy-tool-use"), *SCORERS]


def load_rows(path: Path) -> list[dict]:
    """Read a JSONL dataset in upload shape and return inline rows in wire shape."""
    rows = []
    for line in path.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            rows.append(
                {
                    "input": row["input"],
                    "expectedOutput": row.get("expected_output"),
                    "variables": row.get("variables", {}),
                    "metadata": row.get("metadata", {}),
                }
            )
    return rows


async def served_variation(member_id: str) -> str:
    inspected = await inspect_config(CONFIG_KEY, get_member(member_id).context())
    if not inspected["enabled"] or not inspected["meta"]:
        raise SystemExit(f"{CONFIG_KEY} is off or unreachable for member {member_id}")
    return inspected["meta"]["variationKey"]


async def group_by_variation(rows: list[dict]) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = defaultdict(list)
    variations = {}
    for row in rows:
        member_id = row["variables"]["member_id"]
        if member_id not in variations:
            variations[member_id] = await served_variation(member_id)
        groups[variations[member_id]].append(row)
    return groups


def report(results: dict[str, EvalRunResult], blocking: bool) -> str:
    passed = all(r.passed for r in results.values())
    mode = "blocking" if blocking else "advisory"
    lines = [f"## Policy agent evals: {'passed' if passed else 'failed'} ({mode})", ""]
    lines.append("| Variation | Result | Passed | Failed | Errored | Run |")
    lines.append("|---|---|---|---|---|---|")
    for variation, r in results.items():
        s = r.summary
        verdict = "pass" if r.passed else "fail"
        lines.append(
            f"| `{variation}` | {verdict} | {s.passed_rows}/{s.total_rows} | {s.failed_rows} "
            f"| {s.error_rows} | [results]({r.url}) |"
        )
    return "\n".join(lines) + "\n"


async def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--dataset", type=Path, help="local JSONL file, sent as inline rows")
    source.add_argument("--dataset-key", help="key of a dataset stored in LaunchDarkly")
    parser.add_argument("--variation", help="variation to run a hosted dataset against")
    parser.add_argument("--blocking", action="store_true", help="exit 1 when the evaluation fails")
    args = parser.parse_args()
    if args.dataset_key and not args.variation:
        parser.error("--dataset-key needs --variation: every row of a hosted dataset runs against one variation")

    await init_client({"sdkKey": os.environ["LD_SDK_KEY"]})
    evals = init_evaluations()
    # Run keys must be unique, and a re-run of a workflow keeps its GITHUB_RUN_ID.
    run_id = "-".join(
        filter(None, [os.environ.get("GITHUB_RUN_ID"), os.environ.get("GITHUB_RUN_ATTEMPT")])
    ) or str(int(time.time()))
    try:
        if args.dataset:
            groups = await group_by_variation(load_rows(args.dataset))
        else:
            groups = {args.variation: args.dataset_key}

        results = {}
        for variation, dataset in groups.items():
            results[variation] = await evals.run(
                key=f"{CONFIG_KEY}-{variation}-{run_id}",
                dataset=dataset,
                handler=handler(),
                ai_config=AIConfig(CONFIG_KEY, variation),
                tools=EVAL_TOOLS,
                criteria=CRITERIA,
            )
    finally:
        await shutdown()

    summary = report(results, args.blocking)
    print(summary)
    if step_summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(step_summary, "a") as f:
            f.write(summary)
    passed = all(r.passed for r in results.values())
    return 1 if args.blocking and not passed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
