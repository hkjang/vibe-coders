import { Link, useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { validReceiptId } from "./run-receipt";

export function RunReceiptLink({
  id,
  resource,
  onOpen,
}: {
  id: string;
  resource: "app" | "workflow";
  onOpen?: (element: HTMLElement) => void;
}) {
  const { search } = useLocation();
  const { credentialPrefixes } = useAuth();
  if (!validReceiptId(id, credentialPrefixes)) return <span>주소 확인 필요</span>;
  const params = new URLSearchParams(search);
  params.delete(resource);
  params.set("tab", "runs");
  params.set("run", id);
  return (
    <Link
      className="agents-detail-link"
      to={{ search: `?${params}` }}
      onClick={(event) => onOpen?.(event.currentTarget)}
      aria-label={`실행 ${id} 영수증 보기`}
    >
      영수증 보기
    </Link>
  );
}
