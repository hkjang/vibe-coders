import type { AuthUser, UIBootstrapFeature } from "@/shared/api/schemas";

export type MigrationStatus =
  "hidden" | "legacy" | "preview_read_only" | "preview" | "stable" | "deprecated" | "retired";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface MigrationFeature {
  featureId: string;
  title: string;
  description: string;
  group: string;
  keywords: readonly string[];
  appPath: `/app/${string}`;
  legacyPath: `/admin${string}`;
  status: MigrationStatus;
  riskLevel: RiskLevel;
  requiredPermission?: string;
  readOnly: boolean;
  enabledRoles: readonly string[];
  rolloutPercent: number;
  fallbackEnabled: boolean;
  minimumApiVersion: string;
  serverAvailable?: boolean;
  availabilityReason?: string;
}

export const migrationRegistry = [
  {
    featureId: "overview",
    title: "Overview",
    description: "Gateway 운영 상태와 전환 현황을 한눈에 확인합니다.",
    group: "Overview",
    keywords: ["대시보드", "dashboard", "health", "운영"],
    appPath: "/app/overview",
    legacyPath: "/admin#/dashboard",
    status: "preview_read_only",
    riskLevel: "low",
    requiredPermission: "admin:read",
    readOnly: true,
    enabledRoles: [
      "super_admin",
      "admin",
      "ops_admin",
      "ai_admin",
      "security_admin",
      "billing_admin",
      "readonly_admin",
      "viewer",
    ],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.80.0",
  },
  {
    featureId: "gateway.health",
    title: "Gateway Health",
    description: "Provider 상태, 지연, Fallback과 Circuit Breaker를 조회합니다.",
    group: "AI Gateway",
    keywords: ["gateway", "provider", "health", "breaker", "게이트웨이", "상태"],
    appPath: "/app/gateway/health",
    legacyPath: "/admin#/routing/health",
    status: "preview_read_only",
    riskLevel: "low",
    requiredPermission: "routing:read",
    readOnly: true,
    enabledRoles: ["super_admin", "admin", "ai_admin"],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.81.0",
  },
  {
    featureId: "gateway.providers",
    title: "Provider",
    description: "AI Provider와 모델 연결을 관리합니다.",
    group: "AI Gateway",
    keywords: ["provider", "model", "공급자", "모델"],
    appPath: "/app/gateway/providers",
    legacyPath: "/admin#/settings",
    status: "preview_read_only",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: true,
    enabledRoles: ["super_admin", "admin", "ai_admin"],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.82.0",
  },
  {
    featureId: "gateway.models",
    title: "Models",
    description: "Model 상태, 품질과 가격 정보를 확인합니다.",
    group: "AI Gateway",
    keywords: ["model", "quality", "pricing", "모델"],
    appPath: "/app/gateway/models",
    legacyPath: "/admin#/model-contracts",
    status: "preview_read_only",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: true,
    enabledRoles: ["super_admin", "admin", "ai_admin"],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.82.0",
  },
  {
    featureId: "routing.rules",
    title: "라우팅",
    description: "규칙, Preview, 결정 이력과 Failover 상태를 확인합니다.",
    group: "Routing",
    keywords: ["routing", "rule", "preview", "failover", "라우팅"],
    appPath: "/app/routing/rules",
    legacyPath: "/admin#/routing",
    status: "legacy",
    riskLevel: "high",
    requiredPermission: "routing:read",
    readOnly: true,
    enabledRoles: [],
    rolloutPercent: 0,
    fallbackEnabled: true,
    minimumApiVersion: "v0.79.8",
  },
  {
    featureId: "observability.requests",
    title: "요청 탐색기",
    description: "요청, Trace와 Session을 탐색합니다.",
    group: "Observability",
    keywords: ["request", "trace", "session", "요청", "추적"],
    appPath: "/app/observability/requests",
    legacyPath: "/admin#/requests",
    status: "legacy",
    riskLevel: "low",
    requiredPermission: "observability:read",
    readOnly: true,
    enabledRoles: [],
    rolloutPercent: 0,
    fallbackEnabled: true,
    minimumApiVersion: "v0.79.8",
  },
  {
    featureId: "observability.traces",
    title: "Trace Explorer",
    description: "Trace, Span Tree와 요청 Waterfall을 확인합니다.",
    group: "Observability",
    keywords: ["trace", "span", "waterfall", "추적"],
    appPath: "/app/observability/traces",
    legacyPath: "/admin#/llm",
    status: "legacy",
    riskLevel: "low",
    requiredPermission: "observability:read",
    readOnly: true,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.80.0",
  },
  {
    featureId: "prompts.lab",
    title: "Prompt Lab",
    description: "Prompt 실험과 Evaluation을 실행합니다.",
    group: "Prompt & Evaluation",
    keywords: ["prompt", "evaluation", "프롬프트", "평가"],
    appPath: "/app/prompts/lab",
    legacyPath: "/admin#/prompt-lab",
    status: "legacy",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: true,
    enabledRoles: [],
    rolloutPercent: 0,
    fallbackEnabled: true,
    minimumApiVersion: "v0.79.8",
  },
  {
    featureId: "access.users",
    title: "사용자와 팀",
    description: "사용자, 팀, 역할과 API Key를 관리합니다.",
    group: "Access",
    keywords: ["user", "team", "role", "key", "사용자", "팀"],
    appPath: "/app/access/users",
    legacyPath: "/admin#/users",
    status: "legacy",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: true,
    enabledRoles: [],
    rolloutPercent: 0,
    fallbackEnabled: true,
    minimumApiVersion: "v0.79.8",
  },
  {
    featureId: "governance.policies",
    title: "Governance",
    description: "정책, 승인과 감사 상태를 관리합니다.",
    group: "Governance",
    keywords: ["policy", "approval", "audit", "정책", "승인"],
    appPath: "/app/governance/policies",
    legacyPath: "/admin#/safety",
    status: "legacy",
    riskLevel: "high",
    requiredPermission: "security:read",
    readOnly: true,
    enabledRoles: [],
    rolloutPercent: 0,
    fallbackEnabled: true,
    minimumApiVersion: "v0.79.8",
  },
  {
    featureId: "mcp.overview",
    title: "MCP와 Agent",
    description: "MCP Upstream, Tool, Agent와 Workflow를 관리합니다.",
    group: "MCP & Agents",
    keywords: ["mcp", "agent", "tool", "workflow", "도구"],
    appPath: "/app/mcp",
    legacyPath: "/admin#/mcp",
    status: "legacy",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: true,
    enabledRoles: [],
    rolloutPercent: 0,
    fallbackEnabled: true,
    minimumApiVersion: "v0.79.8",
  },
  {
    featureId: "text2sql.overview",
    title: "Text2SQL과 Data",
    description: "스키마, 권한, 위험 큐와 DW 상태를 확인합니다.",
    group: "Text2SQL & Data",
    keywords: ["text2sql", "schema", "data", "dw", "스키마"],
    appPath: "/app/text2sql",
    legacyPath: "/admin#/text2sql",
    status: "legacy",
    riskLevel: "high",
    requiredPermission: "admin:read",
    readOnly: true,
    enabledRoles: [],
    rolloutPercent: 0,
    fallbackEnabled: true,
    minimumApiVersion: "v0.79.8",
  },
  {
    featureId: "finops.overview",
    title: "FinOps",
    description: "비용, 예산과 사용량을 확인합니다.",
    group: "FinOps & Security",
    keywords: ["cost", "budget", "finops", "비용"],
    appPath: "/app/finops",
    legacyPath: "/admin#/billing",
    status: "legacy",
    riskLevel: "medium",
    requiredPermission: "costs:read",
    readOnly: true,
    enabledRoles: [],
    rolloutPercent: 0,
    fallbackEnabled: true,
    minimumApiVersion: "v0.79.8",
  },
  {
    featureId: "security.overview",
    title: "Security",
    description: "보안 위험, Secret과 인증 이벤트를 확인합니다.",
    group: "FinOps & Security",
    keywords: ["security", "secret", "audit", "보안"],
    appPath: "/app/security",
    legacyPath: "/admin#/security",
    status: "legacy",
    riskLevel: "high",
    requiredPermission: "security:read",
    readOnly: true,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.80.0",
  },
  {
    featureId: "system.health",
    title: "System Health",
    description: "로그, 저장소, 보안 설정과 운영 위험 신호를 조회합니다.",
    group: "System",
    keywords: ["system", "health", "risk", "logging", "disk", "시스템", "운영"],
    appPath: "/app/system/health",
    legacyPath: "/admin#/ops-home",
    status: "preview_read_only",
    riskLevel: "low",
    requiredPermission: "admin:read",
    readOnly: true,
    enabledRoles: [
      "super_admin",
      "admin",
      "ops_admin",
      "ai_admin",
      "security_admin",
      "billing_admin",
      "readonly_admin",
    ],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.81.0",
  },
  {
    featureId: "system.settings",
    title: "System",
    description: "Gateway 설정과 UI 전환 상태를 관리합니다.",
    group: "System",
    keywords: ["settings", "system", "migration", "설정", "시스템"],
    appPath: "/app/system/settings",
    legacyPath: "/admin#/settings",
    status: "legacy",
    riskLevel: "high",
    requiredPermission: "admin:read",
    readOnly: true,
    enabledRoles: [],
    rolloutPercent: 0,
    fallbackEnabled: true,
    minimumApiVersion: "v0.79.8",
  },
] as const satisfies readonly MigrationFeature[];

