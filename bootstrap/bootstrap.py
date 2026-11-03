"""Create the LaunchDarkly resources this repo expects. Safe to re-run: anything
that already exists is left as it is.

    python -m bootstrap.bootstrap

Creates, in LD_PROJECT_KEY:
- tool `search_member_policy`
- judges `policy-accuracy` and `policy-tool-use`
- AI Config `policy-agent` (or LD_AI_CONFIG_KEY) with variations `grounded` and
  `concise`, the judges attached, `grounded` as the production fallthrough, and
  Platinum members targeted to `concise`

Needs LD_API_TOKEN with permission to write AI Configs in the project.
"""

import json
import os
import sys
import urllib.error
import urllib.request

from app.agent import CONFIG_KEY
from app.tools import TOOLS

BASE = os.environ.get("LD_API_BASE_URI", "https://app.launchdarkly.com").rstrip("/")
ENVIRONMENT = os.environ.get("LD_ENVIRONMENT_KEY", "production")
AGENT_MODEL = "gpt-4.1-mini"
# gpt-5-mini rejects the temperature parameter, so judge variations set none.
JUDGE_MODEL = "gpt-5-mini"

SYSTEM_PROMPT = """You are ToggleHealth's policy assistant. You are helping member {{member_id}}.

1. Call search_member_policy with member_id {{member_id}} and a short query before you answer.
   Never answer from memory, and never guess the member's plan.
2. Answer only from the excerpts it returns. Quote dollar amounts exactly.
3. If the excerpts don't answer the question, say so and suggest calling Member Services.
4. End with "Source:" followed by the doc_id of each excerpt you used."""

VARIATIONS = {
    "grounded": SYSTEM_PROMPT,
    "concise": SYSTEM_PROMPT + "\n\nKeep the answer to two sentences before the Source line.",
}

JUDGES = {
    "policy-accuracy": {
        "metric": "policy-accuracy",
        "prompt": """You grade a health insurance assistant's answer against a reference answer.

Reference answer: {{expected_output}}

Score 1.0 when every dollar amount, limit and yes/no fact in the reference appears in the answer and
nothing in the answer contradicts it. Score 0.5 when the answer is partly right or omits a required fact.
Score 0.0 when it states a wrong amount, quotes another plan, or invents coverage. Ignore wording and tone.""",
    },
    "policy-tool-use": {
        "metric": "policy-tool-use",
        "prompt": """You grade how a health insurance assistant used its tools. The conversation below includes
every tool call it made and every result it got back.

Score 1.0 when it called search_member_policy for the member it is helping, with a query that fits the
question, and every fact in the answer comes from what the tool returned.
Score 0.5 when the call was right but the answer adds facts that are not in any tool result.
Score 0.0 when it answered without calling search_member_policy, or searched for a different member.""",
    },
}


class LD:
    def __init__(self) -> None:
        self.token = os.environ["LD_API_TOKEN"]
        self.project = os.environ["LD_PROJECT_KEY"]

    def request(self, method: str, path: str, body: dict | None = None, semantic: bool = False) -> tuple[int, dict]:
        content_type = "application/json; domain-model=launchdarkly.semanticpatch" if semantic else "application/json"
        req = urllib.request.Request(
            f"{BASE}/api/v2/projects/{self.project}/{path}",
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": self.token, "LD-API-Version": "beta", "Content-Type": content_type},
        )
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, _parse(resp.read())
        except urllib.error.HTTPError as err:
            return err.code, _parse(err.read())

    def create(self, label: str, path: str, body: dict) -> dict:
        """Create the resource unless it exists, and return it."""
        # Re-posting an existing AI Config can return 400 instead of 409, so check first.
        status, data = self.request("GET", f"{path}/{body['key']}")
        if status == 200:
            print(f"exists   {label}")
            return data
        status, data = self.request("POST", path, body)
        if status not in (200, 201):
            sys.exit(f"failed   {label}: {status} {data.get('message', data)}")
        print(f"created  {label}")
        return data

    def patch(self, label: str, path: str, body: dict, semantic: bool = False) -> None:
        status, data = self.request("PATCH", path, body, semantic)
        if status not in (200, 201):
            sys.exit(f"failed   {label}: {status} {data.get('message', data)}")
        print(f"updated  {label}")


