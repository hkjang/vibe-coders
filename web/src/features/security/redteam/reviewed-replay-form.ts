import { z } from "zod";
import { executionFormSchema } from "./reviewed-execution-form";
import { reviewedModelsSchema } from "@/shared/api/domains/redteam-reviewed";

export const replayFormSchema = executionFormSchema
  .pick({ reason: true, max_output_tokens: true, budget_limit_krw: true })
  .extend({
    model: z
      .string()
      .trim()
      .min(1, "정확한 모델 이름을 입력하세요.")
      .refine(
        (value) => reviewedModelsSchema.safeParse([value]).success,
        "와일드카드 없이 정확한 모델 이름을 입력하세요.",
      ),
    retain_raw_evidence: z.boolean(),
  });
export type ReplayFormInput = z.input<typeof replayFormSchema>;
export type ReplayForm = z.output<typeof replayFormSchema>;
