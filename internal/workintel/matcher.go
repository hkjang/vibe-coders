package workintel

import (
	"sort"
	"unicode/utf8"
)

// A trie node with more than denseFanout children gets a full 256-entry
// table, but only near the root and only up to maxDenseNodes of them. The
// scan spends almost all of its time in the few shallow nodes with many
// children (the root, the UTF-8 lead bytes of Hangul, common first letters),
// so making exactly those dense buys the speed of a full automaton for a
// fraction of its memory, and the caps keep an unusual policy from turning
// that fraction into hundreds of megabytes.
const (
	denseFanout   = 6
	denseMaxDepth = 4
	maxDenseNodes = 2048
	// linearScanMax is the edge count up to which a sorted scan beats a
	// binary search.
	linearScanMax = 8
)

// pattern is one distinct string in the matcher. A string can play several
// roles at once ("리팩토링" is a category keyword and an action keyword).
type pattern struct {
	text string
	// exact marks a pattern whose last word is short ASCII: it must match the
	// whole word, give or take a common inflection.
	exact bool
	// inflect allows the inflection suffixes. Two-letter patterns never
	// inflect: "hi" must not match "his".
	inflect bool
	item    int32 // category evidence item, or -1
	action  int32 // index into Engine.actions, or -1
	tech    int32 // index into knownTech, or -1
}

type trieNode struct {
	dense int32 // offset of this node's block in matcher.dense, or -1
	off   int32 // first sparse edge
	n     int32 // number of sparse edges
	pat   int32 // pattern ending at this node, or -1
}

// matcher is a byte trie over normalised, lower-cased patterns. It is walked
// from every position where a pattern may start, which keeps memory linear
// in the total keyword length and lets the caller apply word-boundary rules
// per start position.
type matcher struct {
	nodes []trieNode
	edgeB []byte
	edgeN []int32
	dense []int32
	pats  []pattern
}

// step follows the edge labelled b from node n. It returns -1 when there is none.
func (m *matcher) step(n int32, b byte) int32 {
	nd := &m.nodes[n]
	if nd.dense >= 0 {
		return m.dense[int(nd.dense)+int(b)]
	}
	lo, hi := nd.off, nd.off+nd.n
	if nd.n > linearScanMax {
		for hi-lo > linearScanMax {
			mid := (lo + hi) / 2
			if m.edgeB[mid] <= b {
				lo = mid
			} else {
				hi = mid
			}
		}
	}
	for i := lo; i < hi; i++ {
		if c := m.edgeB[i]; c == b {
			return m.edgeN[i]
		} else if c > b {
			break
		}
	}
	return -1
}

type trieEdge struct {
	b    byte
	next int32
}

// trieBuilder collects patterns before they are flattened. Children are kept
// in small slices rather than maps: almost every node has exactly one.
type trieBuilder struct {
	children [][]trieEdge
	depth    []int32
	pat      []int32
	pats     []pattern
	index    map[string]int32
}

func newTrieBuilder() *trieBuilder {
	return &trieBuilder{
		children: [][]trieEdge{nil},
		depth:    []int32{0},
		pat:      []int32{-1},
		index:    map[string]int32{},
	}
}

// add registers text (already normalised) and returns its pattern id. Adding
// the same text again returns the existing id so roles can be merged.
func (b *trieBuilder) add(text string) int32 {
	if id, ok := b.index[text]; ok {
		return id
	}
	node := int32(0)
	for i := 0; i < len(text); i++ {
		c := text[i]
		next := int32(-1)
		for _, e := range b.children[node] {
			if e.b == c {
				next = e.next
				break
			}
		}
		if next < 0 {
			next = int32(len(b.children))
			b.children = append(b.children, nil)
			b.depth = append(b.depth, b.depth[node]+1)
			b.pat = append(b.pat, -1)
			b.children[node] = append(b.children[node], trieEdge{c, next})
		}
		node = next
	}
	id := int32(len(b.pats))
	exact, inflect := wholeWordRule(text)
	b.pats = append(b.pats, pattern{text: text, exact: exact, inflect: inflect, item: -1, action: -1, tech: -1})
	b.pat[node] = id
	b.index[text] = id
	return id
}

