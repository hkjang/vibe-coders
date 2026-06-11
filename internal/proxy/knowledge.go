package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

const knowledgeTTL = 5 * time.Second

type knowledgeSnapshot struct {
	byID      map[string]store.KnowledgeSnippet
	fetchedAt time.Time
}

func (s *Server) knowledgeSnapshot(ctx context.Context) map[string]store.KnowledgeSnippet {
	if cached := s.knowledge.Load(); cached != nil && time.Since(cached.fetchedAt) < knowledgeTTL {
		return cached.byID
	}
	snap := &knowledgeSnapshot{byID: map[string]store.KnowledgeSnippet{}, fetchedAt: time.Now()}
	if list, err := s.db.ActiveKnowledge(ctx); err == nil {
		for _, k := range list {
			snap.byID[k.ID] = k
		}
	}
	s.knowledge.Store(snap)
	return snap.byID
}

func (s *Server) invalidateKnowledgeCache() { s.knowledge.Store(nil) }

var knowledgePlaceholder = regexp.MustCompile(`\{\{\s*kb:([a-zA-Z0-9_-]{1,64})\s*\}\}`)
var contextPlaceholder = regexp.MustCompile(`\{\{\s*ctx:([a-zA-Z0-9_-]{1,96})\s*\}\}`)

// expandKnowledge substitutes {{kb:slug}} placeholders in chat message contents and,
// when the X-Vibe-Knowledge header lists slugs, prepends a system message with their
// content. The client sends a short reference; the gateway forwards the full text
// upstream (central governance + smaller client payloads/logs). Returns the rewritten
// body, the unique slugs used, and estimated tokens injected. Fast no-op when neither
// a placeholder nor the header is present.
func (s *Server) expandKnowledge(r *http.Request, body []byte) ([]byte, []string, int) {
	header := firstNonEmptyHeader(r, "X-Vibe-Knowledge", "X-Knowledge")
	contextHeader := firstNonEmptyHeader(r, "X-Vibe-Context", "X-Context")
	if header == "" && contextHeader == "" && !bytes.Contains(body, []byte("{{")) {
		return body, nil, 0
	}
	snap := s.knowledgeSnapshot(r.Context())
	contexts := s.contextRegistrySnapshot(r.Context())
	if len(snap) == 0 && len(contexts) == 0 {
		return body, nil, 0
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return body, nil, 0
	}
	used := map[string]bool{}
	tokens := 0

	// 1) placeholder substitution within message contents
	if msgs, ok := root["messages"].([]any); ok {
		for _, m := range msgs {
			msg, ok := m.(map[string]any)
			if !ok {
				continue
			}
			content, ok := msg["content"].(string)
			if !ok || !strings.Contains(content, "{{") {
				continue
			}
			content = knowledgePlaceholder.ReplaceAllStringFunc(content, func(match string) string {
				sub := knowledgePlaceholder.FindStringSubmatch(match)
				if len(sub) != 2 {
					return match
				}
				k, found := snap[sub[1]]
				if !found {
					return match // unknown slug: leave the placeholder visible
				}
				used[sub[1]] = true
				tokens += audit.EstimateTokens(k.Content)
				return k.Content
			})
			content = contextPlaceholder.ReplaceAllStringFunc(content, func(match string) string {
				sub := contextPlaceholder.FindStringSubmatch(match)
				if len(sub) != 2 {
					return match
				}
				c, found := contexts[sub[1]]
				if !found {
					return match
				}
				used["ctx:"+sub[1]] = true
				tokens += audit.EstimateTokens(c.Content)
				return c.Content
			})
			msg["content"] = content
		}
	}

	// 2) header-driven prepend (attach org rules/context without the client embedding them)
	if header != "" || contextHeader != "" {
		var parts, ids []string
		for _, raw := range strings.Split(header, ",") {
			slug := strings.TrimSpace(raw)
			if slug == "" {
				continue
			}
			if k, found := snap[slug]; found {
				parts = append(parts, k.Content)
				ids = append(ids, slug)
			}
		}
		if contextHeader != "" {
			for _, raw := range strings.Split(contextHeader, ",") {
				key := strings.TrimSpace(raw)
				if key == "" {
					continue
				}
				if c, found := contexts[key]; found {
					parts = append(parts, c.Content)
					ids = append(ids, "ctx:"+key)
				}
			}
		}
		if len(parts) > 0 {
			joined := strings.Join(parts, "\n\n")
			tokens += audit.EstimateTokens(joined)
			for _, id := range ids {
				used[id] = true
			}
			sysMsg := map[string]any{"role": "system", "content": joined}
			if msgs, ok := root["messages"].([]any); ok {
				root["messages"] = append([]any{sysMsg}, msgs...)
			} else {
				root["messages"] = []any{sysMsg}
			}
		}
	}

	if len(used) == 0 {
		return body, nil, 0
	}
	out, err := json.Marshal(root)
	if err != nil {
		return body, nil, 0
	}
	ids := make([]string, 0, len(used))
	for id := range used {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return out, ids, tokens
}

func (s *Server) contextRegistrySnapshot(ctx context.Context) map[string]store.ContextRegistryEntry {
	out := map[string]store.ContextRegistryEntry{}
	list, err := s.db.ActiveContextRegistry(ctx)
	if err != nil {
		return out
	}
	for _, entry := range list {
		out[entry.Key] = entry
	}
	return out
}

func splitExpandedRefs(ids []string) ([]string, []string) {
	kbIDs := []string{}
	ctxKeys := []string{}
	for _, id := range ids {
		if strings.HasPrefix(id, "ctx:") {
			key := strings.TrimPrefix(id, "ctx:")
			if key != "" {
				ctxKeys = append(ctxKeys, key)
			}
			continue
		}
		if id != "" {
			kbIDs = append(kbIDs, id)
		}
	}
	return kbIDs, ctxKeys
}
