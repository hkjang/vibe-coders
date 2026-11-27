package workintel

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// benchText builds a prompt of exactly n characters from realistic mixed
// Korean and English sentences, so the matcher sees the keyword density of a
// real request rather than filler.
func benchText(n int) string {
	parts := []string{
		"운영 클러스터에서 결제 서비스 파드가 계속 재시작됩니다. kubectl describe 결과와 로그를 보면 readiness probe가 실패하는데, ",
		"지난주에 배포한 버전부터 발생했고 롤백 계획도 같이 정리해야 합니다. ",
		"The deployment uses a Helm chart with resource limits of 512Mi, and the Java service connects to PostgreSQL through a connection pool. ",
		"원인 분석과 함께 재발 방지 대책을 장애 보고서 형식으로 정리해 주시고, 관련 SQL 쿼리의 인덱스도 확인해 주세요. ",
		"Also check whether the nightly batch job overlaps with the peak traffic window, and suggest how to tune the HPA settings. ",
		"마지막으로 변경 요청서에 들어갈 영향 범위와 원복 방안 초안도 부탁드립니다. ",
	}
	var b strings.Builder
	for i := 0; utf8.RuneCountInString(b.String()) < n; i++ {
		b.WriteString(parts[i%len(parts)])
	}
	return clipRunes(b.String(), n)
}

func BenchmarkClassify(b *testing.B) {
	e := DefaultEngine()
	cases := []struct {
		name string
		f    Features
	}{
		{"1500chars", Features{
			Text:       benchText(1500),
			TaskType:   "debug",
			Languages:  []string{"Java", "YAML"},
			MCPServers: []string{"kubernetes"},
			MCPTools:   []string{"pods_list", "pods_log"},
			Client:     "Claude Code",
			Complexity: 62,
		}},
		{"1500chars-text-only", Features{Text: benchText(1500)}},
		{"1500chars-korean", Features{Text: clipRunes(strings.Repeat("이번 분기 고객 문의 응대 품질을 높이기 위해 상담 스크립트와 자주 묻는 질문을 다시 정리하고 불만 유형을 분석해 주세요. ", 30), 1500)}},
		{"short", Features{Text: "이 함수 단위 테스트 작성해줘", TaskType: "test", Client: "Cursor"}},
	}
	for _, c := range cases {
		b.Run(c.name, func(b *testing.B) {
			if n := utf8.RuneCountInString(c.f.Text); strings.HasPrefix(c.name, "1500") && n != 1500 {
				b.Fatalf("benchmark text has %d characters", n)
			}
			b.SetBytes(int64(len(c.f.Text)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_ = e.Classify(c.f)
			}
		})
	}
}

func BenchmarkClassifyParallel(b *testing.B) {
	e := DefaultEngine()
	f := Features{Text: benchText(1500), TaskType: "debug", Languages: []string{"Java"}, Client: "Claude Code"}
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_ = e.Classify(f)
		}
	})
}

func BenchmarkCompile(b *testing.B) {
	p := DefaultPolicy()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, issues := Compile(p); len(issues) > 0 {
			b.Fatal(issues)
		}
	}
}

// TestClassifyIsFast is a coarse guard, not the measurement: it fails only
// when classification is an order of magnitude slower than the 50 µs target,
// so a slow or busy CI machine does not make it flaky. The benchmark above
// gives the real number.
func TestClassifyIsFast(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	if raceEnabled {
		// CI measured 852 µs per call under -race against 14 µs without it.
		t.Skip("timing test: the race detector slows classification by an order of magnitude")
	}
	e := DefaultEngine()
	f := Features{Text: benchText(1500), TaskType: "debug", Languages: []string{"Java"}, MCPServers: []string{"kubernetes"}, Client: "Claude Code"}
	res := testing.Benchmark(func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			_ = e.Classify(f)
		}
	})
	perOp := res.NsPerOp()
	t.Logf("Classify on a 1,500-character prompt: %d ns/op, %d allocs/op", perOp, res.AllocsPerOp())
	if perOp > 500_000 {
		t.Errorf("Classify takes %d ns per call, more than ten times the 50 µs target", perOp)
	}
}
