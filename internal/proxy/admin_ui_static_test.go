package proxy

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The whole admin UI is one Go raw string literal, which makes a few whole-file
// invariants worth asserting cheaply. Each check here corresponds to a mistake that
// actually reached the file and was only caught by chance.

// adminUISource returns the file text and the HTML/JS payload inside the raw string.
func adminUISource(t *testing.T) (file string, payload string) {
	t.Helper()
	raw, err := os.ReadFile("admin_ui.go")
	if err != nil {
		t.Fatalf("read admin_ui.go: %v", err)
	}
	file = string(raw)
	start := strings.Index(file, "`")
	end := strings.LastIndex(file, "`")
	if start < 0 || end <= start {
		t.Fatal("admin_ui.go does not contain the expected raw string literal")
	}
	return file, file[start+1 : end]
}

// A backtick inside the payload silently terminates the raw string, so the rest of the
// HTML becomes Go source. It fails the build, but with an error pointing at whatever
// CSS or markup happened to follow — far from the real cause.
func TestAdminUIRawStringHasNoInteriorBacktick(t *testing.T) {
	file, payload := adminUISource(t)
	if got := strings.Count(payload, "`"); got != 0 {
		t.Fatalf("%d backtick(s) inside the admin UI raw string; they terminate the literal", got)
	}
	if got := strings.Count(file, "`"); got != 2 {
		t.Fatalf("admin_ui.go has %d backticks, want exactly 2 (the raw string delimiters)", got)
	}
}

// Actions report through toast(), which is non-blocking and — unlike alert() — can
// distinguish success from failure. A stray alert() reintroduces a modal interruption
// that stops the operator's work.
func TestAdminUIUsesToastNotAlert(t *testing.T) {
	_, payload := adminUISource(t)
	call := regexp.MustCompile(`\balert\(`)
	for i, line := range strings.Split(payload, "\n") {
		trimmed := strings.TrimSpace(line)
		// Prose may name alert() when explaining why it was replaced.
		if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "/*") || strings.HasPrefix(trimmed, "*") {
			continue
		}
		if call.MatchString(line) {
			t.Errorf("admin_ui.go:%d uses alert(); use toast(message, kind) instead:\n\t%s", i+1, trimmed)
		}
	}
}

// api()'s success option announces "saved". Several screens query over POST, so
// attaching it to one of those would claim a write that never happened.
func TestAdminUISuccessToastNotOnReadOnlyEndpoints(t *testing.T) {
	_, payload := adminUISource(t)
	readOnly := []string{
		"pattern-conflicts", "routing/preview", "chat-test", "/predict",
		"/simulate", "/explain", "scatter", "/judge", "/multi-run",
	}
	// Match an api('<path>', { ... success: '...' }) call without crossing into the next.
	call := regexp.MustCompile(`api\('([^']+)'[^)]{0,400}?success: '([^']+)'`)
	for _, m := range call.FindAllStringSubmatch(payload, -1) {
		for _, ro := range readOnly {
			if strings.Contains(m[1], ro) {
				t.Errorf("read-only endpoint %q announces success %q; it performs no write", m[1], m[2])
			}
		}
	}
}

// Toast messages carry server strings. Rendering them as HTML would make any upstream
// error message an injection vector, so the implementation must stay on textContent.
func TestAdminUIToastRendersAsText(t *testing.T) {
	_, payload := adminUISource(t)
	start := strings.Index(payload, "function toast(")
	if start < 0 {
		t.Fatal("toast() not found in admin UI")
	}
	body := payload[start:]
	if end := strings.Index(body, "\n    function "); end > 0 {
		body = body[:end]
	}
	// Match an actual assignment, not the word appearing in a comment that explains
	// why it is avoided — the check must not be tripped by its own rationale.
	if regexp.MustCompile(`\.innerHTML\s*=`).MatchString(body) {
		t.Error("toast() assigns innerHTML; messages include server text and must use textContent")
	}
	if !strings.Contains(body, "textContent") {
		t.Error("toast() does not use textContent")
	}
}

// Both overlays declare aria-modal, which asserts the rest of the page is inert. That
// is only true if focus is actually trapped and handed back on close.
func TestAdminUIOverlaysDeclareDialogSemantics(t *testing.T) {
	_, payload := adminUISource(t)
	for _, id := range []string{"modal-backdrop", "palette-backdrop"} {
		idx := strings.Index(payload, `id="`+id+`"`)
		if idx < 0 {
			t.Fatalf("overlay %q not found", id)
		}
		tag := payload[idx:min(idx+300, len(payload))]
		if cut := strings.Index(tag, ">"); cut > 0 {
			tag = tag[:cut]
		}
		for _, attr := range []string{`role="dialog"`, `aria-modal="true"`} {
			if !strings.Contains(tag, attr) {
				t.Errorf("overlay %q is missing %s: %s", id, attr, tag)
			}
		}
	}
	for _, fn := range []string{"captureFocusOrigin", "restoreFocusOrigin", "trapFocusInside"} {
		if !strings.Contains(payload, "function "+fn+"(") {
			t.Errorf("focus helper %s() is missing; aria-modal would be a false promise", fn)
		}
	}
}
