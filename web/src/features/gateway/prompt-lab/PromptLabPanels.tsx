import { ExperimentTable } from "./ExperimentTable";
import { FlaskConical, Play, Plus, Trash2 } from "lucide-react";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { LabReadError } from "./LabReadError";
import { formatDateTime } from "@/shared/utils/format";
import type { PromptLabController } from "./use-prompt-lab-controller";
import { tabs } from "./prompt-lab-form";
import { TestCaseRunResult } from "./TestCaseRunResult";
export function PromptLabPanels({ lab }: { lab: PromptLabController }) {
  const {
    canWrite,
    writeDeniedReason,
    tab,
    setTab,
    selectedExperiment,
    updateParams,
    experiments,
    contracts,
    rubrics,
    detail,
    setExperimentOpen,
    setContractOpen,
    setRubricOpen,
    setTestCaseOpen,
    setRemoveCase,
    setRunCase,
    lastRun,
    returnFocusRef,
    newExperimentRef,
    newContractRef,
    newRubricRef,
    newTestCaseRef,
    experimentForm,
    contractForm,
    rubricForm,
    testCaseForm,
    openDialog,
  } = lab;
  return (
    <>
      <Tabs
        ariaLabel="프롬프트 실험실 화면"
        items={tabs}
        onChange={setTab}
        panelIdPrefix="prompt-lab"
        value={tab}
      />

      <TabPanel id={tab} panelIdPrefix="prompt-lab">
        {tab === "experiments" ? (
          <div className="page-stack">
            <SectionCard
              title="실험"
              description="같은 목적을 가진 테스트 케이스를 묶는 단위입니다."
              actions={
                <Button
                  ref={newExperimentRef}
                  size="small"
                  variant="primary"
                  disabled={!canWrite}
                  title={canWrite ? undefined : writeDeniedReason}
                  onClick={() => {
                    experimentForm.reset({ title: "", description: "", team: "" });
                    openDialog(newExperimentRef, setExperimentOpen);
                  }}
                >
                  <Plus aria-hidden="true" /> 실험 만들기
                </Button>
              }
            >
              {!canWrite ? (
                <InlineNotice tone="warning" title="쓰기 권한이 없습니다.">
                  {writeDeniedReason}
                </InlineNotice>
              ) : null}
              {experiments.isPending ? (
                <LoadingState label="실험 목록을 불러오는 중입니다." />
              ) : experiments.isError ? (
                <LabReadError
                  title="실험 목록을 불러오지 못했습니다."
                  error={experiments.error}
                  retry={() => void experiments.refetch()}
                />
              ) : experiments.data.experiments.length === 0 ? (
                <EmptyState
                  icon={<FlaskConical aria-hidden="true" />}
                  title="등록된 실험이 없습니다."
                  description="실험을 만들면 테스트 케이스를 저장하고 모델별 회귀 비교를 반복할 수 있습니다."
                />
              ) : (
                <ExperimentTable lab={lab} />
              )}
            </SectionCard>

            {selectedExperiment !== "" ? (
              <SectionCard
                title="테스트 케이스"
                description={
                  detail.data?.experiment?.title
                    ? `실험: ${detail.data.experiment.title}`
                    : "선택한 실험의 저장된 프롬프트입니다."
                }
                actions={
                  <div className="gateway-row-actions">
                    <Button
                      ref={newTestCaseRef}
                      size="small"
                      variant="primary"
                      disabled={!canWrite}
                      title={canWrite ? undefined : writeDeniedReason}
                      onClick={() => {
                        testCaseForm.reset({
                          name: "",
                          models: "",
                          contract_id: "",
                          rubric_id: "",
                          system: "",
                          user: "",
                        });
                        openDialog(newTestCaseRef, setTestCaseOpen);
                      }}
                    >
                      <Plus aria-hidden="true" /> 테스트 케이스 추가
                    </Button>
                    <Button size="small" variant="ghost" onClick={() => updateParams({ exp: undefined })}>
                      닫기
                    </Button>
                  </div>
                }
              >
                <InlineNotice tone="info" title="실행은 실제 호출입니다.">
                  실행하면 저장된 모델로 실제 요청이 나가며 비용이 발생합니다. 이 화면은 점수와 계약 검증
                  결과를 보여줍니다. 기존 서버는 모델 응답 일부를 실행 기록에 저장할 수 있습니다.
                </InlineNotice>
                {lastRun ? <TestCaseRunResult name={lastRun.name} result={lastRun.result} /> : null}
                {detail.isPending ? (
                  <LoadingState label="테스트 케이스를 불러오는 중입니다." />
                ) : detail.isError ? (
                  <LabReadError
                    title="테스트 케이스를 불러오지 못했습니다."
                    error={detail.error}
                    retry={() => void detail.refetch()}
                  />
                ) : detail.data.test_cases.length === 0 ? (
                  <EmptyState
                    title="테스트 케이스가 없습니다."
                    description="자주 쓰는 프롬프트를 저장하면 모델을 바꿀 때마다 같은 조건으로 비교할 수 있습니다."
                  />
                ) : (
                  <div className="data-table-scroll" tabIndex={0} aria-label="테스트 케이스 표 영역">
                    <table className="data-table">
                      <caption className="sr-only">선택한 실험의 테스트 케이스</caption>
                      <thead>
                        <tr>
                          <th scope="col">이름</th>
                          <th scope="col">모델</th>
                          <th scope="col">출력 계약</th>
                          <th scope="col">생성 시각</th>
                          <th scope="col">작업</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.data.test_cases.map((testCase) => (
                          <tr key={testCase.id}>
                            <td>{testCase.name}</td>
                            <td className="truncate">{testCase.models_json || "-"}</td>
                            <td>{testCase.contract_id || "-"}</td>
                            <td>{formatDateTime(testCase.created_at)}</td>
                            <td>
                              <div className="gateway-row-actions">
                                <Button
                                  size="small"
                                  variant="ghost"
                                  aria-label={`${testCase.name} 실행 이력`}
                                  onClick={(event) => {
                                    returnFocusRef.current = event.currentTarget;
                                    lab.setHistoryCase(testCase);
                                  }}
                                >
                                  실행 이력
                                </Button>
                                <Button
                                  size="small"
                                  variant="secondary"
                                  disabled={!canWrite}
                                  title={canWrite ? undefined : writeDeniedReason}
                                  aria-label={`${testCase.name} 테스트 케이스 실행`}
                                  onClick={(event) => {
                                    returnFocusRef.current = event.currentTarget;
                                    setRunCase(structuredClone(testCase));
                                  }}
                                >
                                  <Play aria-hidden="true" /> 실행
                                </Button>
                                <Button
                                  size="small"
                                  variant="ghost"
                                  disabled={!canWrite}
                                  title={canWrite ? undefined : writeDeniedReason}
                                  aria-label={`${testCase.name} 테스트 케이스 삭제`}
                                  onClick={(event) => {
                                    returnFocusRef.current = event.currentTarget;
                                    setRemoveCase(structuredClone(testCase));
                                  }}
                                >
                                  <Trash2 aria-hidden="true" /> 삭제
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>
            ) : null}
          </div>
        ) : null}

        {tab === "contracts" ? (
          <SectionCard
            title="출력 계약"
            description="모델 응답이 만족해야 하는 형식을 정의합니다. 테스트 케이스가 이 계약으로 자동 검증됩니다."
            actions={
              <Button
                ref={newContractRef}
                size="small"
                variant="primary"
                disabled={!canWrite}
                title={canWrite ? undefined : writeDeniedReason}
                onClick={() => {
                  contractForm.reset({ name: "", type: "json", schema_json: "", strict: false });
                  openDialog(newContractRef, setContractOpen);
                }}
              >
                <Plus aria-hidden="true" /> 계약 추가
              </Button>
            }
          >
            {contracts.isPending ? (
              <LoadingState label="출력 계약을 불러오는 중입니다." />
            ) : contracts.isError ? (
              <LabReadError
                title="출력 계약을 불러오지 못했습니다."
                error={contracts.error}
                retry={() => void contracts.refetch()}
              />
            ) : contracts.data.contracts.length === 0 ? (
              <EmptyState
                title="등록된 출력 계약이 없습니다."
                description="JSON 스키마나 표 형식을 계약으로 등록하면 응답 형식 위반을 자동으로 잡아냅니다."
              />
            ) : (
              <div className="data-table-scroll" tabIndex={0} aria-label="출력 계약 표 영역">
                <table className="data-table">
                  <caption className="sr-only">등록된 출력 계약</caption>
                  <thead>
                    <tr>
                      <th scope="col">이름</th>
                      <th scope="col">유형</th>
                      <th scope="col">엄격 모드</th>
                      <th scope="col">생성 시각</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contracts.data.contracts.map((contract) => (
                      <tr key={contract.id}>
                        <td>{contract.name}</td>
                        <td>{contract.type || "-"}</td>
                        <td>{contract.strict ? "사용" : "미사용"}</td>
                        <td>{formatDateTime(contract.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        ) : null}

        {tab === "rubrics" ? (
          <SectionCard
            title="평가 기준"
            description="응답 품질을 채점할 기준을 JSON으로 저장합니다."
            actions={
              <Button
                ref={newRubricRef}
                size="small"
                variant="primary"
                disabled={!canWrite}
                title={canWrite ? undefined : writeDeniedReason}
                onClick={() => {
                  rubricForm.reset({ name: "", criteria_json: "" });
                  openDialog(newRubricRef, setRubricOpen);
                }}
              >
                <Plus aria-hidden="true" /> 평가 기준 추가
              </Button>
            }
          >
            {rubrics.isPending ? (
              <LoadingState label="평가 기준을 불러오는 중입니다." />
            ) : rubrics.isError ? (
              <LabReadError
                title="평가 기준을 불러오지 못했습니다."
                error={rubrics.error}
                retry={() => void rubrics.refetch()}
              />
            ) : rubrics.data.rubrics.length === 0 ? (
              <EmptyState
                title="등록된 평가 기준이 없습니다."
                description="정확성·완결성 같은 채점 기준을 저장하면 자동 평가에서 재사용할 수 있습니다."
              />
            ) : (
              <div className="data-table-scroll" tabIndex={0} aria-label="평가 기준 표 영역">
                <table className="data-table">
                  <caption className="sr-only">등록된 평가 기준</caption>
                  <thead>
                    <tr>
                      <th scope="col">이름</th>
                      <th scope="col">기준</th>
                      <th scope="col">생성 시각</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rubrics.data.rubrics.map((rubric) => (
                      <tr key={rubric.id}>
                        <td>{rubric.name}</td>
                        <td className="mono truncate">{rubric.criteria_json || "-"}</td>
                        <td>{formatDateTime(rubric.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        ) : null}
      </TabPanel>
    </>
  );
}
