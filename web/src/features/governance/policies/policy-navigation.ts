export const policyTabs = ["safety", "sunset", "advisor"] as const;
export type PolicyTab = (typeof policyTabs)[number];
