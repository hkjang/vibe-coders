package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"strings"
	"unicode/utf8"
)

const RedTeamProbeReviewMaxRows = 10000
const RedTeamProbeReviewMaxSnapshotBytes int64 = 32 << 20

var ErrRedTeamProbeReviewConflict = errors.New("probe import review changed")
var ErrRedTeamProbeReviewLimit = errors.New("probe import review exceeds bounded snapshot")
var ErrRedTeamProbeReviewInvalid = errors.New("probe import review cannot represent stored content")

type RedTeamProbePackValue struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Category         string `json:"category"`
	Severity         string `json:"severity"`
	Version          string `json:"version"`
	Enabled          bool   `json:"enabled"`
	RequiresApproval bool   `json:"requires_approval"`
}
type RedTeamProbeCaseValue struct {
	ID             string   `json:"id"`
	PackID         string   `json:"pack_id"`
	CaseKey        string   `json:"case_key"`
	InputTemplate  string   `json:"input_template"`
	ExpectedPolicy string   `json:"expected_policy"`
	EvaluatorType  string   `json:"evaluator_type"`
	Severity       string   `json:"severity"`
	RiskTags       []string `json:"risk_tags"`
	TargetTypes    []string `json:"target_types"`
}
type RedTeamProbeImportChange struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Action string `json:"action"`
	Before any    `json:"before"`
	After  any    `json:"after"`
}
type RedTeamProbeImportReview struct {
	Revision string
	Changes  []RedTeamProbeImportChange
}
type probePackSnapshot struct {
	value   RedTeamProbePackValue
	updated string
}
type probeCaseSnapshot struct {
	value   RedTeamProbeCaseValue
	updated string
}

func probeReviewTextValid(values ...string) bool {
	for _, value := range values {
		if !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
			return false
		}
	}
	return true
}

func probeImportIDs(plan RedTeamProbeImport) ([]string, []string, map[string]RedTeamProbePackImport, map[string]RedTeamProbeCase) {
	packs := map[string]RedTeamProbePackImport{}
	cases := map[string]RedTeamProbeCase{}
	for _, p := range plan.Packs {
		packs[p.Pack.ID] = p
	}
	for _, c := range plan.Cases {
		cases[c.ID] = c
	}
	packIDs := make([]string, 0, len(packs))
	caseIDs := make([]string, 0, len(cases))
	for id := range packs {
		packIDs = append(packIDs, id)
	}
	for id := range cases {
		caseIDs = append(caseIDs, id)
	}
	sort.Strings(packIDs)
	sort.Strings(caseIDs)
	return packIDs, caseIDs, packs, cases
}

func probeIDChunks(ids []string, visit func(string, []any) error) error {
	for start := 0; start < len(ids); start += 500 {
		end := start + 500
		if end > len(ids) {
			end = len(ids)
		}
		args := make([]any, end-start)
		marks := make([]string, len(args))
		for i, id := range ids[start:end] {
			args[i] = id
			marks[i] = "?"
		}
		if err := visit(strings.Join(marks, ","), args); err != nil {
			return err
		}
	}
	return nil
}

// Check database byte lengths before fetching text. The same read snapshot (or
// write lock) then protects the bounded fetch from concurrent value growth.
func (s *SQLStore) probeReviewBudget(ctx context.Context, tx *sql.Tx, table string, fields, ids []string, remaining *int64) error {
	lengths := make([]string, len(fields))
	for i, field := range fields {
		lengths[i] = "COALESCE(length(CAST(" + field + " AS BLOB)),0)"
		if s.dialect == "postgres" {
			lengths[i] = "COALESCE(octet_length(CAST(" + field + " AS TEXT)),0)"
		}
	}
	return probeIDChunks(ids, func(marks string, args []any) error {
		rows, err := tx.QueryContext(ctx, s.bind("SELECT "+strings.Join(lengths, "+")+" FROM "+table+" WHERE id IN ("+marks+")"), args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var n int64
			if err := rows.Scan(&n); err != nil {
				return err
			}
			if n < 0 || n > *remaining {
				return ErrRedTeamProbeReviewLimit
			}
			*remaining -= n
		}
		return rows.Err()
	})
}

