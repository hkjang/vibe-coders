import { Link, useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import type { AuthTeamRow } from "@/shared/api/domains/access.schemas";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { validRegisteredTeamId } from "./registered-team-detail-model";

export function RegisteredTeamLink({
  row,
  onOpen,
}: {
  row: AuthTeamRow;
  onOpen: (trigger: HTMLElement) => boolean;
}) {
  const { credentialPrefixes } = useAuth();
  const { search } = useLocation();
  const title = containsPotentialSecret(row.name, credentialPrefixes)
    ? "보호된 팀 이름"
    : row.name || "이름 없는 팀";
  if (!validRegisteredTeamId(row.id, credentialPrefixes))
    return <span title="이 ID는 상세 주소로 열 수 없습니다. 등록 목록에서 정보를 확인하세요.">{title}</span>;
  const params = new URLSearchParams(search);
  params.set("tab", "teams");
  params.set("registered_team", row.id);
  return (
    <Link
      className="access-text-link"
      to={{ search: `?${params}` }}
      onClick={(event) => {
        if (!onOpen(event.currentTarget)) event.preventDefault();
      }}
      aria-label={`${title} 등록 정보 보기`}
    >
      {title}
    </Link>
  );
}
