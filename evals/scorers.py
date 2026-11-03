"""Deterministic scorers. They run in this process next to the LaunchDarkly judges,
cost nothing, and catch regressions a judge might grade leniently."""

import re

from launchdarkly_ai_server.evaluations import DatasetRow, Scorer

DOC_ID = re.compile(r"\b(TH-[A-Z]+-[A-Z]+-2024|claims-preauth|pharmacy-benefits|special-programs)-[a-z0-9-]+")


def states_key_figures(row: DatasetRow, output: str | None) -> float:
    """Fraction of the row's `must_include` strings that appear in the answer.

    Every row lists at least one figure, so a row without any scores 0. That
    catches a hosted dataset that lost its metadata instead of passing it.
    """
    required = (row.metadata or {}).get("must_include", [])
    if not required:
        return 0.0
    text = (output or "").lower()
    return sum(1 for s in required if s.lower() in text) / len(required)


def cites_source(row: DatasetRow, output: str | None) -> float:
    """1.0 if the answer names at least one policy document it relied on."""
    return 1.0 if DOC_ID.search(output or "") else 0.0


SCORERS = [
    Scorer("states-key-figures", states_key_figures),
    Scorer("cites-source", cites_source),
]
