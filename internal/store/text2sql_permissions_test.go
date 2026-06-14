package store

import (
	"context"
	"testing"
)

func TestResolveText2SQLPermissions(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	must := func(p Text2SQLPermission) {
		if err := db.UpsertText2SQLPermission(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	// team platform: deny the salaries table entirely.
	must(Text2SQLPermission{ID: "p1", SubjectType: "team", SubjectID: "platform", SchemaName: "hr", TableName: "salaries", ColumnName: "*", Action: "deny"})
	// everyone: deny the ssn column.
	must(Text2SQLPermission{ID: "p2", SubjectType: "*", SubjectID: "*", SchemaName: "*", TableName: "*", ColumnName: "ssn", Action: "deny"})
	// api_key k_hr: allow ssn (grant override).
	must(Text2SQLPermission{ID: "p3", SubjectType: "api_key", SubjectID: "k_hr", SchemaName: "hr", TableName: "*", ColumnName: "ssn", Action: "allow"})
	// another team's rule must not apply.
	must(Text2SQLPermission{ID: "p4", SubjectType: "team", SubjectID: "finance", SchemaName: "hr", TableName: "ledger", ColumnName: "*", Action: "deny"})

	// platform team, generic key.
	eff, err := db.ResolveText2SQLPermissions(ctx, "hr", "k_other", "platform")
	if err != nil {
		t.Fatal(err)
	}
	if !contains(eff.DeniedTables, "salaries") {
		t.Errorf("platform should be denied salaries: %+v", eff.DeniedTables)
	}
	if contains(eff.DeniedTables, "ledger") {
		t.Error("finance-only rule leaked to platform")
	}
	if !contains(eff.DeniedColumns, "ssn") {
		t.Errorf("everyone should be denied ssn: %+v", eff.DeniedColumns)
	}
	if len(eff.AllowedColumns) != 0 {
		t.Errorf("k_other should have no allow grants: %+v", eff.AllowedColumns)
	}

	// k_hr gets the ssn allow grant.
	eff2, _ := db.ResolveText2SQLPermissions(ctx, "hr", "k_hr", "platform")
	if !contains(eff2.AllowedColumns, "ssn") {
		t.Errorf("k_hr should be granted ssn: %+v", eff2.AllowedColumns)
	}
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
