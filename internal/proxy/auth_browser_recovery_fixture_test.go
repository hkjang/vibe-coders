//go:build linux

package proxy

import (
	"errors"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

var browserProviderChunkName = regexp.MustCompile(`^ProviderPage-[A-Za-z0-9_-]{8,64}\.js$`)

// Resolve only the compiled deployment's exact page chunk. Do not accept a
// caller-supplied URL, a glob intercept, source maps, or another route's asset.
// The returned path is test input, never a new application endpoint.
func browserAuthProviderChunk(assets fs.FS) (string, error) {
	invalid := errors.New("embedded provider page chunk unavailable or ambiguous")
	if assets == nil {
		return "", invalid
	}
	entries, err := fs.ReadDir(assets, "assets")
	if err != nil {
		return "", invalid
	}
	selected := ""
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "ProviderPage-") || !strings.HasSuffix(name, ".js") {
			continue
		}
		if selected != "" || !browserProviderChunkName.MatchString(name) || !entry.Type().IsRegular() {
			return "", invalid
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return "", invalid
		}
		body, err := fs.ReadFile(assets, "assets/"+name)
		if err != nil || len(body) == 0 {
			return "", invalid
		}
		selected = "/app/assets/" + name
	}
	if selected == "" {
		return "", invalid
	}
	return selected, nil
}

func TestAuthBrowserFixtureProviderChunkSelection(t *testing.T) {
	const safe = "assets/ProviderPage-fixture1.js"
	file := func() *fstest.MapFile {
		return &fstest.MapFile{Data: []byte("export const fixture = true;"), Mode: 0o600}
	}
	t.Run("one exact regular page chunk among unrelated assets", func(t *testing.T) {
		assets := fstest.MapFS{
			safe: file(), "assets/ProviderPage-fixture1.js.map": file(),
			"assets/ProviderPage-fixture1.css": file(), "assets/ProviderDetails-fixture1.js": file(),
			"assets/index-fixture1.js": file(),
		}
		got, err := browserAuthProviderChunk(assets)
		if err != nil || got != "/app/assets/ProviderPage-fixture1.js" {
			t.Fatal("the exact embedded route chunk was not selected")
		}
	})
	for _, tc := range []struct {
		name string
		fs   fs.FS
	}{
		{"nil filesystem", nil},
		{"missing asset directory", fstest.MapFS{"index.html": file()}},
		{"missing page", fstest.MapFS{"assets/index-fixture1.js": file()}},
		{"two hashes", fstest.MapFS{safe: file(), "assets/ProviderPage-fixture2.js": file()}},
		{"empty chunk", fstest.MapFS{safe: {Mode: 0o600}}},
		{"directory chunk", fstest.MapFS{safe: {Mode: fs.ModeDir | 0o700}}},
		{"symlink chunk", fstest.MapFS{safe: {Data: []byte("elsewhere"), Mode: fs.ModeSymlink | 0o600}}},
		{"unhashed filename", fstest.MapFS{"assets/ProviderPage-x.js": file()}},
		{"query delimiter", fstest.MapFS{"assets/ProviderPage-fixture1?.js": file()}},
		{"encoded path", fstest.MapFS{"assets/ProviderPage-fixture%2f.js": file()}},
		{"backslash path", fstest.MapFS{"assets/ProviderPage-fixture\\1.js": file()}},
		{"nested chunk", fstest.MapFS{"assets/nested/ProviderPage-fixture1.js": file()}},
		{"unsafe extra candidate", fstest.MapFS{safe: file(), "assets/ProviderPage-?.js": file()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := browserAuthProviderChunk(tc.fs)
			if err == nil || got != "" {
				t.Fatal("unsafe or ambiguous embedded page selection must fail closed")
			}
		})
	}
}

func TestAuthBrowserFixtureRecoveryProbeSessionIsIndependent(t *testing.T) {
	h := newBrowserAuthHarness(t)
	client := h.gateway.Client()
	original := browserAccessLogin(t, h, false)
	probe := browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/login", "",
		map[string]string{"email": "admin-browser@example.invalid", "password": h.adminPassword}, http.StatusOK)
	access, _ := probe["access_token"].(string)
	refresh, _ := probe["refresh_token"].(string)
	if access == "" || refresh == "" || access == original || probe["expires_in"] != browserAuthAccessTTL.Seconds() {
		t.Fatal("recovery probe must use its own real bounded session")
	}
	browserAuthJSON(t, client, http.MethodGet, h.gateway.URL+"/admin/providers", access, nil, http.StatusOK)
	id, secret := browserAccessIssue(t, h, access)
	before := h.upstream.calls.Load()
	browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/v1/chat/completions", secret,
		map[string]any{"model": "browser-access-model", "messages": []map[string]string{{"role": "user", "content": "synthetic recovery probe"}}}, http.StatusOK)
	if h.upstream.calls.Load() != before+1 || h.upstream.deniedModelCalls.Load() != 0 {
		t.Fatal("recovery probe must reach only the local permitted model")
	}
	revoked := browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/admin/api-keys/"+id+"/revoke", access, nil, http.StatusOK)
	if revoked["status"] != "revoked" || revoked["id"] != id {
		t.Fatal("recovery probe key was not revoked")
	}
	stored, found, err := h.db.GetAPIKey(t.Context(), id)
	if err != nil || !found || stored.RevokedAt.IsZero() || stored.Status != "revoked" {
		t.Fatal("recovery probe key revocation did not persist")
	}
	browserAuthJSON(t, client, http.MethodPost, h.gateway.URL+"/auth/logout", access,
		map[string]string{"refresh_token": refresh}, http.StatusOK)
	browserAuthJSON(t, client, http.MethodGet, h.gateway.URL+"/auth/me", access, nil, http.StatusUnauthorized)
	browserAuthJSON(t, client, http.MethodGet, h.gateway.URL+"/auth/me", original, nil, http.StatusOK)
}
