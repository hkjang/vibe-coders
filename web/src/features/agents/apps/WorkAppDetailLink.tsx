import { Link, useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import type { WorkAppMetadata } from "@/shared/api/domains/work-app-page.schemas";
import { validWorkAppDetailId } from "./work-app-page-model";

export function WorkAppDetailLink({
  row,
  onOpen,
}: {
  row: WorkAppMetadata;
  onOpen?: (trigger: HTMLElement) => boolean;
}) {
  const { credentialPrefixes } = useAuth();
  const { search } = useLocation();
  if (!validWorkAppDetailId(row.id, credentialPrefixes))
    return <span title="이 ID는 상세 주소로 열 수 없습니다.">{row.title || row.id}</span>;
  const params = new URLSearchParams(search);
  params.set("app", row.id);
  return (
    <Link
      className="agents-detail-link"
      to={{ search: `?${params}` }}
      onClick={(event) => {
        if (onOpen && !onOpen(event.currentTarget)) event.preventDefault();
      }}
      aria-label={`${row.title || row.id} 상세 보기`}
    >
      {row.icon ? <span aria-hidden="true">{row.icon} </span> : null}
      {row.title || row.id}
    </Link>
  );
}
