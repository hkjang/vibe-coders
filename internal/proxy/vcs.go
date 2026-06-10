package proxy

import (
	"context"
	"regexp"
	"strconv"
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// vibeSessionMarker matches an explicit session reference embedded in a commit
// message / MR title / branch, e.g. "Vibe-Session: sess_ab12" or "[vibe:sess_ab12]".
var (
	vibeSessionMarker = regexp.MustCompile(`(?i)vibe[-_ ]?session\s*[:=]\s*([A-Za-z0-9_\-:.]+)`)
	vibeBracketMarker = regexp.MustCompile(`(?i)\[vibe:([A-Za-z0-9_\-:.]+)\]`)
)

func extractSessionMarker(texts ...string) string {
	for _, t := range texts {
		if m := vibeSessionMarker.FindStringSubmatch(t); len(m) == 2 {
			return strings.TrimSpace(m[1])
		}
		if m := vibeBracketMarker.FindStringSubmatch(t); len(m) == 2 {
			return strings.TrimSpace(m[1])
		}
	}
	return ""
}

// ingestVCSEvents correlates each event to a session (explicit field or marker in
// title/branch) and the session's primary api key, then stores it.
func (s *Server) ingestVCSEvents(ctx context.Context, events []store.VCSEvent) (int, error) {
	stored := 0
	for _, e := range events {
		if strings.TrimSpace(e.Provider) == "" || strings.TrimSpace(e.Kind) == "" {
			continue
		}
		if e.SessionID == "" {
			e.SessionID = extractSessionMarker(e.Title, e.Branch)
		}
		if e.SessionID != "" && e.APIKeyID == "" {
			if k, err := s.db.SessionPrimaryAPIKey(ctx, e.SessionID); err == nil {
				e.APIKeyID = k
			}
		}
		if e.ID == "" {
			e.ID = vcsEventID(e)
		}
		if err := s.db.InsertVCSEvent(ctx, e); err != nil {
			return stored, err
		}
		stored++
	}
	return stored, nil
}

// vcsEventID derives a stable id so re-deliveries (e.g. an MR state change) upsert.
func vcsEventID(e store.VCSEvent) string {
	key := e.Provider + "|" + e.Kind + "|" + e.Repo + "|" + e.Ref
	return "vcs_" + audit.HashText(key)[:16]
}

// ---- provider payload normalizers (tolerant: never panic on missing fields) ----

func mstr(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	switch v := m[key].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	}
	return ""
}

func mmap(m map[string]any, key string) map[string]any {
	if m == nil {
		return nil
	}
	v, _ := m[key].(map[string]any)
	return v
}

