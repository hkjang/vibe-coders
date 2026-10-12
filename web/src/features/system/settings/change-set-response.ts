import { z } from "zod";
import { AppError } from "@/shared/api/error";
import type { LifecycleAction } from "./change-set-model";

/** A 2xx alone is not proof that the requested lifecycle transition completed. */
export function assertChangeSetResponse(action: LifecycleAction, id: string, value: unknown): void {
  const status = {
    submit: "pending",
    approve: "approved",
    apply: "applied",
    rollback: "rolled_back",
    delete: "deleted",
  }[action];
  const schema =
    action === "delete"
      ? z.object({ status: z.literal(status) })
      : action === "apply" || action === "rollback"
        ? z.object({
            status: z.literal(status),
            change_set: z.object({ id: z.literal(id), status: z.literal(status) }),
          })
        : z.object({ id: z.literal(id), status: z.literal(status) });
  if (!schema.safeParse(value).success)
    throw new AppError("변경 완료 응답을 확인하지 못했습니다. 목록을 새로고침하고 실제 상태를 확인하세요.", {
      kind: "contract",
    });
}
