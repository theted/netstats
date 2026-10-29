package stats

import (
	"bufio"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// Counters are an interface's own byte counts since it came up, which is normally since boot. They
// include what the globe leaves out: the LAN, and anything else that isn't on the internet.
type Counters struct {
	Name string `json:"name"`
	Up   uint64 `json:"up"`
	Down uint64 `json:"down"`
}

// readCounters reads an interface's counters from /proc/net/dev. That file belongs to the reader's
// network namespace, so a container on the host's network reads the host's interfaces.
func readCounters(iface string) (Counters, bool) {
	if iface == "" {
		return Counters{}, false
	}
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return Counters{}, false
	}
	defer f.Close()
	return parseNetDev(f, iface)
}

// parseNetDev finds an interface in /proc/net/dev: two header lines, then one line per interface,
// "name: " and eight receive columns, bytes first, then the transmit columns, bytes first.
func parseNetDev(r io.Reader, iface string) (Counters, bool) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok || strings.TrimSpace(name) != iface {
			continue
		}
		cols := strings.Fields(rest)
		if len(cols) < 9 {
			return Counters{}, false
		}
		down, err1 := strconv.ParseUint(cols[0], 10, 64)
		up, err2 := strconv.ParseUint(cols[8], 10, 64)
		if err1 != nil || err2 != nil {
			return Counters{}, false
		}
		return Counters{Name: iface, Up: up, Down: down}, true
	}
	return Counters{}, false
}

// bootTime reads when the machine booted from /proc/stat. A container shares its host's kernel, so
// there it is the host's boot.
func bootTime() (time.Time, bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return time.Time{}, false
	}
	defer f.Close()
	return parseBootTime(f)
}

// parseBootTime finds the "btime <unix seconds>" line of /proc/stat.
func parseBootTime(r io.Reader) (time.Time, bool) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "btime "); ok {
			sec, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			return time.Unix(sec, 0), err == nil
		}
	}
	return time.Time{}, false
}
