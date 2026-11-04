import type { QueryClient } from "@tanstack/react-query";
import { AppError } from "@/shared/api/error";

// Persist only a non-secret principal key while a request is in flight. A read
// boundary may unmount a dialog but cannot make the dispatched write disappear.
const pending = new WeakMap<QueryClient, Set<string>>();
export async function modelWriteFlight<T>(
  client: QueryClient,
  principal: string,
  operation: () => Promise<T>,
): Promise<T> {
  let entries = pending.get(client);
  if (!entries) {
    entries = new Set();
    pending.set(client, entries);
  }
  if (entries.has(principal))
    throw new AppError("모델 변경을 처리 중입니다. 완료 후 다시 확인하세요.", {
      kind: "aborted",
      code: "model_write_in_progress",
    });
  entries.add(principal);
  try {
    return await operation();
  } finally {
    entries.delete(principal);
  }
}
