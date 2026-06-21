package proxy

import "testing"

func TestAppTemplateCatalog(t *testing.T) {
	if len(appTemplateCatalog) < 3 {
		t.Fatalf("expected several templates, got %d", len(appTemplateCatalog))
	}
	seen := map[string]bool{}
	for _, tpl := range appTemplateCatalog {
		if tpl.Key == "" || tpl.Title == "" {
			t.Errorf("template missing key/title: %+v", tpl)
		}
		if seen[tpl.Key] {
			t.Errorf("duplicate template key %q", tpl.Key)
		}
		seen[tpl.Key] = true
		if len(tpl.Components) == 0 {
			t.Errorf("template %q has no components", tpl.Key)
		}
	}
	if findAppTemplate("code-review") == nil {
		t.Error("code-review template should resolve")
	}
	if findAppTemplate("does-not-exist") != nil {
		t.Error("unknown key must return nil")
	}
}