def _parse(raw: bytes) -> dict:
    """Parse a response body. Gateways can return HTML or plain text on errors."""
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {"message": raw.decode(errors="replace")[:200]}


def model(name: str) -> dict:
    return {"modelName": name, "parameters": {}, "custom": {}}


def main() -> None:
    ld = LD()

    tool_versions = {}
    for key, tool in TOOLS.items():
        created = ld.create(f"tool {key}", "ai-tools", {
            "key": key, "name": key, "description": tool["description"], "type": "function", "schema": tool["schema"],
        })
        tool_versions[key] = created["version"]

    for key, judge in JUDGES.items():
        ld.create(f"judge {key}", "ai-configs", {
            "key": key, "name": key, "mode": "judge",
            "evaluationMetricKey": f"$ld:ai:judge:{judge['metric']}", "isInverted": False,
        })
        ld.create(f"judge {key} variation", f"ai-configs/{key}/variations", {
            "key": "default", "name": "default", "modelConfigKey": f"OpenAI.{JUDGE_MODEL}", "model": model(JUDGE_MODEL),
            "messages": [
                {"role": "system", "content": judge["prompt"]},
                {"role": "user", "content": "{{message_history}}"},
            ],
        })

    ld.create(f"config {CONFIG_KEY}", "ai-configs", {"key": CONFIG_KEY, "name": "Policy agent", "mode": "completion"})
    for key, prompt in VARIATIONS.items():
        ld.create(f"{CONFIG_KEY} variation {key}", f"ai-configs/{CONFIG_KEY}/variations", {
            "key": key, "name": key, "modelConfigKey": f"OpenAI.{AGENT_MODEL}", "model": model(AGENT_MODEL),
            "messages": [{"role": "system", "content": prompt}],
            "tools": [{"key": k, "version": v} for k, v in tool_versions.items()],
        })
        ld.patch(f"{CONFIG_KEY} variation {key} judges", f"ai-configs/{CONFIG_KEY}/variations/{key}", {
            "judgeConfiguration": {"judges": [{"judgeConfigKey": j, "samplingRate": 1} for j in JUDGES]},
        })

    status, targeting = ld.request("GET", f"ai-configs/{CONFIG_KEY}/targeting")
    if status != 200:
        sys.exit(f"failed   read {CONFIG_KEY} targeting: {status} {targeting.get('message', targeting)}")
    env = targeting.get("environments", {}).get(ENVIRONMENT)
    if env is None:
        sys.exit(f"failed   environment {ENVIRONMENT!r} not found in the project. Set LD_ENVIRONMENT_KEY.")
    ids = {v["value"]["_ldMeta"].get("variationKey"): v["_id"] for v in targeting["variations"]}
    instructions = [{"kind": "updateFallthroughVariationOrRollout", "variationId": ids["grounded"]}]
    if not env.get("rules"):
        instructions.append({
            "kind": "addRule",
            "description": "Platinum members get concise answers",
            "clauses": [{"contextKind": "user", "attribute": "plan_tier", "op": "in", "values": ["platinum"], "negate": False}],
            "variationId": ids["concise"],
        })
    ld.patch(f"{CONFIG_KEY} targeting", f"ai-configs/{CONFIG_KEY}/targeting",
             {"environmentKey": ENVIRONMENT, "instructions": instructions}, semantic=True)

    print("\nNext: upload evals/datasets/full.jsonl as dataset `policy-agent-full` under Library > Datasets.")


if __name__ == "__main__":
    main()
