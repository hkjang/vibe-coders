import { z } from "zod";

export { confirmedCostGuard } from "@/shared/utils/cost-guard";

export const costGuardFormSchema = z.object({
  enabled: z.boolean(),
  thresholdKrw: z
    .string()
    .trim()
    .min(1, "요청당 임계값을 입력하세요. 빈 값은 0이 아닙니다.")
    .refine(
      (value) => Number.isFinite(Number(value)) && Number(value) >= 0,
      "유한한 0 이상의 금액을 입력하세요.",
    )
    .transform(Number),
});
export type CostGuardInput = z.input<typeof costGuardFormSchema>;
export type CostGuardValues = z.output<typeof costGuardFormSchema>;

export const costGuardDescription =
  "대체 가격을 포함해 비용을 추정할 수 있는 대화 요청의 호출 전 예상 비용을 요청당 임계값과 비교합니다. 전체 지출이나 누적 예산을 제한하는 기능이 아닙니다.";
export const costGuardException =
  "X-Cost-Approve: 1 헤더가 있는 요청은 이 예상 비용 검사에서 예외 처리됩니다. 다른 예산·권한·정책 검사를 우회한다는 뜻은 아닙니다.";
