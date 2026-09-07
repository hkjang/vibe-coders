import { implementedFeatureIds } from "@/features/registry";
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
    title: "통합 현황",
    description: "게이트웨이 운영 상태와 전환 현황을 한눈에 확인합니다.",
    group: "개요",
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
    featureId: "me.home",
    title: "내 홈",
    description: "내 사용량, 요청 영수증, API 키와 연결 도우미를 확인합니다.",
    group: "개요",
    keywords: ["me", "home", "keys", "내 키", "영수증"],
    appPath: "/app/me",
    legacyPath: "/admin#/me",
    status: "preview",
    riskLevel: "low",
    requiredPermission: undefined,
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "team.home",
    title: "팀 대시보드",
    description: "팀의 사용량, 비용, 실패와 팀 포털을 확인합니다.",
    group: "개요",
    keywords: ["team", "portal", "팀", "포털"],
    appPath: "/app/team",
    legacyPath: "/admin#/team",
    status: "preview",
    riskLevel: "low",
    requiredPermission: "team:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "gateway.health",
    title: "게이트웨이 상태",
    description: "공급자 상태, 지연, 대체 경로와 회로 차단기를 조회합니다.",
    group: "AI 게이트웨이",
    keywords: ["gateway", "provider", "health", "breaker", "게이트웨이", "상태"],
    appPath: "/app/gateway/health",
    legacyPath: "/admin#/routing/health",
    status: "preview",
    riskLevel: "low",
    requiredPermission: "routing:read",
    readOnly: false,
    enabledRoles: ["super_admin", "admin", "ai_admin"],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "gateway.providers",
    title: "AI 공급자",
    description: "AI 공급자와 모델 연결을 관리합니다.",
    group: "AI 게이트웨이",
    keywords: ["provider", "model", "공급자", "모델"],
    appPath: "/app/gateway/providers",
    legacyPath: "/admin#/settings",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: ["super_admin", "admin", "ai_admin"],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "gateway.models",
    title: "모델",
    description: "모델 상태, 품질과 가격 정보를 확인합니다.",
    group: "AI 게이트웨이",
    keywords: ["model", "quality", "pricing", "모델"],
    appPath: "/app/gateway/models",
    legacyPath: "/admin#/model-contracts",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: ["super_admin", "admin", "ai_admin"],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "gateway.chat",
    title: "Chat 테스트",
    description: "게이트웨이를 통해 모델을 직접 호출하고 스트리밍 응답을 비교합니다.",
    group: "AI 게이트웨이",
    keywords: ["chat", "test", "stream", "compare", "채팅", "테스트"],
    appPath: "/app/gateway/chat",
    legacyPath: "/admin#/chat-test",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "routing.rules",
    title: "라우팅",
    description: "규칙, 미리보기, 결정 이력과 장애 조치 상태를 확인합니다.",
    group: "라우팅",
    keywords: ["routing", "rule", "preview", "failover", "라우팅"],
    appPath: "/app/routing/rules",
    legacyPath: "/admin#/routing",
    status: "preview",
    riskLevel: "high",
    requiredPermission: "routing:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "observability.requests",
    title: "요청 탐색기",
    description: "최근 요청의 안전한 운영 메타데이터를 조회합니다.",
    group: "관측",
    keywords: ["request", "trace", "session", "요청", "추적"],
    appPath: "/app/observability/requests",
    legacyPath: "/admin#/requests",
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
    minimumApiVersion: "v0.83.0",
  },
  {
    featureId: "observability.traces",
    title: "추적 탐색기",
    description: "같은 추적 ID로 연결된 요청의 처리 흐름을 확인합니다.",
    group: "관측",
    keywords: ["trace", "span", "waterfall", "추적"],
    appPath: "/app/observability/traces",
    legacyPath: "/admin#/llm",
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
    minimumApiVersion: "v0.83.0",
  },
  {
    featureId: "observability.sessions",
    title: "세션 비행기록",
    description: "코딩 세션과 요청 흐름을 시간순으로 재생합니다.",
    group: "관측",
    keywords: ["session", "flight recorder", "세션", "비행기록"],
    appPath: "/app/observability/sessions",
    legacyPath: "/admin#/sessions",
    status: "preview",
    riskLevel: "low",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "observability.xview",
    title: "XView 실시간",
    description: "요청 분산과 이상치를 실시간 산점도로 관찰합니다.",
    group: "관측",
    keywords: ["xview", "scatter", "live", "실시간", "산점도", "waterfall"],
    appPath: "/app/observability/xview",
    legacyPath: "/admin#/xview",
    status: "preview",
    riskLevel: "low",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "observability.llm",
    title: "LLM 관측",
    description: "모델 호출 품질, 평가와 피드백을 분석합니다.",
    group: "관측",
    keywords: ["llm", "observability", "evaluation", "feedback", "평가", "피드백"],
    appPath: "/app/observability/llm",
    legacyPath: "/admin#/llm",
    status: "preview",
    riskLevel: "low",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "observability.probes",
    title: "진단 프로브",
    description: "개발 도구별 Journey Probe와 파드 운영 맵을 확인합니다.",
    group: "관측",
    keywords: ["journey", "probe", "pod", "파드", "프로브"],
    appPath: "/app/observability/probes",
    legacyPath: "/admin#/journey-probe",
    status: "preview",
    riskLevel: "low",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "prompts.lab",
    title: "프롬프트 실험실",
    description: "프롬프트 실험과 평가를 실행합니다.",
    group: "프롬프트 및 평가",
    keywords: ["prompt", "evaluation", "프롬프트", "평가"],
    appPath: "/app/prompts/lab",
    legacyPath: "/admin#/prompt-lab",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "prompts.library",
    title: "프롬프트 라이브러리",
    description: "프롬프트 검색, 자산 관리소와 프롬프트 부채를 관리합니다.",
    group: "프롬프트 및 평가",
    keywords: ["prompt", "asset", "debt", "프롬프트", "자산"],
    appPath: "/app/prompts/library",
    legacyPath: "/admin#/prompts",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "access.users",
    title: "사용자와 팀",
    description: "사용자, 팀, 역할과 API 키를 관리합니다.",
    group: "접근 관리",
    keywords: ["user", "team", "role", "key", "사용자", "팀"],
    appPath: "/app/access/users",
    legacyPath: "/admin#/users",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "governance.policies",
    title: "정책 및 거버넌스",
    description: "정책, 승인과 감사 상태를 관리합니다.",
    group: "거버넌스",
    keywords: ["policy", "approval", "audit", "정책", "승인"],
    appPath: "/app/governance/policies",
    legacyPath: "/admin#/safety",
    status: "preview",
    riskLevel: "high",
    requiredPermission: "security:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "governance.remediation",
    title: "자동 조치",
    description: "탐지된 문제에 대한 자동 조치 규칙과 이력을 관리합니다.",
    group: "거버넌스",
    keywords: ["remediation", "auto", "조치"],
    appPath: "/app/governance/remediation",
    legacyPath: "/admin#/remediation",
    status: "preview",
    riskLevel: "high",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "governance.reports",
    title: "운영 리포트",
    description: "팀 성숙도, 운영 보고서와 AI 업무성과를 확인합니다.",
    group: "거버넌스",
    keywords: ["scorecard", "narrative", "productivity", "성숙도", "보고서", "업무성과"],
    appPath: "/app/governance/reports",
    legacyPath: "/admin#/scorecard",
    status: "preview",
    riskLevel: "low",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "governance.assets",
    title: "AI 자산",
    description: "AI 자산 SBOM과 개인화 프로필을 관리합니다.",
    group: "거버넌스",
    keywords: ["sbom", "personalization", "자산", "개인화"],
    appPath: "/app/governance/assets",
    legacyPath: "/admin#/sbom",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "mcp.overview",
    title: "MCP와 에이전트",
    description: "MCP 업스트림, 도구, 에이전트와 워크플로를 관리합니다.",
    group: "MCP 및 에이전트",
    keywords: ["mcp", "agent", "tool", "workflow", "도구"],
    appPath: "/app/mcp",
    legacyPath: "/admin#/mcp",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "mcp.gateway",
    title: "Gateway MCP",
    description: "게이트웨이가 제공하는 MCP 도구와 접근 정책을 관리합니다.",
    group: "MCP 및 에이전트",
    keywords: ["mcp", "gateway", "tool", "도구"],
    appPath: "/app/mcp-gateway",
    legacyPath: "/admin#/gateway-mcp",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "agents.registry",
    title: "에이전트",
    description: "에이전트, 가상 모델 경로와 VCS 이벤트를 관리합니다.",
    group: "MCP 및 에이전트",
    keywords: ["agent", "route", "vcs", "에이전트", "가상 모델"],
    appPath: "/app/agents/registry",
    legacyPath: "/admin#/agents",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "agents.workflows",
    title: "워크플로",
    description: "워크플로 체인을 정의하고 검증·게시합니다.",
    group: "MCP 및 에이전트",
    keywords: ["workflow", "chain", "워크플로"],
    appPath: "/app/agents/workflows",
    legacyPath: "/admin#/workflows",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "agents.apps",
    title: "AI 업무 앱",
    description: "AI 업무 앱과 앱 템플릿을 관리합니다.",
    group: "MCP 및 에이전트",
    keywords: ["app", "template", "업무 앱", "템플릿"],
    appPath: "/app/agents/apps",
    legacyPath: "/admin#/apps",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "agents.skills",
    title: "Skill",
    description: "Skill 카탈로그, 스튜디오와 의존성 그래프를 관리합니다.",
    group: "MCP 및 에이전트",
    keywords: ["skill", "studio", "graph", "스킬"],
    appPath: "/app/agents/skills",
    legacyPath: "/admin#/skills",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "text2sql.overview",
    title: "Text2SQL과 데이터",
    description: "스키마, 권한, 위험 대기열과 DW 상태를 확인합니다.",
    group: "Text2SQL 및 데이터",
    keywords: ["text2sql", "schema", "data", "dw", "스키마"],
    appPath: "/app/text2sql",
    legacyPath: "/admin#/text2sql",
    status: "preview",
    riskLevel: "high",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "data.warehouse",
    title: "DW 대시보드",
    description: "데이터 웨어하우스 지표와 ClickHouse 상태를 확인합니다.",
    group: "Text2SQL 및 데이터",
    keywords: ["dw", "clickhouse", "warehouse", "웨어하우스"],
    appPath: "/app/data/warehouse",
    legacyPath: "/admin#/dwdashboard",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "data.products",
    title: "데이터 상품",
    description: "게시된 데이터 상품과 접근 요청을 관리합니다.",
    group: "Text2SQL 및 데이터",
    keywords: ["data product", "access", "데이터 상품"],
    appPath: "/app/data/products",
    legacyPath: "/admin#/data-products",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "finops.overview",
    title: "비용 관리",
    description: "비용, 예산과 사용량을 확인합니다.",
    group: "비용 및 보안",
    keywords: ["cost", "budget", "finops", "비용"],
    appPath: "/app/finops",
    legacyPath: "/admin#/billing",
    status: "preview",
    riskLevel: "medium",
    requiredPermission: "costs:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "security.overview",
    title: "보안",
    description: "보안 위험, 비밀정보와 인증 이벤트를 확인합니다.",
    group: "비용 및 보안",
    keywords: ["security", "secret", "audit", "보안"],
    appPath: "/app/security",
    legacyPath: "/admin#/security",
    status: "preview",
    riskLevel: "high",
    requiredPermission: "security:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "security.redteam",
    title: "Red Team",
    description: "Red Team 캠페인, 프로브 팩과 조치를 운영합니다.",
    group: "비용 및 보안",
    keywords: ["redteam", "probe", "campaign", "레드팀"],
    appPath: "/app/redteam",
    legacyPath: "/admin#/redteam",
    status: "preview",
    riskLevel: "high",
    requiredPermission: "security:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "security.sandbox",
    title: "민감 샌드박스",
    description: "민감 데이터 샌드박스 정책과 격리 상태를 관리합니다.",
    group: "비용 및 보안",
    keywords: ["sandbox", "sensitive", "샌드박스"],
    appPath: "/app/sandbox",
    legacyPath: "/admin#/sandbox",
    status: "preview",
    riskLevel: "high",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
  },
  {
    featureId: "system.health",
    title: "시스템 상태",
    description: "로그, 저장소, 보안 설정과 운영 위험 신호를 조회합니다.",
    group: "시스템",
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
    title: "시스템 설정",
    description: "게이트웨이 설정과 UI 전환 상태를 관리합니다.",
    group: "시스템",
    keywords: ["settings", "system", "migration", "설정", "시스템"],
    appPath: "/app/system/settings",
    legacyPath: "/admin#/settings",
    status: "preview",
    riskLevel: "high",
    requiredPermission: "admin:read",
    readOnly: false,
    enabledRoles: [],
    rolloutPercent: 100,
    fallbackEnabled: true,
    minimumApiVersion: "v0.84.0",
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

// This set is a build-time capability boundary. Runtime migration settings may
// expose an implemented feature, but must never promote a route whose React
// screen is not present in this UI build. Screens register themselves through
// their domain's `routes.ts`; `overrideImplementedFeatureIds` exists for tests.
let appImplementedFeatureIds: ReadonlySet<string> | undefined;

export function overrideImplementedFeatureIds(ids: ReadonlySet<string> | undefined): void {
  appImplementedFeatureIds = ids;
}

export function isAppFeatureImplemented(featureId: string): boolean {
  return (appImplementedFeatureIds ?? implementedFeatureIds).has(featureId);
}

interface ParsedReleaseVersion {
  core: readonly [bigint, bigint, bigint];
  prerelease: readonly string[];
}

const releaseVersionPattern =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const numericIdentifierPattern = /^\d+$/u;

function parseReleaseVersion(version: string): ParsedReleaseVersion | undefined {
  const match = releaseVersionPattern.exec(version);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) =>
        numericIdentifierPattern.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
    )
  ) {
    return undefined;
  }
  return {
    core: [BigInt(match[1] as string), BigInt(match[2] as string), BigInt(match[3] as string)],
    prerelease,
  };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (!left.length || !right.length) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = numericIdentifierPattern.test(a);
    const bNumeric = numericIdentifierPattern.test(b);
    if (aNumeric && bNumeric) return BigInt(a) > BigInt(b) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

