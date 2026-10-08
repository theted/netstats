// Package procs finds which process owns a local port, by matching socket inodes in /proc/net
// against the file descriptors under /proc/<pid>/fd. Only processes this user may inspect are
// found, which in practice means this user's own.
package procs

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"netstats/internal/capture"
)

type key struct {
	proto capture.Proto
	port  uint16
}

// Procs is a periodically refreshed port → process name table. It is safe for concurrent use.
type Procs struct {
	mu     sync.RWMutex
	byPort map[key]string
}

func New() *Procs { return &Procs{byPort: make(map[key]string)} }

// Lookup returns the name of the process holding the given local port, or "".
func (p *Procs) Lookup(proto capture.Proto, port uint16) string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.byPort[key{proto, port}]
}

// Run refreshes the table every interval until ctx is done.
func (p *Procs) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		p.Refresh()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Refresh rebuilds the table from /proc.
func (p *Procs) Refresh() {
	inodes := make(map[string]key)
	for _, src := range []struct {
		file  string
		proto capture.Proto
	}{
		{"/proc/net/tcp", capture.ProtoTCP},
		{"/proc/net/tcp6", capture.ProtoTCP},
		{"/proc/net/udp", capture.ProtoUDP},
		{"/proc/net/udp6", capture.ProtoUDP},
	} {
		readSockets(src.file, src.proto, inodes)
	}

	byPort := make(map[key]string)
	pids, _ := filepath.Glob("/proc/[0-9]*")
	for _, dir := range pids {
		fds, err := os.ReadDir(filepath.Join(dir, "fd"))
		if err != nil {
			continue // not ours, or already gone
		}
		var comm string
		for _, fd := range fds {
			link, err := os.Readlink(filepath.Join(dir, "fd", fd.Name()))
			if err != nil || !strings.HasPrefix(link, "socket:[") {
				continue
			}
			k, ok := inodes[link[len("socket:["):len(link)-1]]
			if !ok {
				continue
			}
			if comm == "" {
				b, err := os.ReadFile(filepath.Join(dir, "comm"))
				if err != nil {
					break
				}
				comm = strings.TrimSpace(string(b))
			}
			byPort[k] = comm
		}
	}

	p.mu.Lock()
	p.byPort = byPort
	p.mu.Unlock()
}

// readSockets adds each socket in a /proc/net table to inodes, keyed by inode number.
func readSockets(file string, proto capture.Proto, inodes map[string]key) {
	f, err := os.Open(file)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Scan() // header
	for sc.Scan() {
		// sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
		cols := strings.Fields(sc.Text())
		if len(cols) < 10 || cols[9] == "0" {
			continue
		}
		_, hexPort, ok := strings.Cut(cols[1], ":")
		if !ok {
			continue
		}
		port, err := strconv.ParseUint(hexPort, 16, 16)
		if err != nil {
			continue
		}
		inodes[cols[9]] = key{proto, uint16(port)}
	}
}
