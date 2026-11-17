import type {
  AlertActivityResponse,
  AuditActivityResponse,
  IncidentActivityResponse,
} from "../../src/shared/api/generated";
const period = {
  window: "24h" as const,
  since: "2026-11-16T03:00:00Z",
  generated_at: "2026-11-17T03:00:00Z",
};
export const incidentActivity: IncidentActivityResponse = {
  ...period,
  total: 2,
  current_hour: 1,
  min_events: 5,
  signals: [
    {
      provider: "기본 공급자",
      started_at: "2026-11-17T03:00:00Z",
      ended_at: "2026-11-17T03:59:59Z",
      failovers: 8,
      errors_5xx: 5,
      requests: 42,
      current_hour: true,
    },
    {
      provider: "보조 공급자",
      started_at: "2026-11-17T01:00:00Z",
      ended_at: "2026-11-17T01:59:59Z",
      failovers: 0,
      errors_5xx: 6,
      requests: 18,
      current_hour: false,
    },
  ],
};
export const alertActivity: AlertActivityResponse = {
  ...period,
  has_more: false,
  events: [
    {
      metric: "errors",
      value: 0.12,
      threshold: 0.1,
      delivered: false,
      delivery_failed: true,
      created_at: "2026-11-17T02:55:00Z",
    },
    {
      metric: "krw",
      value: 12500,
      threshold: 10000,
      delivered: true,
      delivery_failed: false,
      created_at: "2026-11-17T02:50:00Z",
    },
    {
      metric: "requests",
      value: 100,
      threshold: 80,
      delivered: false,
      delivery_failed: false,
      created_at: "2026-11-17T02:30:00Z",
    },
  ],
};
export const auditActivity: AuditActivityResponse = {
  ...period,
  has_more: true,
  changes: [
    { category: "provider", operation: "update", created_at: "2026-11-17T02:57:00Z" },
    { category: "policy", operation: "approve", created_at: "2026-11-17T02:45:00Z" },
    { category: "alert", operation: "create", created_at: "2026-11-17T02:35:00Z" },
    { category: "settings", operation: "update", created_at: "2026-11-17T02:25:00Z" },
    { category: "other", operation: "other", created_at: "2026-11-17T02:15:00Z" },
  ],
};