function compareReleaseVersions(left: string, right: string): number | undefined {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) return undefined;
  for (const index of [0, 1, 2] as const) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function versionAtLeast(current: string, minimum: string): boolean {
  const comparison = compareReleaseVersions(current, minimum);
  return comparison !== undefined && comparison >= 0;
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
    if (!feature.serverAvailable) {
      effective = {
        feature,
        status: feature.status,
        readOnly: feature.readOnly || feature.status === "preview_read_only",
        permitted: false,
        reason: feature.availabilityReason,
      };
    } else if (!versionAtLeast(backendVersion, feature.minimumApiVersion)) {
      // A rolling deployment may pair this UI build with an older backend
      // whose registry still marks the feature available. The UI's static
      // contract remains the lower bound for opening the React screen.
      effective = { feature, status: "legacy", readOnly: true, permitted: true, reason: "api_version" };
    } else {
      effective = {
        feature,
        status: feature.status,
        readOnly: feature.readOnly || feature.status === "preview_read_only",
        permitted: true,
        reason: feature.availabilityReason,
      };
    }
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
    overview: "개요",
    gateway: "AI 게이트웨이",
    routing: "라우팅",
    observability: "관측",
    governance: "거버넌스",
    mcp: "MCP 및 에이전트",
    text2sql: "Text2SQL 및 데이터",
    finops: "비용 및 보안",
    security: "비용 및 보안",
    system: "시스템",
  };
  return groups[prefix] ?? "시스템";
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
      minimumApiVersion:
        fallback && !versionAtLeast(feature.minimum_api_version, fallback.minimumApiVersion)
          ? fallback.minimumApiVersion
          : feature.minimum_api_version,
      serverAvailable: feature.available,
      availabilityReason: feature.availability_reason,
    };
  });
}
