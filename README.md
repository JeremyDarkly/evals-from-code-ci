# Evals from code in CI

Run your real agent against a dataset on every pull request, grade it with LaunchDarkly judges and local scorers, and gate the merge on the result. Results land in LaunchDarkly AgentControl next to the config they tested.

The demo app is a health insurance policy agent for a fictional insurer, ToggleHealth. It answers member questions with one tool, `search_member_policy`, which looks up the member's plan and searches only that plan's policy documents.

## How it works

- `app/agent.py` is the production entry point. It serves the `policy-agent` AI Config with the LaunchDarkly AI SDK 1.0 and the OpenAI messages handler.
- `evals/run_evals.py` calls `init_evaluations()` and `evals.run()` with that same handler and the same tool implementations, so a run tests the code path members hit.
- Each dataset row names a member. Members are LaunchDarkly contexts, so targeting decides which variation each one gets. The script asks LaunchDarkly which variation each member is served and runs one evaluation per variation.
- Every row is graded by two judges and two scorers:
  - `policy-accuracy` is a judge that compares the answer to the row's expected output.
  - `policy-tool-use` is a judge that reads the tool-call trajectory and checks the agent searched the right member's plan and answered only from what came back.
  - `states-key-figures` is a scorer that checks the dollar amounts in the row's `must_include` appear in the answer.
  - `cites-source` is a scorer that checks the answer names a policy document.
- `evals.run()` returns `passed`, the row counts and a link to the run. The script writes them to the GitHub job summary and exits 1 when `--blocking` is set and the run failed.

`passed` is strict: one failed or errored row fails the run.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in the four values
pytest -q              # offline, no API calls
python -m bootstrap.bootstrap
```

The bootstrap script creates the tool, the two judges and the `policy-agent` config with two variations. `grounded` is the default and `concise` is targeted to Platinum members. Re-running it is safe.

Try the agent, then run the PR eval set:

```bash
python -m app.agent M-1001 "What's my specialist copay?"
python -m evals.run_evals --dataset evals/datasets/pr.jsonl
```

## Node.js

`node/` is the same app and eval runner built on `@launchdarkly/ai-node` and `@launchdarkly/ai-openai-messages`. It reads the same `.env`, policy documents and datasets, and targets the same LaunchDarkly resources, so you can run either bootstrap script. It needs Node.js 22 or later.

```bash
cd node
npm install
npm test               # offline, no API calls
npm run bootstrap
npm run agent -- M-1001 "What's my specialist copay?"
npm run evals -- --dataset ../evals/datasets/pr.jsonl
```

## Datasets

`evals/datasets/pr.jsonl` has 6 rows and runs on every pull request. `full.jsonl` has 20 rows and runs on a schedule. Both are sent as inline rows, so they're versioned with the code they test.

To keep a dataset in LaunchDarkly instead, upload `full.jsonl` under **Library > Datasets** and pass its key. A hosted dataset runs every row against one variation:

```bash
python -m evals.run_evals --dataset-key policy-agent-full --variation grounded
```

## CI

`.github/workflows/evals-pr.yml` runs the offline tests, then the PR eval set. `evals-pr-node.yml` does the same for `node/`. `evals-scheduled.yml` runs the full set in both languages on weekday mornings.

Add the secrets `LD_SDK_KEY`, `LD_API_TOKEN` and `OPENAI_API_KEY`, and the variable `LD_PROJECT_KEY`.

The PR check starts as advisory: a failed eval shows in the job summary but doesn't fail the job. Once the suite is stable, set the repository variable `EVALS_BLOCKING` to `true` and make `evals-gate`, or `evals-gate-node` for the Node.js version, a required check. The gate job reports on every pull request, including ones that change no app files and skip the evals, and fails when the offline tests or the evals fail.

Pull requests from forks get no repository secrets, so they skip the evals. Run the evals yourself before you merge one.

## Prompt and response capture

The SDK records prompts and responses so judges can grade them. To turn capture off, call `configure(options=SDKOptions(capture_content=False))` before `init_client`.

## Credits

The ToggleHealth policy documents in `data/policies` come from [marekdarkly/policy_agent](https://github.com/marekdarkly/policy_agent), MIT License, copyright (c) 2025 marekdarkly. See `data/policies/LICENSE`. This repo replaces that project's Bedrock knowledge base with a local keyword retriever, `app/retriever.py`.
