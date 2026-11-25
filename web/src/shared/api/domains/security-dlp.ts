import { z } from "zod";

import { operation } from "@/shared/api/endpoint-factory";
import type {
  GetAdminSecurityDlpData,
  GetAdminSecurityDlpEventsData,
  GetAdminSecurityDlpEventsResponse,
  GetAdminSecurityDlpResponse,
  PostAdminSecurityDlpTestData,
  PostAdminSecurityDlpTestResponse,
  PutAdminSecurityDlpData,
  PutAdminSecurityDlpResponse,
} from "@/shared/api/generated";
import { orDefault } from "@/shared/api/loose";

const text = orDefault(z.string(), "");
const count = orDefault(z.number(), 0);
const list = orDefault(z.array(z.string()), []);

export const dlpActions = ["FLAG", "MASK", "BLOCK"] as const;
export type DLPAction = (typeof dlpActions)[number];
export const dlpChecks = ["REQUEST", "RESPONSE"] as const;
export type DLPCheck = (typeof dlpChecks)[number];
export const dlpConfidences = ["low", "medium", "high"] as const;
export type DLPConfidence = (typeof dlpConfidences)[number];

const confidence = z.enum(dlpConfidences);

export const dlpProfileSettingsSchema = z.object({
  disabled_entries: list,
  min_confidence: confidence.optional(),
  min_matches: z.number().int().min(0).max(100).optional(),
});
export type DLPProfileSettings = z.output<typeof dlpProfileSettingsSchema>;

export const dlpCustomEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["regex", "keywords"]),
  pattern: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  case_sensitive: z.boolean().optional(),
  confidence: confidence.optional(),
  context: z.array(z.string()).optional(),
  mask: z.string().optional(),
});
export type DLPCustomEntry = z.output<typeof dlpCustomEntrySchema>;

export const dlpCustomProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  min_confidence: confidence.optional(),
  min_matches: z.number().int().min(0).max(100).optional(),
  entries: z.array(dlpCustomEntrySchema),
});
export type DLPCustomProfile = z.output<typeof dlpCustomProfileSchema>;

export const dlpPolicySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  enabled: z.boolean(),
  action: z.enum(dlpActions),
  profiles: z.array(z.string()),
  check: z.array(z.enum(dlpChecks)),
  teams: z.array(z.string()).optional(),
  api_keys: z.array(z.string()).optional(),
  note: z.string().optional(),
});
export type DLPPolicy = z.output<typeof dlpPolicySchema>;

export const dlpConfigSchema = z.object({
  enabled: z.boolean(),
  evidence: z.enum(["partial", "hash_only"]),
  max_scan_bytes: z.number().int(),
  oversize: z.enum(["allow", "block"]),
  profiles: orDefault(z.record(z.string(), dlpProfileSettingsSchema), {}),
  custom_profiles: orDefault(z.array(dlpCustomProfileSchema), []),
  policies: orDefault(z.array(dlpPolicySchema), []),
});
export type DLPConfig = z.output<typeof dlpConfigSchema>;

const catalogEntrySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: text,
  base_confidence: z.enum(["none", "low", "medium", "high"]),
  requires_context: z.boolean(),
  context: list,
  mask: text,
  example: text,
});
export type DLPCatalogEntry = z.output<typeof catalogEntrySchema>;

const catalogProfileSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: text,
  default_min_confidence: confidence,
  default_min_matches: count,
  record_distinct: count,
  record_window: count,
  entries: orDefault(z.array(catalogEntrySchema), []),
});
export type DLPCatalogProfile = z.output<typeof catalogProfileSchema>;

const settingsSchema = z.looseObject({
  config: dlpConfigSchema,
  revision: count,
  updated_by: text,
  updated_at: text,
  catalog: orDefault(z.array(catalogProfileSchema), []),
  recommended_policies: orDefault(z.array(dlpPolicySchema), []),
  response_header: orDefault(z.string(), "X-Vibe-DLP"),
  compat_header: orDefault(z.string(), "cf-aig-dlp"),
});
export type DLPSettings = z.output<typeof settingsSchema>;

const writeSchema = z.looseObject({
  config: dlpConfigSchema,
  revision: count,
  updated_by: text,
  updated_at: text,
});