func marr(m map[string]any, key string) []any {
	if m == nil {
		return nil
	}
	v, _ := m[key].([]any)
	return v
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// parseGitLabWebhook handles GitLab "push" and "merge_request" hooks.
func parseGitLabWebhook(root map[string]any) []store.VCSEvent {
	proj := mmap(root, "project")
	repo := firstNonEmpty(mstr(proj, "path_with_namespace"), mstr(proj, "name"))
	switch mstr(root, "object_kind") {
	case "push", "tag_push":
		branch := strings.TrimPrefix(strings.TrimPrefix(mstr(root, "ref"), "refs/heads/"), "refs/tags/")
		var out []store.VCSEvent
		for _, c := range marr(root, "commits") {
			cm, _ := c.(map[string]any)
			if cm == nil {
				continue
			}
			au := mmap(cm, "author")
			out = append(out, store.VCSEvent{
				Provider: "gitlab", Kind: "commit", Repo: repo, Branch: branch,
				Ref: mstr(cm, "id"), Title: firstLine(mstr(cm, "message")), URL: mstr(cm, "url"),
				AuthorEmail: mstr(au, "email"), AuthorName: mstr(au, "name"),
			})
		}
		return out
	case "merge_request":
		oa := mmap(root, "object_attributes")
		user := mmap(root, "user")
		return []store.VCSEvent{{
			Provider: "gitlab", Kind: "merge_request", Repo: repo,
			Branch: mstr(oa, "source_branch"), Ref: mstr(oa, "iid"),
			Title: mstr(oa, "title"), URL: mstr(oa, "url"), State: mstr(oa, "state"),
			AuthorName: mstr(user, "name"), AuthorEmail: mstr(user, "email"),
		}}
	}
	return nil
}

// parseBitbucketWebhook handles Bitbucket Server (pr:*, repo:refs_changed) and
// Bitbucket Cloud (pullrequest:*, repo:push) payloads.
func parseBitbucketWebhook(eventKey string, root map[string]any) []store.VCSEvent {
	ek := strings.ToLower(strings.TrimSpace(eventKey))
	// --- Bitbucket Server PR (pr:opened / pr:merged / pr:declined) ---
	if pr := mmap(root, "pullRequest"); pr != nil {
		actor := mmap(root, "actor")
		from := mmap(pr, "fromRef")
		repoMap := mmap(from, "repository")
		return []store.VCSEvent{{
			Provider: "bitbucket", Kind: "merge_request",
			Repo:   firstNonEmpty(mstr(repoMap, "name"), bitbucketServerRepo(mmap(root, "pullRequest"))),
			Branch: mstr(from, "displayId"), Ref: mstr(pr, "id"),
			Title: mstr(pr, "title"), State: bitbucketState(ek),
			AuthorName:  firstNonEmpty(mstr(actor, "displayName"), mstr(actor, "name")),
			AuthorEmail: mstr(actor, "emailAddress"),
		}}
	}
	// --- Bitbucket Cloud PR (pullrequest:created / pullrequest:fulfilled) ---
	if pr := mmap(root, "pullrequest"); pr != nil {
		repoMap := mmap(root, "repository")
		src := mmap(mmap(pr, "source"), "branch")
		links := mmap(mmap(pr, "links"), "html")
		return []store.VCSEvent{{
			Provider: "bitbucket", Kind: "merge_request",
			Repo:   firstNonEmpty(mstr(repoMap, "full_name"), mstr(repoMap, "name")),
			Branch: mstr(src, "name"), Ref: mstr(pr, "id"),
			Title: mstr(pr, "title"), URL: mstr(links, "href"), State: bitbucketState(ek),
			AuthorName: mstr(mmap(pr, "author"), "display_name"),
		}}
	}
	// --- Bitbucket Cloud push (repo:push) — has per-commit messages ---
	if push := mmap(root, "push"); push != nil {
		repoMap := mmap(root, "repository")
		repo := firstNonEmpty(mstr(repoMap, "full_name"), mstr(repoMap, "name"))
		var out []store.VCSEvent
		for _, ch := range marr(push, "changes") {
			chm, _ := ch.(map[string]any)
			branch := mstr(mmap(chm, "new"), "name")
			for _, c := range marr(chm, "commits") {
				cm, _ := c.(map[string]any)
				if cm == nil {
					continue
				}
				out = append(out, store.VCSEvent{
					Provider: "bitbucket", Kind: "commit", Repo: repo, Branch: branch,
					Ref: mstr(cm, "hash"), Title: firstLine(mstr(cm, "message")),
					AuthorName: mstr(mmap(cm, "author"), "raw"),
				})
			}
		}
		return out
	}
	// --- Bitbucket Server push (repo:refs_changed) — ref change only, no messages ---
	if ek == "repo:refs_changed" {
		repoMap := mmap(root, "repository")
		repo := firstNonEmpty(mstr(repoMap, "name"), mstr(mmap(repoMap, "project"), "key"))
		actor := mmap(root, "actor")
		var out []store.VCSEvent
		for _, ch := range marr(root, "changes") {
			chm, _ := ch.(map[string]any)
			ref := mmap(chm, "ref")
			out = append(out, store.VCSEvent{
				Provider: "bitbucket", Kind: "commit", Repo: repo,
				Branch: mstr(ref, "displayId"), Ref: mstr(chm, "toHash"),
				Title: "push " + mstr(ref, "displayId"), AuthorName: mstr(actor, "displayName"), AuthorEmail: mstr(actor, "emailAddress"),
			})
		}
		return out
	}
	return nil
}

func bitbucketState(eventKey string) string {
	switch {
	case strings.Contains(eventKey, "merged"), strings.Contains(eventKey, "fulfilled"):
		return "merged"
	case strings.Contains(eventKey, "declined"), strings.Contains(eventKey, "rejected"):
		return "closed"
	default:
		return "opened"
	}
}

func bitbucketServerRepo(pr map[string]any) string {
	to := mmap(pr, "toRef")
	return mstr(mmap(to, "repository"), "name")
}
