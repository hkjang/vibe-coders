package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"regexp"
	"strings"
)

// segBlock is one structural unit of a model response (paragraph, list item, or code block).
type segBlock struct {
	Type    string `json:"type"` // paragraph | list_item | code
	Preview string `json:"preview"`
	Key     string `json:"key"` // normalized content hash, used for cross-model matching
}

var (
	mmListItemRe   = regexp.MustCompile(`^\s*([-*+]|\d+[.)])\s+`)
	mmTableSepRe   = regexp.MustCompile(`^\s*\|?\s*:?-{3,}`)
	mmWhitespaceRe = regexp.MustCompile(`\s+`)
)

// decomposeResponse splits a markdown-ish response into structural blocks. Fenced code blocks
// are kept whole; list lines become individual list_item blocks; remaining consecutive
// non-blank lines are grouped into paragraphs.
func decomposeResponse(text string) []segBlock {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	blocks := []segBlock{}
	var para []string
	flushPara := func() {
		if len(para) == 0 {
			return
		}
		joined := strings.TrimSpace(strings.Join(para, " "))
		para = para[:0]
		if joined != "" {
			blocks = append(blocks, mkBlock("paragraph", joined))
		}
	}
	inCode := false
	var code []string
	for _, ln := range lines {
		if strings.HasPrefix(strings.TrimSpace(ln), "```") {
			if inCode {
				blocks = append(blocks, mkBlock("code", strings.Join(code, "\n")))
				code = code[:0]
				inCode = false
			} else {
				flushPara()
				inCode = true
			}
			continue
		}
		if inCode {
			code = append(code, ln)
			continue
		}
		if strings.TrimSpace(ln) == "" {
			flushPara()
			continue
		}
		if mmListItemRe.MatchString(ln) {
			flushPara()
			blocks = append(blocks, mkBlock("list_item", strings.TrimSpace(mmListItemRe.ReplaceAllString(ln, ""))))
			continue
		}
		para = append(para, ln)
	}
	flushPara()
	if inCode && len(code) > 0 {
		blocks = append(blocks, mkBlock("code", strings.Join(code, "\n")))
	}
	return blocks
}

func mkBlock(typ, content string) segBlock {
	norm := strings.ToLower(mmWhitespaceRe.ReplaceAllString(strings.TrimSpace(content), " "))
	sum := sha256.Sum256([]byte(typ + "|" + norm))
	preview := content
	if len(preview) > 200 {
		preview = preview[:200] + "…"
	}
	return segBlock{Type: typ, Preview: preview, Key: hex.EncodeToString(sum[:])[:16]}
}

func hasMarkdownTable(text string) bool {
	for _, ln := range strings.Split(text, "\n") {
		if strings.Count(ln, "|") >= 2 && mmTableSepRe.MatchString(ln) {
			return true
		}
	}
	// A separator row alone (| --- | --- |) is a strong signal.
	for _, ln := range strings.Split(text, "\n") {
		if mmTableSepRe.MatchString(ln) {
			return true
		}
	}
	return false
}

// handleMultiRunDiff decomposes each successful model's response and compares them block by
// block: common blocks (in every model), and per-model missing/extra blocks + format stats.
// GET /admin/chat-test/multi-run/runs/{id}/diff
func (s *Server) handleMultiRunDiff(w http.ResponseWriter, r *http.Request, runID string) {
	_, results, _, found, err := s.db.GetMultiModelRun(r.Context(), runID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "multi_run_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "run not found", "invalid_request_error", "not_found")
		return
	}

	type modelDiff struct {
		Model   string         `json:"model"`
		Blocks  []segBlock     `json:"blocks"`
		Stats   map[string]any `json:"stats"`
		keys    map[string]segBlock
		hasResp bool
	}
	mds := []*modelDiff{}
	for _, res := range results {
		if res.Status != "ok" || strings.TrimSpace(res.ResponsePreview) == "" {
			// Keep failed/empty models visible but with no blocks.
			mds = append(mds, &modelDiff{Model: res.Model, Blocks: []segBlock{}, keys: map[string]segBlock{},
				Stats: map[string]any{"available": false}})
			continue
		}
		blocks := decomposeResponse(res.ResponsePreview)
		keys := map[string]segBlock{}
		paras, items, codes := 0, 0, 0
		for _, b := range blocks {
			keys[b.Key] = b
			switch b.Type {
			case "paragraph":
				paras++
			case "list_item":
				items++
			case "code":
				codes++
			}
		}
		mds = append(mds, &modelDiff{
			Model: res.Model, Blocks: blocks, keys: keys, hasResp: true,
			Stats: map[string]any{
				"available":   true,
				"paragraphs":  paras,
				"list_items":  items,
				"code_blocks": codes,
				"chars":       len(res.ResponsePreview),
				"lines":       strings.Count(res.ResponsePreview, "\n") + 1,
				"has_table":   hasMarkdownTable(res.ResponsePreview),
				"has_code":    codes > 0,
			},
		})
	}

	// Presence count across models that produced a response.
	answered := 0
	keyCount := map[string]int{}
	keyBlock := map[string]segBlock{}
	for _, md := range mds {
		if !md.hasResp {
			continue
		}
		answered++
		for k, b := range md.keys {
			keyCount[k]++
			keyBlock[k] = b
		}
	}

	common := []segBlock{}
	for k, c := range keyCount {
		if answered > 1 && c == answered {
			common = append(common, keyBlock[k])
		}
	}

	perModel := []map[string]any{}
	for _, md := range mds {
		if !md.hasResp {
			perModel = append(perModel, map[string]any{"model": md.Model, "available": false})
			continue
		}
		missing := []segBlock{}  // present in some other model, absent here
		extra := []segBlock{}    // present only in this model
		for k, b := range keyBlock {
			if _, ok := md.keys[k]; !ok && keyCount[k] > 0 {
				missing = append(missing, b)
			}
		}
		for k, b := range md.keys {
			if keyCount[k] == 1 {
				extra = append(extra, b)
			}
		}
		perModel = append(perModel, map[string]any{
			"model":       md.Model,
			"available":   true,
			"missing":     missing, // blocks other models had that this one lacks
			"extra":       extra,   // blocks unique to this model
			"block_count": len(md.Blocks),
			"stats":       md.Stats,
		})
	}

	models := make([]map[string]any, 0, len(mds))
	for _, md := range mds {
		models = append(models, map[string]any{"model": md.Model, "blocks": md.Blocks, "stats": md.Stats})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"run_id":          runID,
		"answered_models": answered,
		"common_blocks":   common,
		"models":          models,
		"per_model":       perModel,
		"note":            "diff는 저장된 응답 preview 기준입니다(save_prompt가 꺼진 경우 일부 잘릴 수 있음). 블록은 정규화 후 해시로 매칭됩니다.",
	})
}
