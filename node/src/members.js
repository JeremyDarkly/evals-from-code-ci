/**
 * Demo members, one per ToggleHealth plan.
 *
 * Each member doubles as a LaunchDarkly context, so targeting rules on `plan_id`
 * or `plan_tier` decide which policy-agent variation that member is served.
 */

class Member {
  constructor(memberId, name, state, planId, planName, planTier, network) {
    Object.assign(this, { memberId, name, state, planId, planName, planTier, network });
    Object.freeze(this);
  }

  context() {
    return {
      kind: 'user',
      key: this.memberId,
      name: this.name,
      state: this.state,
      plan_id: this.planId,
      plan_tier: this.planTier,
    };
  }
}

export const MEMBERS = new Map(
  [
    new Member('M-1001', 'Ana Ruiz', 'CA', 'TH-HMO-GOLD-2024', 'Gold HMO', 'gold', 'TH HMO Primary'),
    new Member('M-1002', 'Ben Okafor', 'NY', 'TH-PPO-PLATINUM-2024', 'Platinum PPO', 'platinum', 'TH PPO Nationwide'),
    new Member('M-1003', 'Chloe Park', 'IL', 'TH-EPO-SILVER-2024', 'Silver EPO', 'silver', 'TH EPO Select'),
    new Member('M-1004', 'Dev Patel', 'TX', 'TH-HDHP-BRONZE-2024', 'Bronze HDHP', 'bronze', 'TH HDHP Core'),
  ].map((m) => [m.memberId, m]),
);

export function getMember(memberId) {
  const member = MEMBERS.get(memberId);
  if (!member) throw new Error(`Unknown member '${memberId}'. Known members: ${[...MEMBERS.keys()].join(', ')}`);
  return member;
}
