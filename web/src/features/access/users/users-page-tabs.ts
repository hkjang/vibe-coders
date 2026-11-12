export const accessTabIds = ["users", "teams", "keys", "ips", "quotas", "roles"] as const;
export type AccessTab = (typeof accessTabIds)[number];
