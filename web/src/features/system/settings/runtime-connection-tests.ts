import { endpoints } from "@/shared/api/endpoints";
const system = endpoints.domains.system;
export type ConnectionTestKind = "clickhouse" | "text2sql-exec" | "text2sql-twin";

export const connectionTests: ReadonlyArray<{ kind: ConnectionTestKind; label: string }> = [
  { kind: "clickhouse", label: "ClickHouse 연결 테스트" },
  { kind: "text2sql-exec", label: "Text2SQL 실행 DB 테스트" },
  { kind: "text2sql-twin", label: "Text2SQL 트윈 DB 테스트" },
];

export function testEndpoint(kind: ConnectionTestKind) {
  if (kind === "clickhouse") return system.settings.testClickhouse;
  if (kind === "text2sql-exec") return system.settings.testText2sqlExec;
  return system.settings.testText2sqlTwin;
}
