// Serve the public files written by sync-update-mirror.py.
package main

import (
	"crypto/tls"
	"flag"
	"log"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var manifestPath = regexp.MustCompile(`^/latest/(Meki|mekiR)-update-(macos|windows)\.json$`)
var releasePath = regexp.MustCompile(`^/releases/(mekir-)?v[0-9]+\.[0-9]+\.[0-9]+/(Meki|mekiR)-[0-9]+\.[0-9]+\.[0-9]+-((macos|windows)-app\.asar\.gz|Setup-x64\.exe|macOS-universal\.dmg)$`)

func handler(root string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		switch {
		case manifestPath.MatchString(r.URL.Path):
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "application/json")
		case releasePath.MatchString(r.URL.Path):
			w.Header().Set("Cache-Control", "public, max-age=3600")
			w.Header().Set("Content-Type", "application/octet-stream")
		default:
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFile(w, r, filepath.Join(root, strings.TrimPrefix(r.URL.Path, "/")))
	})
}

func main() {
	listen := flag.String("listen", ":8443", "HTTPS listen address")
	root := flag.String("root", "/srv/meki-updates", "Mirror data directory")
	cert := flag.String("cert", "", "TLS certificate chain")
	key := flag.String("key", "", "TLS private key")
	flag.Parse()
	if *cert == "" || *key == "" {
		log.Fatal("Both -cert and -key are required")
	}
	server := &http.Server{
		Addr:              *listen,
		Handler:           handler(*root),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      35 * time.Minute,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12},
	}
	log.Fatal(server.ListenAndServeTLS(*cert, *key))
}
