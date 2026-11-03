"""Demo members, one per ToggleHealth plan.

Each member doubles as a LaunchDarkly context, so targeting rules on `plan_id`
or `plan_tier` decide which policy_agent variation that member is served.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Member:
    member_id: str
    name: str
    state: str
    plan_id: str
    plan_name: str
    plan_tier: str
    network: str

    def context(self) -> dict:
        return {
            "kind": "user",
            "key": self.member_id,
            "name": self.name,
            "state": self.state,
            "plan_id": self.plan_id,
            "plan_tier": self.plan_tier,
        }


MEMBERS: dict[str, Member] = {
    m.member_id: m
    for m in [
        Member("M-1001", "Ana Ruiz", "CA", "TH-HMO-GOLD-2024", "Gold HMO", "gold", "TH HMO Primary"),
        Member("M-1002", "Ben Okafor", "NY", "TH-PPO-PLATINUM-2024", "Platinum PPO", "platinum", "TH PPO Nationwide"),
        Member("M-1003", "Chloe Park", "IL", "TH-EPO-SILVER-2024", "Silver EPO", "silver", "TH EPO Select"),
        Member("M-1004", "Dev Patel", "TX", "TH-HDHP-BRONZE-2024", "Bronze HDHP", "bronze", "TH HDHP Core"),
    ]
}


def get_member(member_id: str) -> Member:
    try:
        return MEMBERS[member_id]
    except KeyError:
        raise KeyError(f"Unknown member {member_id!r}. Known members: {', '.join(MEMBERS)}") from None
