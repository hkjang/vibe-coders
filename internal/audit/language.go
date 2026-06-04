package audit

import (
	"regexp"
	"sort"
	"strings"
)

type LanguageSignal struct {
	Language   string
	Confidence float64
	Evidence   string
}

var codeFenceRE = regexp.MustCompile("(?is)```\\s*([a-zA-Z0-9_+#.-]+)?\\s*\\n(.*?)```")
var filenameRE = regexp.MustCompile(`(?i)\b[\w./-]+\.(py|js|jsx|ts|tsx|go|rs|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|rb|php|swift|sql|yaml|yml|json|toml|sh|bash|ps1|dockerfile|gradle|scala)\b`)

var fenceLanguageMap = map[string]string{
	"py":         "Python",
	"python":     "Python",
	"js":         "JavaScript",
	"javascript": "JavaScript",
	"jsx":        "JavaScript",
	"ts":         "TypeScript",
	"typescript": "TypeScript",
	"tsx":        "TypeScript",
	"go":         "Go",
	"golang":     "Go",
	"rs":         "Rust",
	"rust":       "Rust",
	"java":       "Java",
	"kotlin":     "Kotlin",
	"kt":         "Kotlin",
	"cs":         "C#",
	"csharp":     "C#",
	"cpp":        "C++",
	"c++":        "C++",
	"c":          "C",
	"ruby":       "Ruby",
	"rb":         "Ruby",
	"php":        "PHP",
	"swift":      "Swift",
	"sql":        "SQL",
	"yaml":       "YAML",
	"yml":        "YAML",
	"json":       "JSON",
	"sh":         "Shell",
	"bash":       "Shell",
	"powershell": "PowerShell",
	"ps1":        "PowerShell",
	"dockerfile": "Dockerfile",
	"scala":      "Scala",
}

var extensionLanguageMap = map[string]string{
	"py":         "Python",
	"js":         "JavaScript",
	"jsx":        "JavaScript",
	"ts":         "TypeScript",
	"tsx":        "TypeScript",
	"go":         "Go",
	"rs":         "Rust",
	"java":       "Java",
	"kt":         "Kotlin",
	"kts":        "Kotlin",
	"cs":         "C#",
	"cpp":        "C++",
	"cc":         "C++",
	"cxx":        "C++",
	"c":          "C",
	"h":          "C/C++",
	"hpp":        "C++",
	"rb":         "Ruby",
	"php":        "PHP",
	"swift":      "Swift",
	"sql":        "SQL",
	"yaml":       "YAML",
	"yml":        "YAML",
	"json":       "JSON",
	"toml":       "TOML",
	"sh":         "Shell",
	"bash":       "Shell",
	"ps1":        "PowerShell",
	"dockerfile": "Dockerfile",
	"gradle":     "Gradle",
	"scala":      "Scala",
}

var keywordSignals = []struct {
	language string
	terms    []string
}{
	{"Python", []string{"fastapi", "django", "pytest", "poetry", "def ", "import pandas"}},
	{"JavaScript", []string{"node.js", "express", "npm", "package.json", "function(", "console.log"}},
	{"TypeScript", []string{"typescript", "tsconfig", "interface ", "type ", "nestjs"}},
	{"Java", []string{"spring boot", "maven", "pom.xml", "public class", "junit"}},
	{"Go", []string{"golang", "go.mod", "func ", "package main", "goroutine"}},
	{"Rust", []string{"cargo.toml", "fn main", "borrow checker", "rust"}},
	{"SQL", []string{"select ", "insert into", "postgres", "sqlite", "mysql"}},
	{"Dockerfile", []string{"dockerfile", "docker compose", "from alpine", "from ubuntu"}},
	{"Kotlin", []string{"kotlin", "gradle.kts", "fun main"}},
	{"C#", []string{".csproj", "asp.net", "namespace ", "using system"}},
	{"PHP", []string{"laravel", "<?php", "composer.json"}},
}

func InferLanguages(texts []string) []LanguageSignal {
	scores := map[string]LanguageSignal{}
	for _, text := range texts {
		for _, match := range codeFenceRE.FindAllStringSubmatch(text, -1) {
			lang := canonicalLanguage(match[1])
			if lang != "" {
				addSignal(scores, lang, 0.95, "code fence: "+strings.ToLower(match[1]))
			}
		}

		for _, match := range filenameRE.FindAllStringSubmatch(text, -1) {
			lang := extensionLanguageMap[strings.ToLower(match[1])]
			if lang != "" {
				addSignal(scores, lang, 0.9, "file extension: ."+strings.ToLower(match[1]))
			}
		}

		lower := strings.ToLower(text)
		for _, signal := range keywordSignals {
			for _, term := range signal.terms {
				if strings.Contains(lower, strings.ToLower(term)) {
					addSignal(scores, signal.language, 0.65, "keyword: "+term)
				}
			}
		}
	}

	result := make([]LanguageSignal, 0, len(scores))
	for _, signal := range scores {
		result = append(result, signal)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Confidence == result[j].Confidence {
			return result[i].Language < result[j].Language
		}
		return result[i].Confidence > result[j].Confidence
	})
	if len(result) > 5 {
		result = result[:5]
	}
	return result
}

func canonicalLanguage(raw string) string {
	lang := strings.ToLower(strings.TrimSpace(raw))
	if lang == "" {
		return ""
	}
	return fenceLanguageMap[lang]
}

func addSignal(scores map[string]LanguageSignal, language string, confidence float64, evidence string) {
	current, ok := scores[language]
	if !ok || confidence > current.Confidence {
		scores[language] = LanguageSignal{Language: language, Confidence: confidence, Evidence: evidence}
		return
	}
	if ok && current.Evidence != evidence && !strings.Contains(current.Evidence, evidence) {
		current.Evidence += "; " + evidence
		scores[language] = current
	}
}
