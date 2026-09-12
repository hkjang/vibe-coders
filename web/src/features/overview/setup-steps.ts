import type { AdminStats, OpsStatus } from "@/shared/api/schemas";

export interface SetupStep {
  id: string;
  title: string;
  /** Why it matters, in one line an operator can act on. */
  why: string;
  done: boolean;
  to: string;
  action: string;
}

/**
 * What a gateway still needs before its first request means anything. Every step is read
 * from data the overview already loads, so a step is ticked because the gateway says so,
 * not because someone clicked "done".
 */
export function setupSteps(stats: AdminStats | undefined, status: OpsStatus | undefined): SetupStep[] {
  const providerCount = status?.providers.length ?? 0;
  return [
    {
      id: "providers",
      title: "AI 공급자 연결",
      why: "업스트림 자격 증명을 등록해야 요청을 중계할 수 있습니다.",
      done: providerCount > 0,
      to: "/gateway/providers",
      action: "공급자 등록",
    },
    {
      id: "auth",
      title: "인증 켜기",
      why: "인증이 꺼져 있으면 게이트웨이에 닿는 누구나 모델을 호출할 수 있습니다.",
      done: status?.security.auth_enabled ?? false,
      to: "/system/settings",
      action: "인증 설정",
    },
    {
      id: "pricing",
      title: "모델 가격 설정",
      why: "가격이 없으면 비용·예산·절감 화면이 모두 0으로 남습니다.",
      done: status?.security.pricing_configured ?? false,
      to: "/gateway/models",
      action: "가격 입력",
    },
    {
      id: "traffic",
      title: "첫 요청 보내기",
      why: "요청이 하나라도 들어오면 이 화면의 지표와 추적이 채워집니다.",
      done: (stats?.total_requests ?? 0) > 0,
      to: "/gateway/chat",
      action: "Chat 테스트 열기",
    },
  ];
}
