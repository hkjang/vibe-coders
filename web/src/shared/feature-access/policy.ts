export interface FeatureAccess {
  featureId: string;
  permitted: boolean;
  readOnly: boolean;
}

export const skillMutationOwners = ["agents.skills"] as const;
export const requestMutationOwners = ["observability.llm", "observability.xview"] as const;
export const featureReadonlyReason =
  "이 화면은 읽기 전용입니다. 변경 저장과 실제 외부 실행을 할 수 없습니다.";

/** This UI policy supplements existing authorization; it never grants API access. */
export function featureMutationReason(
  access: FeatureAccess | undefined,
  owners: readonly string[],
): string | undefined {
  if (
    !access ||
    access.permitted !== true ||
    typeof access.readOnly !== "boolean" ||
    !owners.includes(access.featureId)
  )
    return "이 작업을 소유한 화면의 접근 설정을 확인할 수 없습니다.";
  if (access.readOnly) return featureReadonlyReason;
  return undefined;
}
