package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

var ErrRedTeamProbeImportPack = errors.New("probe import pack save failed")
var ErrRedTeamProbeImportCase = errors.New("probe import case save failed")

// RedTeamProbeImport retains source row ordering: pack rows are unique and case
// rows may repeat an ID. The resulting receipt counts imported rows, not IDs.
type RedTeamProbeImport struct {
	Packs []RedTeamProbePackImport
	Cases []RedTeamProbeCase
}

type RedTeamProbePackImport struct {
	Pack             RedTeamProbePack
	PreserveApproval bool
}

// ImportRedTeamProbeContent acknowledges the whole file and its single audit
// together. Pre-commit failures roll back the local transaction. A failed
// commit acknowledgment or unreceived HTTP outcome must still be treated as unknown.
func (s *SQLStore) ImportRedTeamProbeContent(ctx context.Context, plan RedTeamProbeImport, audit AdminAuditLog) error {
	if audit.ID == "" || audit.AdminID == "" || audit.Action != "redteam.probe.import" {
		return errors.New("invalid probe import audit")
	}
	if err := validateRedTeamProbeImport(plan); err != nil {
		return err
	}

	return s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error { return s.writeRedTeamProbeImport(ctx, tx, plan) })
}

func (s *SQLStore) writeRedTeamProbeImport(ctx context.Context, tx *sql.Tx, plan RedTeamProbeImport) error {
	for _, item := range plan.Packs {
		if err := s.upsertRedTeamProbePackContent(ctx, tx, item.Pack, item.PreserveApproval); err != nil {
			return fmt.Errorf("%w: %v", ErrRedTeamProbeImportPack, err)
		}
	}
	for _, c := range plan.Cases {
		if err := s.upsertRedTeamProbeCaseContent(ctx, tx, c); err != nil {
			return fmt.Errorf("%w: %v", ErrRedTeamProbeImportCase, err)
		}
	}
	return nil
}

func validateRedTeamProbeImport(plan RedTeamProbeImport) error {
	packs := map[string]bool{}
	for _, item := range plan.Packs {
		if item.Pack.ID == "" || packs[item.Pack.ID] {
			return errors.New("invalid probe import pack identity")
		}
		packs[item.Pack.ID] = true
	}
	for _, c := range plan.Cases {
		if c.ID == "" || c.PackID == "" || !packs[c.PackID] {
			return errors.New("invalid probe import case identity")
		}
	}
	return nil
}
