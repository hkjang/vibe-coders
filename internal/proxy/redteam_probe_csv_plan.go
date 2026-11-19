package proxy

import (
	"encoding/csv"
	"fmt"
	"strings"

	"vibe-coders/internal/store"
)

type redTeamProbeCSVPlanError struct{ message, code string }

func (err *redTeamProbeCSVPlanError) Error() string { return err.message }

type redTeamProbeCSVPlan struct {
	Content store.RedTeamProbeImport
	Skipped []string
}

// Interpret the complete file without database access. The import and its future
// before/after review share this exact normalization, identity and row ordering.
// First usable row owns pack content; repeated case IDs retain last-write wins.
func prepareRedTeamProbeCSV(raw []byte, actor string) (redTeamProbeCSVPlan, error) {
	invalid := func(message, code string) (redTeamProbeCSVPlan, error) {
		return redTeamProbeCSVPlan{}, &redTeamProbeCSVPlanError{message: message, code: code}
	}
	body := strings.TrimPrefix(string(raw), "\uFEFF")
	cr := csv.NewReader(strings.NewReader(body))
	cr.FieldsPerRecord = -1
	records, err := cr.ReadAll()
	if err != nil {
		return invalid("invalid CSV: "+err.Error(), "invalid_csv")
	}
	if len(records) < 2 {
		return invalid("CSV has no data rows (need a header + at least one row)", "empty_csv")
	}
	table, err := redTeamProbeCSVRows(records)
	if err != nil {
		return invalid(err.Error(), "invalid_csv_format")
	}
	get := table.value
	packNameValue := func(value string) string {
		if table.versioned && strings.TrimSpace(value) != "" {
			return value
		}
		return redTeamDefault(value, "사용자 정의 프롬프트")
	}
	var plan redTeamProbeCSVPlan
	packsSeen := map[string]bool{}
	for n, row := range table.rows {
		caseKey, tmpl := get(row, "case_key"), get(row, "input_template")
		if caseKey == "" || strings.TrimSpace(tmpl) == "" {
			plan.Skipped = append(plan.Skipped, fmt.Sprintf("row %d: case_key/input_template 필수", n+2))
			continue
		}
		targetTypes, targetErr := redTeamProbeCSVReadList(get(row, "target_types"), table.versioned)
		riskTags, riskErr := redTeamProbeCSVReadList(get(row, "risk_tags"), table.versioned)
		if targetErr != nil || riskErr != nil {
			return invalid("invalid probe CSV list", "invalid_csv_format")
		}
		packName := packNameValue(get(row, "pack_name"))
		packID := get(row, "pack_id")
		if packID == "" {
			packID = redTeamCustomPackID(packName)
		}
		if !packsSeen[packID] {
			severity := normalizeRedTeamSeverity(get(row, "pack_severity"))
			approval := redTeamTruthy(get(row, "requires_approval")) || redTeamSeverityRank(severity) >= redTeamSeverityRank("high")
			index, present := table.columns["requires_approval"]
			plan.Content.Packs = append(plan.Content.Packs, store.RedTeamProbePackImport{
				Pack:             store.RedTeamProbePack{ID: packID, Name: packName, Category: redTeamDefault(get(row, "category"), "custom"), Severity: severity, Version: "v1", Enabled: true, RequiresApproval: approval, CreatedBy: actor},
				PreserveApproval: !present || index >= len(row),
			})
			packsSeen[packID] = true
		}
		caseID := get(row, "case_id")
		if caseID == "" {
			caseID = redTeamCaseID(packID, caseKey)
		}
		plan.Content.Cases = append(plan.Content.Cases, store.RedTeamProbeCase{
			ID: caseID, PackID: packID, CaseKey: caseKey, InputTemplate: tmpl,
			ExpectedPolicy: redTeamDefault(get(row, "expected_policy"), "safe_completion"), EvaluatorType: redTeamDefault(get(row, "evaluator_type"), "rule"),
			Severity: normalizeRedTeamSeverity(get(row, "severity")), TargetTypes: targetTypes, RiskTags: riskTags,
		})
	}
	return plan, nil
}
