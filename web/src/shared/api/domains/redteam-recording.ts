import { z } from "zod";

export const redTeamRecordingSchema = z
  .object({
    confirmed: z.boolean(),
    stage: z.enum(["", "run_start", "case_result", "finalize"]),
    results: z.number().int().nonnegative().max(1000),
  })
  .superRefine((value, ctx) => {
    if (value.confirmed !== (value.stage === ""))
      ctx.addIssue({ code: "custom", message: "저장 확인 상태와 실패 지점이 일치하지 않습니다." });
  });
