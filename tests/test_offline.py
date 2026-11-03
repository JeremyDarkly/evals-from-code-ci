"""Offline checks: no LaunchDarkly or OpenAI calls."""

import json
from pathlib import Path

import pytest
from launchdarkly_ai_server.evaluations import DatasetRow

from app import retriever
from app.members import MEMBERS
from app.tools import TOOLS, search_member_policy
from evals.run_evals import EVAL_TOOLS, load_rows
from evals.scorers import cites_source, states_key_figures

DATASETS = Path(__file__).resolve().parent.parent / "evals" / "datasets"


def test_corpus_loads_every_policy_document():
    assert len(retriever._corpus()) == 90


@pytest.mark.parametrize("member", MEMBERS.values(), ids=lambda m: m.plan_id)
def test_search_never_returns_another_plans_documents(member):
    for doc in retriever.search("copay deductible specialist emergency", member.plan_id):
        assert doc.plan_id in (None, member.plan_id)


def test_search_finds_the_copays_document():
    ids = [d.doc_id for d in retriever.search("specialist visit copay", "TH-HMO-GOLD-2024")]
    assert "TH-HMO-GOLD-2024-copays-in-network" in ids


def test_search_matches_singular_and_plural():
    ids = [d.doc_id for d in retriever.search("primary care copay", "TH-HMO-GOLD-2024")]
    assert "TH-HMO-GOLD-2024-copays-in-network" in ids


def test_search_rejects_unknown_plan():
    with pytest.raises(ValueError):
        retriever.search("copay", "TH-NOPE-2024")


def test_tool_resolves_the_members_plan():
    found = search_member_policy({"member_id": "M-1003", "query": "telemedicine copay"})
    assert found["plan_id"] == "TH-EPO-SILVER-2024"
    assert found["results"][0]["doc_id"] == "TH-EPO-SILVER-2024-telemedicine"


def test_tool_rejects_unknown_member():
    with pytest.raises(KeyError):
        search_member_policy({"member_id": "M-9999", "query": "copay"})


def test_eval_tools_match_app_tools():
    assert [t.key for t in EVAL_TOOLS] == list(TOOLS)


@pytest.mark.parametrize("name", ["pr.jsonl", "full.jsonl"])
def test_datasets_are_answerable(name):
    for row in load_rows(DATASETS / name):
        member = MEMBERS[row["variables"]["member_id"]]
        corpus = " ".join(d.text for d in retriever._corpus() if d.plan_id in (None, member.plan_id))
        assert row["input"] and row["expectedOutput"]
        for figure in row["metadata"]["must_include"]:
            assert figure.lower() in row["expectedOutput"].lower()
            if any(c.isdigit() for c in figure):
                assert figure in corpus, f"{figure} not in {member.plan_id} documents"


def test_pr_rows_are_in_full_set():
    full = {json.dumps(r, sort_keys=True) for r in load_rows(DATASETS / "full.jsonl")}
    assert all(json.dumps(r, sort_keys=True) in full for r in load_rows(DATASETS / "pr.jsonl"))


def test_states_key_figures_is_fractional():
    row = DatasetRow(row_index=0, metadata={"must_include": ["$6,500", "$750"]})
    assert states_key_figures(row, "Your deductible is $6,500.") == 0.5
    assert states_key_figures(row, "$6,500 deductible, $750 HSA") == 1.0


def test_states_key_figures_fails_a_row_without_figures():
    assert states_key_figures(DatasetRow(row_index=0), "$6,500 deductible") == 0.0


def test_cites_source():
    row = DatasetRow(row_index=0)
    assert cites_source(row, "Source: TH-HMO-GOLD-2024-copays-in-network") == 1.0
    assert cites_source(row, "Source: claims-preauth-frequently-asked-questions") == 1.0
    assert cites_source(row, "Your copay is $25.") == 0.0
