//go:build race

package workintel

// raceEnabled reports whether the race detector is compiled in. It slows the
// classifier by an order of magnitude, so timing guards are not meaningful then.
const raceEnabled = true
