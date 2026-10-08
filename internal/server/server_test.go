package server

import (
	"bufio"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func stream(t *testing.T, ctx context.Context, url string, header http.Header) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, "GET", url+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header = header
	resp, err := http.DefaultTransport.RoundTrip(req) // no transparent gzip: these tests look at the wire
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// next reads up to the next event and returns its data.
func next(t *testing.T, r *bufio.Reader) string {
	t.Helper()
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if data, ok := strings.CutPrefix(line, "data: "); ok {
			return strings.TrimSuffix(data, "\n")
		}
	}
}

func TestViewerLimit(t *testing.T) {
	hub := NewHub(1)
	hub.Publish([]byte(`{"n":1}`)) // the first viewer gets this at once, so it is subscribed when Get returns
	srv := httptest.NewServer(Handler(hub, fstest.MapFS{}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if first := stream(t, ctx, srv.URL, http.Header{}); first.StatusCode != http.StatusOK {
		t.Fatalf("first viewer: %s", first.Status)
	}
	if second := stream(t, ctx, srv.URL, http.Header{}); second.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("second viewer: %s, want 503", second.Status)
	}
}

func TestGzippedStream(t *testing.T) {
	hub := NewHub(0)
	hub.Publish([]byte(`{"n":1}`))
	srv := httptest.NewServer(Handler(hub, fstest.MapFS{}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	resp := stream(t, ctx, srv.URL, http.Header{"Accept-Encoding": {"gzip"}})
	if enc := resp.Header.Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("Content-Encoding %q, want gzip", enc)
	}
	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(gz)
	if got := next(t, r); got != `{"n":1}` {
		t.Errorf("first event %q", got)
	}
	// Each event has to be readable as soon as it is sent, not when the compressor's buffer fills.
	hub.Publish([]byte(`{"n":2}`))
	if got := next(t, r); got != `{"n":2}` {
		t.Errorf("second event %q", got)
	}
}

func TestAssetsCachedForever(t *testing.T) {
	static := fstest.MapFS{"assets/index-abc123.js": {Data: []byte("x")}, "index.html": {Data: []byte("<!doctype html>")}}
	srv := httptest.NewServer(Handler(NewHub(0), static))
	defer srv.Close()
	for path, want := range map[string]string{"/assets/index-abc123.js": "immutable", "/": ""} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("Cache-Control"); !strings.Contains(got, want) || (want == "" && got != "") {
			t.Errorf("%s: Cache-Control %q", path, got)
		}
	}
}
