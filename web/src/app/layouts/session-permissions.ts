import { permissionScopeOptions } from "@/config/permission-scopes";

export const permissionLabels = {
  title: "내 권한 확인",
  description: "현재 로그인에 부여된 권한과 요청 원문 열람 상태를 확인합니다.",
  boundary:
    "아래 목록은 세션 권한 코드 기준입니다. 실제 조회·변경 가능 여부는 각 API에서 팀, 대상 리소스, 정책과 기능 전환 상태를 추가로 검사합니다.",
  refresh: "역할 설정 변경은 새 로그인이나 토큰 갱신 후 반영됩니다.",
  shared: "현재 연결에 적용된 공유 관리자 권한입니다.",
  unavailable: "현재 로그인 권한 정보를 받지 못했습니다. 다시 로그인해 확인하세요.",
  search: "권한 검색",
  filter: "부여 상태",
  all: "전체 권한",
  granted: "부여됨",
  missing: "미부여",
  empty: "검색 조건에 맞는 권한이 없습니다.",
  noGrants: "현재 로그인에 부여된 세션 권한 코드가 없습니다.",
  rawTitle: "요청 원문 열람",
  rawDescription: "서버가 반환한 원문 열람 상태입니다. 팀·요청별 접근 검사는 별도로 적용됩니다.",
} as const;

export type PermissionFilter = "all" | "granted" | "missing";

/** Display signed session grants; never infer grants from a role or menu entry. */
export function sessionPermissionRows(scopes: readonly string[], search: string, filter: PermissionFilter) {
  const granted = new Set(scopes);
  const known: ReadonlySet<string> = new Set(permissionScopeOptions.map((scope) => scope.value));
  const rows = [
    ...permissionScopeOptions.map((scope) => ({ ...scope, granted: granted.has(scope.value) })),
    ...[...granted]
      .filter((scope) => !known.has(scope))
      .sort()
      .map((scope) => ({
        value: scope,
        label: "기타 권한",
        description: "서버에서 부여한 권한입니다. 이 화면에 등록된 설명이 없습니다.",
        granted: true,
      })),
  ];
  const query = search.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      `${row.label} ${row.value} ${row.description}`.toLocaleLowerCase().includes(query) &&
      (filter === "all" || row.granted === (filter === "granted")),
  );
}
