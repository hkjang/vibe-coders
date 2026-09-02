package appui

import (
	"embed"
	"io/fs"
	"net/http"
)

// The dist directory intentionally contains only a tracked placeholder in a
// clean source checkout. Release builds replace its contents with the Vite
// production build before compiling the Go binary.
//
//go:embed all:dist
var embeddedFiles embed.FS

//go:embed fallback/disabled.html
var disabledPage []byte

//go:embed fallback/unavailable.html
var unavailablePage []byte

// EmbeddedFS returns the application UI files compiled into this binary.
// A clean development checkout returns a valid, but build-less, filesystem.
func EmbeddedFS() fs.FS {
	dist, err := fs.Sub(embeddedFiles, "dist")
	if err != nil {
		return nil
	}
	return dist
}

// NewEmbeddedHandler serves the application UI compiled into this binary.
func NewEmbeddedHandler(options Options) http.Handler {
	return NewHandler(EmbeddedFS(), options)
}
