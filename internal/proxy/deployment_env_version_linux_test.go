package proxy

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeploymentEnvHelperReleaseVersion(t *testing.T) {
	helper, err := filepath.Abs(filepath.Join("..", "..", "scripts", "init-deployment-env.sh"))
	if err != nil {
		t.Fatal("cannot locate deployment helper")
	}
	for _, test := range []struct {
		name, override, expected string
	}{
		{name: "default follows AppVersion", expected: AppVersion},
		{name: "explicit release is preserved", override: "v9.8.7", expected: "v9.8.7"},
	} {
		t.Run(test.name, func(t *testing.T) {
			// A valid existing fixture avoids secret generation and any interaction
			// with an actual deployment. Never print its contents or child output.
			before := strings.Join([]string{
				"UPSTREAM_BASE_URL=https://provider.invalid",
				"UPSTREAM_API_KEY=synthetic-deployment-test-only",
				"GATEWAY_VERSION=v0.0.1",
				"ADMIN_TOKEN=" + strings.Repeat("a", 64),
				"GATEWAY_SECRET=" + strings.Repeat("b", 64),
				"UI_APP_ENABLED=true",
				"CUSTOM_DEPLOYMENT_SETTING=preserve-me",
				"",
			}, "\n")
			path := filepath.Join(t.TempDir(), "gateway.env")
			if os.WriteFile(path, []byte(before), 0o600) != nil {
				t.Fatal("cannot prepare isolated deployment fixture")
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "bash", helper, path)
			// Deliberately omit ambient GATEWAY_VERSION and every credential.
			// The invalid OpenSSL command also proves an existing env is reused.
			cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "LC_ALL=C", "OPENSSL_BIN=deployment-test-must-not-generate-secrets"}
			if test.override != "" {
				cmd.Env = append(cmd.Env, "GATEWAY_VERSION="+test.override)
			}
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			if cmd.Run() != nil {
				t.Fatal("isolated deployment helper execution failed; output suppressed")
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal("cannot read isolated deployment result")
			}
			if !bytes.Contains(after, []byte("\nGATEWAY_VERSION="+test.expected+"\n")) {
				t.Fatal("deployment helper selected the wrong release version")
			}
			expected := strings.Replace(before, "GATEWAY_VERSION=v0.0.1\n", "GATEWAY_VERSION="+test.expected+"\n", 1)
			if !bytes.Equal(after, []byte(expected)) {
				t.Fatal("deployment helper changed existing values beyond the requested version")
			}
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0o600 {
				t.Fatal("deployment helper did not preserve private env permissions")
			}
		})
	}
}