func (b *trieBuilder) build() matcher {
	m := matcher{nodes: make([]trieNode, len(b.children)), pats: b.pats}
	denseNodes := 0
	for i, kids := range b.children {
		nd := trieNode{dense: -1, off: int32(len(m.edgeB)), pat: b.pat[i]}
		// The root is always dense: it is consulted once per start position.
		dense := i == 0 || (len(kids) > denseFanout && b.depth[i] <= denseMaxDepth && denseNodes < maxDenseNodes)
		if dense {
			denseNodes++
			nd.dense = int32(len(m.dense))
			block := make([]int32, 256)
			for j := range block {
				block[j] = -1
			}
			for _, e := range kids {
				block[e.b] = e.next
			}
			m.dense = append(m.dense, block...)
		} else {
			// Sparse edges are stored sorted so step can search them.
			sorted := append([]trieEdge(nil), kids...)
			sort.Slice(sorted, func(x, y int) bool { return sorted[x].b < sorted[y].b })
			for _, e := range sorted {
				m.edgeB = append(m.edgeB, e.b)
				m.edgeN = append(m.edgeN, e.next)
			}
			nd.n = int32(len(sorted))
		}
		m.nodes[i] = nd
	}
	return m
}

// wordByte marks ASCII letters and digits, the bytes that make up an English word.
var wordByte = func() (t [256]bool) {
	for c := '0'; c <= '9'; c++ {
		t[c] = true
	}
	for c := 'a'; c <= 'z'; c++ {
		t[c] = true
	}
	for c := 'A'; c <= 'Z'; c++ {
		t[c] = true
	}
	return t
}()

// wholeWordRule decides how the end of a pattern is matched. Short English
// words are too ambiguous as prefixes ("java" would match "javascript",
// "rest" would match "restart"), so a pattern whose last word has four
// characters or fewer must end at a word boundary.
func wholeWordRule(text string) (exact, inflect bool) {
	n := 0
	for i := len(text) - 1; i >= 0 && wordByte[text[i]]; i-- {
		n++
	}
	if n == 0 || n > 4 {
		return false, false
	}
	return true, n >= 3
}

// wordEndsAt reports whether the text may end a whole-word pattern at
// position end: the word stops there, or continues with a common inflection.
func wordEndsAt(buf []byte, end int, inflect bool) bool {
	j := end
	for j < len(buf) && wordByte[buf[j]] {
		j++
		if j-end > 3 {
			return false
		}
	}
	if j == end {
		return true
	}
	if !inflect {
		return false
	}
	switch string(buf[end:j]) {
	case "s", "es", "ed", "d", "ing":
		return true
	}
	return false
}

// normalizeText lower-cases ASCII, folds whitespace runs into single spaces
// and trims, appending to dst. Input beyond max bytes is ignored, cut at a
// rune boundary. Only ASCII is case-folded: Hangul has no case, and that
// covers the two languages policies are written in without paying for full
// Unicode folding on every request.
func normalizeText(dst []byte, s string, max int) []byte {
	if len(s) > max {
		cut := max
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut]
	}
	space := true // suppresses leading whitespace
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == ' ' || (c >= '\t' && c <= '\r'):
			if !space {
				dst = append(dst, ' ')
				space = true
			}
			continue
		case c >= 'A' && c <= 'Z':
			c += 'a' - 'A'
		}
		dst = append(dst, c)
		space = false
	}
	if n := len(dst); n > 0 && dst[n-1] == ' ' {
		dst = dst[:n-1]
	}
	return dst
}

// normalizeKeyword applies the same normalisation to a policy keyword.
func normalizeKeyword(s string) string {
	return string(normalizeText(nil, s, len(s)))
}
