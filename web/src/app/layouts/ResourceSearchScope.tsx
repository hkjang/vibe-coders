import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import type { ResourceKind } from "@/shared/api/resource-search";
import { resourceSearchTargets } from "./resource-search-items";

export type SearchScope = "all" | ResourceKind;

export function ResourceSearchScope({
  allowed,
  value,
  onChange,
}: {
  allowed: readonly ResourceKind[];
  value: SearchScope;
  onChange: (value: SearchScope) => void;
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (!allowed.length) return null;
  const label = value === "all" ? "전체 자원" : resourceSearchTargets[value].title;
  return (
    <div className="resource-search-scope">
      <button
        type="button"
        className="resource-search-scope-trigger"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded(!expanded)}
      >
        <span>
          검색 대상: <strong>{label}</strong>
        </span>
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      <fieldset id={id} hidden={!expanded} className="resource-search-scope-options">
        <legend className="sr-only">검색할 자원 종류</legend>
        {(["all", ...allowed] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={kind === value}
            onClick={() => {
              setExpanded(false);
              onChange(kind);
            }}
          >
            {kind === "all" ? "전체 자원" : resourceSearchTargets[kind].title}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
