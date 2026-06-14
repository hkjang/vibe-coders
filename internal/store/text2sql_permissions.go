package store

import (
	"context"
	"strings"
	"time"
)

// Text2SQLPermission is one row of the access matrix: it allows or denies a subject
// (a team, api_key, user, or "*" = everyone) access to a schema/table/column. "*"
// in schema/table/column means "all". deny rules restrict; allow rules grant access
// to a column that would otherwise be blocked by sensitivity tagging.
type Text2SQLPermission struct {
	ID          string `json:"id"`
	SubjectType string `json:"subject_type"` // team | api_key | user | *
	SubjectID   string `json:"subject_id"`   // "*" for all
	SchemaName  string `json:"schema_name"`  // "*" for all
	TableName   string `json:"table_name"`   // "*" for all
	ColumnName  string `json:"column_name"`  // "*" for all
	Action      string `json:"action"`       // allow | deny
	CreatedAt   string `json:"created_at"`
}

// Text2SQLPermissionEffect is the resolved access overlay for one request.
type Text2SQLPermissionEffect struct {
	DeniedTables   []string // tables fully denied for the subject
	DeniedColumns  []string // columns denied for the subject
	AllowedColumns []string // columns explicitly granted (override sensitivity exclude)
}

func (s *SQLStore) ListText2SQLPermissions(ctx context.Context) ([]Text2SQLPermission, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, subject_type, subject_id, schema_name, table_name, column_name, action, created_at
		FROM text2sql_permissions ORDER BY subject_type, subject_id, schema_name, table_name, column_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLPermission{}
	for rows.Next() {
		var p Text2SQLPermission
		if err := rows.Scan(&p.ID, &p.SubjectType, &p.SubjectID, &p.SchemaName, &p.TableName, &p.ColumnName, &p.Action, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertText2SQLPermission(ctx context.Context, p Text2SQLPermission) error {
	def := func(v string) string {
		if strings.TrimSpace(v) == "" {
			return "*"
		}
		return v
	}
	p.SchemaName, p.TableName, p.ColumnName = def(p.SchemaName), def(p.TableName), def(p.ColumnName)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_permissions
		(id, subject_type, subject_id, schema_name, table_name, column_name, action, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET subject_type = excluded.subject_type, subject_id = excluded.subject_id,
			schema_name = excluded.schema_name, table_name = excluded.table_name, column_name = excluded.column_name, action = excluded.action`),
		p.ID, p.SubjectType, p.SubjectID, p.SchemaName, p.TableName, p.ColumnName, p.Action, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *SQLStore) DeleteText2SQLPermission(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_permissions WHERE id = ?`), id)
	return err
}

// ResolveText2SQLPermissions computes the access overlay for a request against a
// schema, given the caller's api_key id and team. Rules whose subject does not
// match the caller are ignored.
func (s *SQLStore) ResolveText2SQLPermissions(ctx context.Context, schema, apiKeyID, team string) (Text2SQLPermissionEffect, error) {
	var eff Text2SQLPermissionEffect
	all, err := s.ListText2SQLPermissions(ctx)
	if err != nil {
		return eff, err
	}
	matchesSubject := func(p Text2SQLPermission) bool {
		switch strings.ToLower(p.SubjectType) {
		case "*", "any", "all":
			return true
		case "team":
			return p.SubjectID != "" && p.SubjectID == team
		case "api_key":
			return p.SubjectID != "" && p.SubjectID == apiKeyID
		case "user":
			return p.SubjectID != "" && p.SubjectID == apiKeyID // api key id is the user identity here
		}
		return false
	}
	for _, p := range all {
		if !matchesSubject(p) {
			continue
		}
		if p.SchemaName != "*" && !strings.EqualFold(p.SchemaName, schema) {
			continue
		}
		col := strings.ToLower(p.ColumnName)
		tbl := strings.ToLower(p.TableName)
		switch strings.ToLower(p.Action) {
		case "deny":
			if p.ColumnName == "*" && p.TableName != "*" {
				eff.DeniedTables = append(eff.DeniedTables, tbl)
			} else if p.ColumnName != "*" {
				eff.DeniedColumns = append(eff.DeniedColumns, col)
			} else { // deny all tables in schema → handled by caller emptying allowlist
				eff.DeniedTables = append(eff.DeniedTables, "*")
			}
		case "allow":
			if p.ColumnName != "*" {
				eff.AllowedColumns = append(eff.AllowedColumns, col)
			}
		}
	}
	return eff, nil
}