func (s *SQLStore) buildProbeImportReview(ctx context.Context, tx *sql.Tx, plan RedTeamProbeImport, fileSHA, identity string) (RedTeamProbeImportReview, error) {
	var out RedTeamProbeImportReview
	if err := validateRedTeamProbeImport(plan); err != nil {
		return out, ErrRedTeamProbeReviewInvalid
	}
	if len(plan.Cases) == 0 || len(fileSHA) != 64 || identity == "" {
		return out, ErrRedTeamProbeReviewInvalid
	}
	if len(plan.Cases) > RedTeamProbeReviewMaxRows || len(plan.Packs) > RedTeamProbeReviewMaxRows {
		return out, ErrRedTeamProbeReviewLimit
	}
	packIDs, caseIDs, packAfter, caseAfter := probeImportIDs(plan)
	packFields := []string{"id", "name", "category", "severity", "version", "enabled", "requires_approval", "updated_at"}
	caseFields := []string{"id", "pack_id", "case_key", "input_template", "expected_policy", "evaluator_type", "severity", "risk_tags", "target_types", "updated_at"}
	remaining := RedTeamProbeReviewMaxSnapshotBytes
	if err := s.probeReviewBudget(ctx, tx, "redteam_probe_packs", packFields, packIDs, &remaining); err != nil {
		return out, err
	}
	if err := s.probeReviewBudget(ctx, tx, "redteam_probe_cases", caseFields, caseIDs, &remaining); err != nil {
		return out, err
	}
	packs := map[string]probePackSnapshot{}
	cases := map[string]probeCaseSnapshot{}
	err := probeIDChunks(packIDs, func(marks string, args []any) error {
		rows, err := tx.QueryContext(ctx, s.bind("SELECT "+strings.Join(packFields, ",")+" FROM redteam_probe_packs WHERE id IN ("+marks+")"), args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var p RedTeamProbePackValue
			var enabled, approval int
			var updated string
			if err := rows.Scan(&p.ID, &p.Name, &p.Category, &p.Severity, &p.Version, &enabled, &approval, &updated); err != nil {
				return err
			}
			if !probeReviewTextValid(p.ID, p.Name, p.Category, p.Severity, p.Version, updated) {
				return ErrRedTeamProbeReviewInvalid
			}
			p.Enabled, p.RequiresApproval = enabled != 0, approval != 0
			packs[p.ID] = probePackSnapshot{p, updated}
		}
		return rows.Err()
	})
	if err != nil {
		return out, err
	}
	err = probeIDChunks(caseIDs, func(marks string, args []any) error {
		rows, err := tx.QueryContext(ctx, s.bind("SELECT "+strings.Join(caseFields, ",")+" FROM redteam_probe_cases WHERE id IN ("+marks+")"), args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c RedTeamProbeCaseValue
			var tags, targets, updated string
			if err := rows.Scan(&c.ID, &c.PackID, &c.CaseKey, &c.InputTemplate, &c.ExpectedPolicy, &c.EvaluatorType, &c.Severity, &tags, &targets, &updated); err != nil {
				return err
			}
			if !probeReviewTextValid(c.ID, c.PackID, c.CaseKey, c.InputTemplate, c.ExpectedPolicy, c.EvaluatorType, c.Severity, tags, targets, updated) {
				return ErrRedTeamProbeReviewInvalid
			}
			c.RiskTags, c.TargetTypes = decodeStringList(tags), decodeStringList(targets)
			cases[c.ID] = probeCaseSnapshot{c, updated}
		}
		return rows.Err()
	})
	if err != nil {
		return out, err
	}
	versions := make([]string, 0, len(packIDs)+len(caseIDs))
	for _, id := range packIDs {
		item := packAfter[id]
		p := item.Pack
		after := RedTeamProbePackValue{p.ID, p.Name, p.Category, p.Severity, p.Version, p.Enabled, p.RequiresApproval}
		change := RedTeamProbeImportChange{Kind: "pack", ID: id, Action: "create"}
		before, found := packs[id]
		if found {
			after.Version, after.Enabled = before.value.Version, before.value.Enabled
			if item.PreserveApproval {
				after.RequiresApproval = after.RequiresApproval || before.value.RequiresApproval
			}
			change.Before = before.value
			change.Action = "update"
			if reflect.DeepEqual(before.value, after) {
				change.Action = "unchanged"
			}
		}
		change.After = after
		out.Changes = append(out.Changes, change)
		versions = append(versions, before.updated)
	}
	for _, id := range caseIDs {
		c := caseAfter[id]
		tags, targets := append([]string{}, c.RiskTags...), append([]string{}, c.TargetTypes...)
		after := RedTeamProbeCaseValue{c.ID, c.PackID, c.CaseKey, c.InputTemplate, c.ExpectedPolicy, c.EvaluatorType, c.Severity, tags, targets}
		change := RedTeamProbeImportChange{Kind: "case", ID: id, Action: "create"}
		before, found := cases[id]
		if found {
			change.Before = before.value
			change.Action = "update"
			if reflect.DeepEqual(before.value, after) {
				change.Action = "unchanged"
			}
		}
		change.After = after
		out.Changes = append(out.Changes, change)
		versions = append(versions, before.updated)
	}
	hash := sha256.New()
	binding := struct {
		Format, FileSHA, Identity string
		Changes                   []RedTeamProbeImportChange
		Versions                  []string
	}{"probe-import-review-v1", fileSHA, identity, out.Changes, versions}
	if err := json.NewEncoder(hash).Encode(binding); err != nil {
		return RedTeamProbeImportReview{}, err
	}
	out.Revision = hex.EncodeToString(hash.Sum(nil))
	return out, nil
}

