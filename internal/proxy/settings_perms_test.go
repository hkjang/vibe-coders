package proxy

import "testing"

func TestSettingPermissionGroup(t *testing.T) {
	cases := []struct {
		name string
		def  settingDef
		want string
	}{
		{"secret is security", settingDef{Key: "text2sql.exec_dsn", Category: "text2sql", Secret: true}, "security"},
		{"mask_results is security", settingDef{Key: "text2sql.mask_results", Category: "text2sql"}, "security"},
		{"daily_risk_limit is security", settingDef{Key: "text2sql.daily_risk_limit", Category: "text2sql"}, "security"},
		{"daily_risk_warn is security", settingDef{Key: "text2sql.daily_risk_warn", Category: "text2sql"}, "security"},
		{"replay_bundles is security", settingDef{Key: "text2sql.replay_bundles", Category: "text2sql"}, "security"},
		{"clickhouse is ops", settingDef{Key: "clickhouse.batch_size", Category: "clickhouse"}, "ops"},
		{"retention is ops", settingDef{Key: "retention.days", Category: "retention"}, "ops"},
		{"cache is ops", settingDef{Key: "cache.ttl", Category: "cache"}, "ops"},
		{"text2sql model is ai", settingDef{Key: "text2sql.preview_model", Category: "text2sql"}, "ai"},
		{"carbon is admin", settingDef{Key: "carbon.pue", Category: "carbon"}, "admin"},
		{"insurance is admin", settingDef{Key: "insurance.rate", Category: "insurance"}, "admin"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := settingPermissionGroup(tc.def); got != tc.want {
				t.Errorf("settingPermissionGroup(%s) = %q, want %q", tc.def.Key, got, tc.want)
			}
		})
	}
}

func TestRoleCanWriteGroup(t *testing.T) {
	groups := []string{"ops", "ai", "security", "admin"}
	// want[role] = set of groups the role may write.
	want := map[string]map[string]bool{
		"":               {"ops": true, "ai": true, "security": true, "admin": true},
		"super_admin":    {"ops": true, "ai": true, "security": true, "admin": true},
		"admin":          {"ops": true, "ai": true, "security": true, "admin": true},
		"ops_admin":      {"ops": true},
		"ai_admin":       {"ai": true},
		"security_admin": {"security": true},
		"readonly_admin": {},
		"user":           {},
	}
	for role, allowed := range want {
		for _, g := range groups {
			got := roleCanWriteGroup(role, g)
			exp := allowed[g]
			if got != exp {
				t.Errorf("roleCanWriteGroup(%q, %q) = %v, want %v", role, g, got, exp)
			}
		}
	}
}

func TestSettingsSubAdminRole(t *testing.T) {
	for _, r := range []string{"ops_admin", "ai_admin", "security_admin"} {
		if !settingsSubAdminRole(r) {
			t.Errorf("settingsSubAdminRole(%q) = false, want true", r)
		}
	}
	for _, r := range []string{"admin", "super_admin", "readonly_admin", "user", ""} {
		if settingsSubAdminRole(r) {
			t.Errorf("settingsSubAdminRole(%q) = true, want false", r)
		}
	}
}
