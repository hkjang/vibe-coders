import { isAppError } from "@/shared/api/error";

export function overviewReadDenied(error: unknown): boolean {
  return (
    isAppError(error) &&
    (error.kind === "auth" || error.kind === "permission" || error.status === 401 || error.status === 403)
  );
}
