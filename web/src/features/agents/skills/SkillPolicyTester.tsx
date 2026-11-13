import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSkillReadAction } from "./skill-scope";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

/** Dry-runs a skill's allowed_models/tools/teams policy without calling any provider. */
export function SkillPolicyTester({ skillName }: { skillName: string }): React.JSX.Element {
  const fieldId = useId();
  const [model, setModel] = useState("");
  const [tools, setTools] = useState("");
  const [team, setTeam] = useState("");
  const readAction = useSkillReadAction();
  const body = {
    name: skillName,
    model: model.trim(),
    tools: tools
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
    team: team.trim(),
  };

  const evaluate = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: (input: typeof body) =>
      readAction((signal) =>
        apiClient.request(endpoints.domains.agents.skills.evaluate, {
          body: input,
          signal,
          retryUnauthorized: false,
          routeId: "agents.skills",
        }),
      ),
  });
  const current = JSON.stringify(evaluate.variables) === JSON.stringify(body);
  const result = current ? evaluate.data : undefined;

  return (
    <SectionCard
      title="정책 시뮬레이션"
      headingLevel={3}
      description="모델·도구·팀 조합이 이 스킬의 정책을 통과하는지 실제 호출 없이 확인합니다."
    >
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          evaluate.mutate(body);
        }}
      >
        <div className="form-field">
          <label htmlFor={`${fieldId}-model`}>모델</label>
          <Input
            id={`${fieldId}-model`}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="gpt-4o-mini"
          />
        </div>
        <div className="form-field">
          <label htmlFor={`${fieldId}-tools`}>도구</label>
          <Input
            id={`${fieldId}-tools`}
            value={tools}
            onChange={(event) => setTools(event.target.value)}
            placeholder="쉼표로 구분"
          />
        </div>
        <div className="form-field">
          <label htmlFor={`${fieldId}-team`}>팀</label>
          <Input
            id={`${fieldId}-team`}
            value={team}
            onChange={(event) => setTeam(event.target.value)}
            placeholder="platform"
          />
        </div>
        <Button type="submit" variant="primary" size="small" disabled={evaluate.isPending}>
          {evaluate.isPending ? "확인 중" : "정책 확인"}
        </Button>
      </form>

      {current && evaluate.isError ? (
        <InlineNotice tone="danger" title="정책을 확인하지 못했습니다.">
          {safeAppErrorMessage(evaluate.error, "정책을 확인하지 못했습니다.")}
        </InlineNotice>
      ) : null}
      {result ? (
        <>
          <KeyValueList
            columns={3}
            items={[
              {
                label: "판정",
                value: (
                  <Badge tone={result.allowed ? "success" : "danger"}>
                    {result.allowed ? "허용" : "차단"}
                  </Badge>
                ),
              },
              { label: "적용 모드", value: result.enforcement },
              { label: "차단 여부", value: result.would_block ? "차단됨" : "경고만" },
            ]}
          />
          {(result.violations ?? []).length > 0 ? (
            <ul className="agents-checklist" aria-label="정책 위반 목록">
              {(result.violations ?? []).map((violation) => (
                <li key={violation} data-ok="false">
                  <span className="agents-checklist-copy">{violation}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </SectionCard>
  );
}