export type FeatureId = (typeof migrationRegistry)[number]["featureId"];

export interface EffectiveFeature {
  feature: MigrationFeature;
  status: MigrationStatus;
  readOnly: boolean;
  permitted: boolean;
  reason?: string;
}

export interface ResolveFeatureOptions {
  legacyFallback?: boolean;
}

// This list is a build-time capability boundary. Runtime migration settings may
// expose an implemented feature, but must never promote a route whose React
// screen is not present in this UI build.
const appImplementedFeatureIds: ReadonlySet<string> = new Set([
  "overview",
  "gateway.health",
  "gateway.providers",
  "gateway.models",
  "system.health",
]);

export function isAppFeatureImplemented(featureId: string): boolean {
  return appImplementedFeatureIds.has(featureId);
}

function versionParts(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function versionAtLeast(current: string, minimum: string): boolean {
  const left = versionParts(current);
  const right = versionParts(minimum);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export function rolloutBucket(userId: string, featureId: string): number {
  let hash = 2_166_136_261;
  for (const character of `${userId}:${featureId}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 100;
}

export function resolveFeature(
  feature: MigrationFeature,
  user: AuthUser | undefined,
  backendVersion: string,
  options: ResolveFeatureOptions = {},
): EffectiveFeature {
  const legacyFallback = options.legacyFallback ?? true;
  let effective: EffectiveFeature;

  if (feature.serverAvailable !== undefined) {
    effective = {
      feature,
      status: feature.status,
      readOnly: feature.readOnly || feature.status === "preview_read_only",
      permitted: feature.serverAvailable,
      reason: feature.availabilityReason,
    };
  } else {
    const roles = user ? (user.roles.length ? user.roles : [user.role]) : ["admin"];
    const scopes = user?.scopes ?? [
      "admin:read",
      "routing:read",
      "observability:read",
      "costs:read",
      "security:read",
    ];
    if (feature.requiredPermission && !scopes.includes(feature.requiredPermission)) {
      effective = {
        feature,
        status: feature.status,
        readOnly: feature.readOnly,
        permitted: false,
        reason: feature.requiredPermission,
      };
    } else if (
      (feature.status === "preview" || feature.status === "preview_read_only") &&
      feature.enabledRoles.length &&
      !feature.enabledRoles.some((role) => roles.includes(role))
    ) {
      effective =
        legacyFallback && feature.fallbackEnabled
          ? { feature, status: "legacy", readOnly: true, permitted: true, reason: "legacy_fallback" }
          : { feature, status: "hidden", readOnly: true, permitted: false, reason: "preview_role" };
    } else if (!versionAtLeast(backendVersion, feature.minimumApiVersion)) {
      effective = { feature, status: "legacy", readOnly: true, permitted: true, reason: "api_version" };
    } else if (
      (feature.status === "preview" || feature.status === "preview_read_only") &&
      rolloutBucket(user?.id ?? "legacy", feature.featureId) >= feature.rolloutPercent
    ) {
      effective = { feature, status: "legacy", readOnly: true, permitted: true, reason: "rollout" };
    } else {
      effective = {
        feature,
        status: feature.status,
        readOnly: feature.readOnly || feature.status === "preview_read_only",
        permitted: feature.status !== "hidden",
      };
    }
  }

  if (!effective.permitted) return effective;

  if (effective.status === "legacy") {
    return legacyFallback && feature.fallbackEnabled
      ? effective
      : { ...effective, permitted: false, reason: "legacy_fallback_disabled" };
  }

  if (!isAppFeatureImplemented(feature.featureId)) {
    // Retired is app-only by definition, so silently sending it back to Legacy
    // would violate the migration contract. Fail closed until this build owns
    // the screen. Other accidental promotions may safely retain Legacy access.
    if (effective.status === "retired" || !legacyFallback || !feature.fallbackEnabled) {
      return { ...effective, permitted: false, reason: "ui_not_implemented" };
    }
    return { ...effective, status: "legacy", readOnly: true, reason: "ui_not_implemented" };
  }

  return effective;
}

export function featurePath(feature: MigrationFeature): string {
  return feature.appPath.replace(/^\/app/, "") || "/";
}

export function featureByPath(
  pathname: string,
  registry: readonly MigrationFeature[] = migrationRegistry,
): MigrationFeature | undefined {
  const fullPath = pathname.startsWith("/app/") ? pathname : `/app${pathname}`;
  return registry.find(
    (feature) => fullPath === feature.appPath || fullPath.startsWith(`${feature.appPath}/`),
  );
}

function groupForFeature(feature: UIBootstrapFeature, fallback?: MigrationFeature): string {
  if (fallback) return fallback.group;
  const prefix = feature.feature_id.split(".")[0] ?? "system";
  const groups: Record<string, string> = {
    overview: "Overview",
    gateway: "AI Gateway",
    routing: "Routing",
    observability: "Observability",
    governance: "Governance",
    mcp: "MCP & Agents",
    text2sql: "Text2SQL & Data",
    finops: "FinOps & Security",
    security: "FinOps & Security",
    system: "System",
  };
  return groups[prefix] ?? "System";
}

export function registryFromBootstrap(features: readonly UIBootstrapFeature[]): readonly MigrationFeature[] {
  if (!features.length) return migrationRegistry;
  return features.map((feature) => {
    const fallback = migrationRegistry.find((candidate) => candidate.featureId === feature.feature_id);
    return {
      featureId: feature.feature_id,
      title: feature.title,
      description: fallback?.description ?? `${feature.title} 기능을 관리합니다.`,
      group: groupForFeature(feature, fallback),
      keywords: fallback?.keywords ?? [feature.feature_id, feature.title],
      appPath: feature.app_path as `/app/${string}`,
      legacyPath: feature.legacy_path as `/admin${string}`,
      status: feature.status,
      riskLevel: feature.risk_level,
      requiredPermission: feature.required_permission || undefined,
      readOnly: feature.read_only,
      enabledRoles: feature.enabled_roles,
      rolloutPercent: feature.rollout_percent,
      fallbackEnabled: feature.fallback_enabled,
      minimumApiVersion: feature.minimum_api_version,
      serverAvailable: feature.available,
      availabilityReason: feature.availability_reason,
    };
  });
}