export const dlpIssueSchema = z.object({ path: z.string(), message: z.string() });
export type DLPIssue = z.output<typeof dlpIssueSchema>;

/** The body of a 422: what is wrong, by path into the configuration. */
export const dlpRejectionSchema = z.looseObject({ issues: z.array(dlpIssueSchema) });

const policyHitSchema = z.looseObject({
  policy_id: z.string(),
  action: z.enum(dlpActions),
  profiles: list,
});
export type DLPPolicyHit = z.output<typeof policyHitSchema>;

const decisionSchema = z.looseObject({
  action: z.enum(["", ...dlpActions]),
  policies: orDefault(z.array(policyHitSchema), []),
});
export type DLPDecision = z.output<typeof decisionSchema>;

const testSchema = z.looseObject({
  matches: orDefault(
    z.array(
      z.looseObject({
        profile_id: z.string(),
        entry_id: z.string(),
        entry_name: text,
        start: z.number(),
        end: z.number(),
        confidence: confidence,
      }),
    ),
    [],
  ),
  profiles: orDefault(
    z.array(
      z.looseObject({
        profile_id: z.string(),
        name: text,
        triggered: z.boolean(),
        match_count: count,
        entry_ids: list,
      }),
    ),
    [],
  ),
  truncated: orDefault(z.boolean(), false),
  scanned_bytes: count,
  request: decisionSchema,
  response: decisionSchema,
  masked_request: text,
  header: text,
});
export type DLPTestResult = z.output<typeof testSchema>;
export type DLPTestMatch = DLPTestResult["matches"][number];

const eventSchema = z.looseObject({
  id: z.string(),
  request_id: z.string(),
  api_key_id: text,
  user_id: text,
  team_id: text,
  check: z.enum(dlpChecks),
  action: z.enum(dlpActions),
  policy_ids: list,
  profile_id: z.string(),
  entry_ids: list,
  match_count: count,
  confidence: text,
  evidence: list,
  hashes: list,
  endpoint: text,
  model: text,
  created_at: text,
});
export type DLPEvent = z.output<typeof eventSchema>;

const eventCountSchema = z.looseObject({
  key: z.string(),
  events: count,
  requests: count,
  matches: count,
});
export type DLPEventCount = z.output<typeof eventCountSchema>;

const eventsSchema = z.looseObject({
  events: orDefault(z.array(eventSchema), []),
  summary: orDefault(
    z.looseObject({
      by_action: orDefault(z.array(eventCountSchema), []),
      by_check: orDefault(z.array(eventCountSchema), []),
      by_profile: orDefault(z.array(eventCountSchema), []),
      by_day: orDefault(z.array(eventCountSchema), []),
    }),
    { by_action: [], by_check: [], by_profile: [], by_day: [] },
  ),
  hours: count,
  count: count,
});
export type DLPEvents = z.output<typeof eventsSchema>;

export const dlpEventsQuerySchema = z
  .object({
    hours: z.number().int().min(1).max(2160).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    action: z.enum(dlpActions).optional(),
    check: z.enum(dlpChecks).optional(),
    profile: z.string().max(80).optional(),
    request_id: z.string().max(128).optional(),
    team_id: z.string().max(128).optional(),
  })
  .strict();
export type DLPEventsQuery = z.input<typeof dlpEventsQuerySchema>;

export const securityDlpEndpoints = {
  settings: operation<GetAdminSecurityDlpData, GetAdminSecurityDlpResponse>()(
    "GET",
    "/admin/security/dlp",
    settingsSchema,
  ),
  save: operation<PutAdminSecurityDlpData, PutAdminSecurityDlpResponse>()(
    "PUT",
    "/admin/security/dlp",
    writeSchema,
  ),
  test: operation<PostAdminSecurityDlpTestData, PostAdminSecurityDlpTestResponse>()(
    "POST",
    "/admin/security/dlp/test",
    testSchema,
  ),
  events: operation<GetAdminSecurityDlpEventsData, GetAdminSecurityDlpEventsResponse>()(
    "GET",
    "/admin/security/dlp/events",
    eventsSchema,
    dlpEventsQuerySchema,
  ),
} as const;
