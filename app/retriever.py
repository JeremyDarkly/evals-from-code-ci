"""Keyword retriever over the ToggleHealth policy documents in data/policies.

The original policy_agent retrieved from an AWS Bedrock knowledge base. This
version scores the same markdown files locally, so the agent and its evals run
without an AWS account. Swap `search` for your own retriever; nothing else in
the app depends on how documents are found.
"""

import math
import re
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

DOCS_DIR = Path(__file__).resolve().parent.parent / "data" / "policies"
PLAN_PREFIXES = ("TH-HMO-GOLD-2024", "TH-PPO-PLATINUM-2024", "TH-EPO-SILVER-2024", "TH-HDHP-BRONZE-2024")
STOPWORDS = frozenset(
    "a an and are as at be by can do does for from how i if in is it my of on or "
    "the to what when where which who will with you your me am".split()
)


@dataclass(frozen=True)
class Document:
    doc_id: str
    plan_id: str | None
    text: str
    terms: Counter


def _stem(token: str) -> str:
    """Strip a plural s, so "copay" matches documents that only say "copays"."""
    return token[:-1] if len(token) > 3 and token.endswith("s") and not token.endswith("ss") else token


def _tokenize(text: str) -> list[str]:
    return [_stem(t) for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in STOPWORDS]


def _plan_for(doc_id: str) -> str | None:
    return next((p for p in PLAN_PREFIXES if doc_id.startswith(p)), None)


@lru_cache(maxsize=1)
def _corpus() -> tuple[Document, ...]:
    docs = []
    for path in sorted(DOCS_DIR.glob("*.md")):
        text = path.read_text()
        docs.append(Document(path.stem, _plan_for(path.stem), text, Counter(_tokenize(path.stem + " " + text))))
    return tuple(docs)


def search(query: str, plan_id: str, limit: int = 4) -> list[Document]:
    """Return the best matches among the member's plan documents and the shared ones.

    Shared documents (claims, pharmacy, special programs) apply to every plan.
    Another plan's documents are never returned, so an answer can't quote the
    wrong plan's copays.
    """
    if plan_id not in PLAN_PREFIXES:
        raise ValueError(f"Unknown plan_id {plan_id!r}. Expected one of: {', '.join(PLAN_PREFIXES)}")
    candidates = [d for d in _corpus() if d.plan_id in (None, plan_id)]
    doc_freq = Counter(term for d in candidates for term in d.terms)
    query_terms = _tokenize(query)

    def score(doc: Document) -> float:
        length = sum(doc.terms.values())
        return sum(
            (doc.terms[t] / length) * math.log(1 + len(candidates) / doc_freq[t])
            for t in query_terms
            if doc.terms[t]
        )

    ranked = sorted(candidates, key=score, reverse=True)
    return [d for d in ranked[:limit] if score(d) > 0]
