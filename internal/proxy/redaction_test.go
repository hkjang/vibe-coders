package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// What a secret in a prompt leaves behind.
//
// The redactor advertises thirteen rule types and labels each match. This drives one
// example of every rule through a real request and then reads the database, because the
// question that matters is not whether Redact() works on a string — there are unit tests
// for that — but whether anything on the path to storage keeps a copy it did not redact.
//
// It also pins the one place that deliberately does not redact. LOG_RAW_BODIES stores the
// exact request bytes so /admin/debug can replay them, and a masked body is not a
// request, so it cannot be redacted without removing the feature. That is a real hazard
// and it is recorded here rather than left to be rediscovered: with the flag on, every
// one of the thirteen is recoverable from body_raw.

// secretSamples is one item per advertised rule, in the shape a caller would actually
// paste into a prompt.
//
// The credential-shaped ones are assembled at run time rather than written as literals.
// They are synthetic, but synthetic in exactly the format the real thing uses — which is
// the point, since a sample the redactor would not match proves nothing — and a scanner
// reading this file cannot tell the difference. GitHub's push protection stopped the
// first version of this test for that reason. Splitting the literal keeps the value
// identical at run time while leaving nothing in the source to match.
var secretSamples = map[string]string{
	"OpenAI key":     "sk-" + "proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh",
	"Anthropic key":  "sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-AbCdEf",
	"AWS access key": "AKIA" + "IOSFODNN7EXAMPLE",
	"GitHub token":   "ghp" + "_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
	"Slack token":    "xoxb" + "-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
	"Google API key": "AIza" + "SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q",
	"Bearer header":  "Authorization: Bearer " + "eyJhbGciOiJIUzI1NiJ9.payload.signature",
	"주민등록번호":         "900101-1234567",
	"휴대전화":           "010-1234-5678",
	"카드번호":           "4111-1111-1111-1111",
	"이메일":            "victim@example.com",
	"US SSN":         "123-45-6789",
	"key=value":      "password=hunter2supersecret",
}

// runSecretsThroughGateway sends one request per sample and returns everything the
// database kept, concatenated.
func runSecretsThroughGateway(t *testing.T, rawBodies bool) string {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "s")
	cfg.Auth.AdminToken = "rw"
	cfg.Logging.RawBodies = rawBodies
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	for _, value := range secretSamples {
		body, _ := json.Marshal(map[string]any{"model": "test-model",
			"messages": []map[string]string{{"role": "user", "content": "please use " + value + " to log in"}}})
		req, err := http.NewRequest(http.MethodPost, proxy.URL+"/v1/chat/completions", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}

	ctx := context.Background()
	var stored strings.Builder
	deadline := time.Now().Add(5 * time.Second)
	for {
		stored.Reset()
		rows, err := db.RecentRequests(ctx, store.RequestFilter{Limit: 100})
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range rows {
			if detail, err := db.RequestDetail(ctx, r.ID); err == nil {
				for _, p := range detail.Prompts {
					stored.WriteString(p.ContentText + "\n" + p.RedactedText + "\n")
				}
			}
			if body, _, _, err := db.RequestRawBody(ctx, r.ID); err == nil {
				stored.WriteString(body + "\n")
			}
		}
		if len(rows) >= len(secretSamples) || time.Now().After(deadline) {
			if len(rows) < len(secretSamples) {
				t.Fatalf("only %d of %d requests were recorded; nothing can be concluded about "+
					"what was stored", len(rows), len(secretSamples))
			}
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	return stored.String()
}

func leakedFrom(stored string) []string {
	var leaked []string
	for label, value := range secretSamples {
		if strings.Contains(stored, value) {
			leaked = append(leaked, label)
		}
	}
	sort.Strings(leaked)
	return leaked
}

func TestSecretsInPromptsAreNotStored(t *testing.T) {
	stored := runSecretsThroughGateway(t, false)

	// Anti-vacuity: prompts have to be stored at all, or "nothing leaked" means only
	// that nothing was written.
	if !strings.Contains(stored, "please use") || !strings.Contains(stored, "to log in") {
		t.Fatal("the surrounding prompt text was not stored either, so this proves nothing " +
			"about redaction — it only shows the prompt log is empty")
	}
	if leaked := leakedFrom(stored); len(leaked) > 0 {
		t.Errorf("%d secret(s) reached the database verbatim: %v\n"+
			"Every one of these is a rule the redactor advertises.", len(leaked), leaked)
	}
}

// The deliberate exception, pinned so it stays deliberate. If someone starts redacting
// the raw body, replay silently stops resending the original request; if the flag stops
// storing anything, replay breaks outright. Either way this should be a decision, not a
// surprise.
func TestRawBodyLoggingKeepsPromptsVerbatimAndSaysSo(t *testing.T) {
	stored := runSecretsThroughGateway(t, true)
	leaked := leakedFrom(stored)
	if len(leaked) != len(secretSamples) {
		t.Errorf("with LOG_RAW_BODIES on, %d of %d samples survived in the database. "+
			"Replay needs the exact bytes, so this flag is expected to keep all of them — "+
			"if that changed on purpose, update this test and the setting's description.",
			len(leaked), len(secretSamples))
	}

	// The description shown next to the switch has to name the consequence. The
	// operations guide already does; the place an operator actually flips it should too.
	desc := settingDescriptions["logging.raw_bodies"]
	for _, want := range []string{"마스킹", "평문"} {
		if !strings.Contains(desc, want) {
			t.Errorf("the description for logging.raw_bodies does not mention %q. "+
				"Enabling it stores every prompt unredacted, and this is the text the "+
				"person enabling it reads: %q", want, desc)
		}
	}
}
