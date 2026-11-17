import { z } from "zod";
import { reviewedModelsSchema } from "@/shared/api/domains/redteam-reviewed";
const number = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "한도를 입력하세요.")
    .transform(Number)
    .pipe(z.number().finite().positive("0보다 큰 한도를 입력하세요.").max(max, "허용 범위를 넘었습니다."));
export const executionFormSchema = z.object({
  kind: z.enum(["simulation", "live"]),
  reason: z.string().trim().min(1, "실행 사유를 입력하세요.").max(1000, "사유는 1,000자 이내로 입력하세요."),
  models: z
    .string()
    .transform((value) =>
      value
        .split(/\r?\n/u)
        .map((model) => model.trim())
        .filter(Boolean),
    )
    .pipe(reviewedModelsSchema),
  max_calls: number(200).pipe(z.number().int("호출 수는 정수로 입력하세요.")),
  max_output_tokens: number(4096).pipe(z.number().int("토큰 수는 정수로 입력하세요.")),
  budget_limit_krw: number(1_000_000),
});
export type ExecutionFormInput = z.input<typeof executionFormSchema>;
export type ExecutionForm = z.output<typeof executionFormSchema>;
