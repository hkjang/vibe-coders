package proxy

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// LatencyDigest is a lock-protected fixed-size ring of recent observations.
// We keep up to 4096 samples and recompute quantiles on demand. This is enough
// resolution for a gateway dashboard without bringing in t-digest.
type LatencyDigest struct {
	mu      sync.Mutex
	samples []int64 // observations in ms
	idx     int     // next write position
	count   int     // total observations ever (saturates at len(samples))
	total   atomic.Uint64
	seen    atomic.Uint64
}

const latencyDigestSize = 4096

// Prometheus histogram buckets in milliseconds. Roughly geometric.
var latencyBucketsMS = []int64{10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000}

func newLatencyDigest() *LatencyDigest {
	return &LatencyDigest{samples: make([]int64, latencyDigestSize)}
}

func (d *LatencyDigest) Observe(ms int64) {
	if ms < 0 {
		return
	}
	d.mu.Lock()
	d.samples[d.idx] = ms
	d.idx = (d.idx + 1) % len(d.samples)
	if d.count < len(d.samples) {
		d.count++
	}
	d.mu.Unlock()
	d.total.Add(uint64(ms))
	d.seen.Add(1)
}

func (d *LatencyDigest) snapshot() []int64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.count == 0 {
		return nil
	}
	out := make([]int64, d.count)
	copy(out, d.samples[:d.count])
	return out
}

// Quantiles returns the requested quantiles in [0,1]. Result preserves input order.
func (d *LatencyDigest) Quantiles(qs ...float64) []int64 {
	snap := d.snapshot()
	if len(snap) == 0 {
		out := make([]int64, len(qs))
		return out
	}
	sort.Slice(snap, func(i, j int) bool { return snap[i] < snap[j] })
	out := make([]int64, len(qs))
	for i, q := range qs {
		if q < 0 {
			q = 0
		}
		if q > 1 {
			q = 1
		}
		idx := int(float64(len(snap)-1) * q)
		out[i] = snap[idx]
	}
	return out
}

// PrometheusHistogram returns a Prometheus exposition snippet using fixed buckets.
func (d *LatencyDigest) PrometheusHistogram() string {
	return d.PrometheusHistogramFor("proxy_request_duration_ms", "Request latency histogram in milliseconds (last 4096 samples).")
}

func (d *LatencyDigest) PrometheusHistogramFor(metric string, help string) string {
	snap := d.snapshot()
	counts := make([]uint64, len(latencyBucketsMS))
	var sum uint64
	for _, v := range snap {
		sum += uint64(v)
		for i, b := range latencyBucketsMS {
			if v <= b {
				counts[i]++
			}
		}
	}
	// cumulative counts already (each sample increments every bucket >= its value)
	var b strings.Builder
	fmt.Fprintf(&b, "# HELP %s %s\n", metric, help)
	fmt.Fprintf(&b, "# TYPE %s histogram\n", metric)
	totalSeen := d.seen.Load()
	for i, bucket := range latencyBucketsMS {
		fmt.Fprintf(&b, "%s_bucket{le=\"%d\"} %d\n", metric, bucket, counts[i])
		_ = i
	}
	fmt.Fprintf(&b, "%s_bucket{le=\"+Inf\"} %d\n", metric, uint64(len(snap)))
	fmt.Fprintf(&b, "%s_sum %d\n", metric, d.total.Load())
	fmt.Fprintf(&b, "%s_count %d\n", metric, totalSeen)
	return b.String()
}
