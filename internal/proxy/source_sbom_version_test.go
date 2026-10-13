package proxy

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestSourceSBOMVersionMatchesAppVersion(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", ".github", "workflows", "ci.yml"))
	if err != nil {
		t.Fatal("cannot read canonical SBOM workflow")
	}
	versions := regexp.MustCompile(`(?m)^\s+SOURCE_SBOM_VERSION:\s*(v[0-9]+\.[0-9]+\.[0-9]+)\s*$`).FindAllSubmatch(raw, -1)
	if len(versions) != 1 || string(versions[0][1]) != AppVersion {
		t.Fatal("canonical SBOM workflow version must match the gateway release")
	}
}
