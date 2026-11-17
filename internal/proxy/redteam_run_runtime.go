package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"

	"vibe-coders/internal/store"
)

// Only a digest is retained. Credentials and connection strings are never
// returned in a review. Current gateway policies still apply at invocation;
// this check does not lock concurrent administrator changes across processes.
func (s *Server) redTeamRuntimeRevision(r *http.Request) (string, error) {
	providers, err := s.db.ListProviderConfigs(r.Context())
	if err != nil {
		return "", err
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i].Name < providers[j].Name })
	profiles, err := s.db.ListText2SQLProfiles(r.Context())
	if err != nil {
		return "", err
	}
	b, err := json.Marshal([]any{providers, s.upstreamConf(), s.t2sConf(), profiles})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(b)
	return hex.EncodeToString(digest[:]), nil
}

func (s *Server) redTeamReviewProvider(r *http.Request, target store.RedTeamTarget, allowExternal bool) error {
	providers, err := s.db.ListProviderConfigs(r.Context())
	if err != nil {
		return err
	}
	var selected *store.ProviderConfig
	for i := range providers {
		if providers[i].Name == target.Provider {
			selected = &providers[i]
		}
	}
	if target.TargetType != "text2sql" && (selected == nil || !selected.Enabled) {
		return errRedTeamRunSelection
	}
	for _, provider := range providers {
		candidate := target.TargetType == "text2sql" || provider.Name == target.Provider ||
			(selected != nil && selected.FailoverGroup != "" && provider.FailoverGroup == selected.FailoverGroup)
		if candidate && provider.Enabled && redTeamExternalURL(provider.BaseURL) && !allowExternal {
			return errRedTeamRunSelection
		}
	}
	return nil
}
