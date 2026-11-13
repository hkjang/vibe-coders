import { Link, useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import type { WorkflowMetadata } from "@/shared/api/domains/workflow-page.schemas";
import { validWorkflowDetailId } from "./workflow-page-model";

export function WorkflowDetailLink({
  row,
  onOpen,
}: {
  row: WorkflowMetadata;
  onOpen?: (trigger: HTMLElement) => boolean;
}) {
  const { credentialPrefixes } = useAuth();
  const { search } = useLocation();
  if (!validWorkflowDetailId(row.id, credentialPrefixes))
    return <span title="이 ID는 상세 주소로 열 수 없습니다.">{row.name || row.id}</span>;
  const params = new URLSearchParams(search);
  params.set("workflow", row.id);
  return (
    <Link
      className="agents-detail-link"
      to={{ search: `?${params}` }}
      onClick={(event) => {
        if (onOpen && !onOpen(event.currentTarget)) event.preventDefault();
      }}
      aria-label={`${row.name || row.id} 정의 보기`}
    >
      {row.name || row.id}
    </Link>
  );
}