// A review is a consistent, bounded read and performs no catalogue seeding/write.
func (s *SQLStore) ReviewRedTeamProbeImport(ctx context.Context, plan RedTeamProbeImport, fileSHA, identity string) (RedTeamProbeImportReview, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable, ReadOnly: true})
	if err != nil {
		return RedTeamProbeImportReview{}, err
	}
	defer tx.Rollback()
	review, err := s.buildProbeImportReview(ctx, tx, plan, fileSHA, identity)
	if err != nil {
		return RedTeamProbeImportReview{}, err
	}
	if err := tx.Commit(); err != nil {
		return RedTeamProbeImportReview{}, err
	}
	return review, nil
}

// Ordinary INSERT/UPDATE/DELETE writers are serialized before revision checking,
// including writers in other processes and legacy POST import callers.
func (s *SQLStore) ImportRedTeamProbeContentReviewed(ctx context.Context, plan RedTeamProbeImport, fileSHA, identity, revision string, audit AdminAuditLog) error {
	if revision == "" || audit.ID == "" || audit.Action != "redteam.probe.import" || audit.AdminID == "" {
		return ErrRedTeamProbeReviewInvalid
	}
	return s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		lock := "UPDATE redteam_probe_packs SET enabled = enabled WHERE 0"
		if s.dialect == "postgres" {
			lock = "LOCK TABLE redteam_probe_packs, redteam_probe_cases IN SHARE ROW EXCLUSIVE MODE"
		}
		if _, err := tx.ExecContext(ctx, lock); err != nil {
			return err
		}
		current, err := s.buildProbeImportReview(ctx, tx, plan, fileSHA, identity)
		if err != nil {
			return err
		}
		if current.Revision != revision {
			return ErrRedTeamProbeReviewConflict
		}
		return s.writeRedTeamProbeImport(ctx, tx, plan)
	})
}
