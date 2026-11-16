import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { downloadText } from "@/shared/utils/csv";
import { useText2SqlMutation } from "./use-text2sql-mutation";
import { text2sqlInvalidations, text2sqlRouteId } from "./use-text2sql-queries";
import { readRegistryFile, registryActionError } from "./text2sql-registry-file";

export function useText2SqlRegistryTransfer({
  canWrite,
  onMessage,
}: {
  canWrite: boolean;
  onMessage: (message: { tone: "success" | "danger"; text: string }) => void;
}) {
  const importBundle = useText2SqlMutation({
    authorized: canWrite,
    mutate: async (file: File, assertCurrent) => {
      const bundle = await readRegistryFile(file);
      // Reading a local file can outlive a team/permission change.
      assertCurrent();
      return apiClient.request(endpoints.domains.text2sql.registry.import, {
        body: { tables: bundle.tables, columns: bundle.columns },
        routeId: text2sqlRouteId,
      });
    },
    invalidates: text2sqlInvalidations.registry,
    errorFormatter: registryActionError,
    onSuccess: (result) =>
      onMessage({
        tone: result.table_errors + result.column_errors > 0 ? "danger" : "success",
        text: `가져오기 완료 — 테이블 ${result.tables_imported}개, 컬럼 ${result.columns_imported}개 (오류 ${result.table_errors + result.column_errors}건)`,
      }),
  });
  const exportBundle = useText2SqlMutation({
    readOnly: true,
    mutate: (schema: string) =>
      apiClient.request(endpoints.domains.text2sql.registry.export, {
        query: schema ? { schema } : {},
        routeId: text2sqlRouteId,
      }),
    errorMessage: "내보내기에 실패했습니다.",
    onSuccess: (bundle) => {
      // Only the initiating view can download. No resource name in the filename.
      downloadText("text2sql-registry.json", JSON.stringify(bundle, null, 2), "application/json");
      onMessage({
        tone: "success",
        text: `내보내기 완료 (테이블 ${bundle.tables.length}개, 컬럼 ${bundle.columns.length}개)`,
      });
    },
  });
  return { importBundle, exportBundle };
}
