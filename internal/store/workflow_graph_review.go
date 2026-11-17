package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var ErrWorkflowGraphConflict = errors.New("workflow changed after review")

// The revision includes stored timestamps and the full definition. It is a
// comparison token, not an idempotency key or a published execution version.
func WorkflowRevision(wf Workflow) (string, error) {
	data, err := json.Marshal(wf)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}

// CommitWorkflowGraph saves a fully reviewed graph and its audit atomically.
// Blank expectedRevision means create-only. All regular workflow UPDATE,
// DELETE and publish writers also take database write locks, so the check and
// write cannot race with a legacy edit. No external work occurs under this lock.
func (s *SQLStore) CommitWorkflowGraph(ctx context.Context, wf Workflow, expectedRevision string, audit AdminAuditLog) (Workflow, error) {
	if wf.Flow == nil || !ValidWorkflowDetailID(wf.ID) || strings.TrimSpace(wf.Name) == "" || audit.Action != "workflow.graph_save" {
		return Workflow{}, ErrInvalidWorkflowGraph
	}
	if err := ValidateWorkflowGraph(wf); err != nil {
		return Workflow{}, err
	}
	if expectedRevision != "" {
		decoded, err := hex.DecodeString(expectedRevision)
		if err != nil || len(decoded) != sha256.Size {
			return Workflow{}, ErrInvalidWorkflowGraph
		}
	}
	steps, err := json.Marshal(wf.Steps)
	if err != nil {
		return Workflow{}, err
	}
	flow, err := encodeWorkflowFlow(wf.Flow)
	if err != nil {
		return Workflow{}, err
	}
	var saved Workflow
	err = s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		if err := s.lockWorkflowDefinitions(ctx, tx); err != nil {
			return err
		}

		current, readErr := scanWorkflow(tx.QueryRowContext(ctx, s.bind(`SELECT `+workflowColumns+` FROM workflows WHERE id = ?`), wf.ID))
		found := readErr == nil
		if readErr != nil && !errors.Is(readErr, sql.ErrNoRows) {
			return readErr
		}
		if found {
			revision, err := WorkflowRevision(current)
			if err != nil {
				return err
			}
			if expectedRevision == "" || revision != expectedRevision {
				return ErrWorkflowGraphConflict
			}
			wf.CreatedAt, wf.CreatedBy = current.CreatedAt, current.CreatedBy
		} else if expectedRevision != "" {
			return ErrWorkflowGraphConflict
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		if !found {
			wf.CreatedAt = now
		}
		wf.UpdatedAt = now
		enabled := 0
		if wf.Enabled {
			enabled = 1
		}
		if found {
			_, err = tx.ExecContext(ctx, s.bind(`UPDATE workflows SET name=?, description=?, steps=?, allowed_teams=?, enabled=?, updated_at=?, flow=? WHERE id=?`),
				wf.Name, wf.Description, string(steps), wf.AllowedTeams, enabled, now, flow, wf.ID)
		} else {
			_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO workflows (id,name,description,steps,allowed_teams,enabled,created_by,created_at,updated_at,flow) VALUES (?,?,?,?,?,?,?,?,?,?)`),
				wf.ID, wf.Name, wf.Description, string(steps), wf.AllowedTeams, enabled, wf.CreatedBy, wf.CreatedAt, now, flow)
		}
		if err != nil {
			return err
		}
		saved, err = scanWorkflow(tx.QueryRowContext(ctx, s.bind(`SELECT `+workflowColumns+` FROM workflows WHERE id=?`), wf.ID))
		if err != nil {
			return err
		}
		want, err := WorkflowRevision(wf)
		if err != nil {
			return err
		}
		got, err := WorkflowRevision(saved)
		if err != nil {
			return err
		}
		if got != want {
			return ErrWorkflowGraphConflict
		}
		return nil
	})
	if err != nil {
		return Workflow{}, err
	}
	return saved, nil
}

func (s *SQLStore) lockWorkflowDefinitions(ctx context.Context, tx *sql.Tx) error {
	if s.dialect == "postgres" {
		_, err := tx.ExecContext(ctx, `LOCK TABLE workflows IN SHARE ROW EXCLUSIVE MODE`)
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE workflows SET enabled = enabled WHERE 0`)
	return err
}

// PublishWorkflowVersionReviewed snapshots and enables exactly the definition
// that was validated. Version allocation, activation and audit are one short
// transaction; no model or tool calls occur under the database writer lock.
func (s *SQLStore) PublishWorkflowVersionReviewed(ctx context.Context, wf Workflow, revision, publishedBy, note string, audit AdminAuditLog) (int, error) {
	if audit.Action != "workflow.publish" {
		return 0, ErrInvalidWorkflowGraph
	}
	if err := ValidateWorkflowGraph(wf); err != nil {
		return 0, err
	}
	want, err := WorkflowRevision(wf)
	if err != nil {
		return 0, err
	}
	if revision == "" || revision != want {
		return 0, ErrWorkflowGraphConflict
	}
	steps, err := json.Marshal(wf.Steps)
	if err != nil {
		return 0, err
	}
	flow, err := encodeWorkflowFlow(wf.Flow)
	if err != nil {
		return 0, err
	}
	version := 0
	err = s.withPreparedAdminAuditTransaction(ctx, func(tx *sql.Tx) (AdminAuditLog, error) {
		fail := func(err error) (AdminAuditLog, error) { return audit, err }
		if err := s.lockWorkflowDefinitions(ctx, tx); err != nil {
			return fail(err)
		}
		current, err := scanWorkflow(tx.QueryRowContext(ctx, s.bind(`SELECT `+workflowColumns+` FROM workflows WHERE id=?`), wf.ID))
		if errors.Is(err, sql.ErrNoRows) {
			return fail(ErrWorkflowGraphConflict)
		}
		if err != nil {
			return fail(err)
		}
		got, err := WorkflowRevision(current)
		if err != nil {
			return fail(err)
		}
		if got != revision {
			return fail(ErrWorkflowGraphConflict)
		}
		if err := tx.QueryRowContext(ctx, s.bind(`SELECT COALESCE(MAX(version),0)+1 FROM workflow_versions WHERE workflow_id=?`), wf.ID).Scan(&version); err != nil {
			return fail(err)
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO workflow_versions (id,workflow_id,version,name,description,steps,allowed_teams,published_by,published_at,note,flow) VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
			"wfver_"+wf.ID+"_"+itoaStore(version), wf.ID, version, wf.Name, wf.Description, string(steps), wf.AllowedTeams, publishedBy, now, note, flow)
		if err != nil {
			return fail(err)
		}
		_, err = tx.ExecContext(ctx, s.bind(`UPDATE workflows SET enabled=1,updated_at=? WHERE id=?`), now, wf.ID)
		if err != nil {
			return fail(err)
		}
		saved, err := scanWorkflow(tx.QueryRowContext(ctx, s.bind(`SELECT `+workflowColumns+` FROM workflows WHERE id=?`), wf.ID))
		if err != nil {
			return fail(err)
		}
		current.Enabled, current.UpdatedAt = true, now
		expected, err := WorkflowRevision(current)
		if err != nil {
			return fail(err)
		}
		actual, err := WorkflowRevision(saved)
		if err != nil {
			return fail(err)
		}
		if actual != expected {
			return fail(ErrWorkflowGraphConflict)
		}
		before, _ := json.Marshal(map[string]any{"id": wf.ID, "revision": revision, "enabled": wf.Enabled})
		after, _ := json.Marshal(map[string]any{"id": wf.ID, "version": version, "enabled": true, "reason": note})
		audit.BeforeValue, audit.AfterValue = string(before), string(after)
		return audit, nil
	})
	if err != nil {
		return 0, err
	}
	return version, nil
}
