import { apiClient } from "@/shared/api/client";
import { fileEndpoints } from "@/shared/api/file-endpoints";

/** Exact backup bytes: no JSON parse/stringify and no automatic authorization retry. */
export async function readPolicyExport(options: {
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<ArrayBuffer> {
  const file = await apiClient.file(fileEndpoints.policyBackup, {
    ...options,
    routeId: "governance.policies",
    retryUnauthorized: false,
  });
  file.assertCurrent();
  return file.bytes;
}
