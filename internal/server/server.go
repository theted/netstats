// Package server streams snapshots to browsers over Server-Sent Events and serves the frontend.
package server

import (
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Hub fans one stream of messages out to every connected client. A client that falls behind
// misses messages rather than slowing the others; each message is a full snapshot, so the next one
// catches it up.
type Hub struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
	last []byte
	max  int
}

// NewHub returns a hub that streams to at most max clients at once; 0 means no limit.
func NewHub(max int) *Hub { return &Hub{subs: make(map[chan []byte]struct{}), max: max} }

// Publish sends msg to every client.
func (h *Hub) Publish(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.last = msg
	for ch := range h.subs {
		select {
		case ch <- msg:
		default:
		}
	}
}

// subscribe reports false when the hub is full.
func (h *Hub) subscribe() (chan []byte, []byte, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.max > 0 && len(h.subs) >= h.max {
		return nil, nil, false
	}
	ch := make(chan []byte, 4)
	h.subs[ch] = struct{}{}
	return ch, h.last, true
}

func (h *Hub) unsubscribe(ch chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs, ch)
}

// Events is the SSE endpoint. The stream is gzipped when the browser accepts it: consecutive
// snapshots are nearly identical, so one compressor kept across the whole stream shrinks it many
// times over.
func (h *Hub) Events(w http.ResponseWriter, r *http.Request) {
	ch, last, ok := h.subscribe()
	if !ok {
		http.Error(w, "too many viewers, try again later", http.StatusServiceUnavailable)
		return
	}
	defer h.unsubscribe(ch)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	// Otherwise a reverse proxy such as nginx holds the stream back in its buffers.
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)

	var out io.Writer = w
	flush := rc.Flush
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")
		gz, _ := gzip.NewWriterLevel(w, gzip.BestSpeed) // the fastest level is also the smallest in memory, per viewer
		defer gz.Close()
		out = gz
		flush = func() error {
			if err := gz.Flush(); err != nil {
				return err
			}
			return rc.Flush()
		}
	}

	send := func(msg []byte) bool {
		if _, err := out.Write([]byte("data: ")); err != nil {
			return false
		}
		if _, err := out.Write(msg); err != nil {
			return false
		}
		if _, err := out.Write([]byte("\n\n")); err != nil {
			return false
		}
		return flush() == nil
	}
	if last != nil && !send(last) {
		return
	}
	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			if !send(msg) {
				return
			}
		case <-keepalive.C:
			if _, err := out.Write([]byte(": keepalive\n\n")); err != nil || flush() != nil {
				return
			}
		}
	}
}

// Handler routes /events to the hub and everything else to the static frontend.
func Handler(h *Hub, static fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /events", h.Events)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok\n"))
	})
	files := http.FileServerFS(static)
	mux.Handle("GET /", files)
	// Vite names everything under assets/ after its content, so a file never changes under its name.
	// Without this, browsers fetch three.js again on every visit: embedded files carry no
	// modification time to revalidate against.
	mux.Handle("GET /assets/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		files.ServeHTTP(w, r)
	}))
	return mux
}
