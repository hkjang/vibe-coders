export const ipTableIds = ["ips", "ip_models", "ip_keys", "ip_days", "ip_languages", "ip_requests"] as const;
export type IpTableId = (typeof ipTableIds)[number];
export const ipQueryKeys = [
  "ip",
  "ip_view",
  ...ipTableIds.flatMap((id) => [id + "_q", id + "_sort", id + "_page", id + "_size"]),
];
