package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/netip"
	"time"

	"netstats/internal/flows"
	"netstats/internal/geo"
	"netstats/internal/names"
	"netstats/internal/procs"
	"netstats/internal/stats"
)

type snapshot struct {
	T         int64      `json:"t"` // unix milliseconds
	Home      point      `json:"home"`
	Up        float64    `json:"up"`   // bytes/s across all flows
	Down      float64    `json:"down"` // bytes/s across all flows
	Unlocated int        `json:"unlocated"`
	Public    bool       `json:"public,omitempty"` // addresses are withheld; the page is shown to strangers
	Flows     []flowJSON `json:"flows"`
	// Running totals since the collector started. They change slowly, so they ride along only now
	// and then.
	Stats *stats.Report `json:"stats,omitempty"`
}

type point struct {
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
	City string  `json:"city,omitempty"`
}

type flowJSON struct {
	ID    string  `json:"id"` // stable for as long as the host stays; the address itself outside public mode
	IP    string  `json:"ip,omitempty"`
	Lat   float64 `json:"lat"`
	Lon   float64 `json:"lon"`
	City  string  `json:"city,omitempty"`
	CC    string  `json:"cc,omitempty"`
	Host  string  `json:"host,omitempty"`
	Proc  string  `json:"proc,omitempty"`
	Proto string  `json:"proto"`
	Port  uint16  `json:"port"`
	Up    float64 `json:"up"`            // bytes/s
	Down  float64 `json:"down"`          // bytes/s
	RTT   float64 `json:"rtt,omitempty"` // ms
}

// locator is what a snapshot needs of the geo database.
type locator interface {
	Lookup(netip.Addr) (geo.Location, bool)
}

type sources struct {
	db       locator
	names    *names.Names
	procs    *procs.Procs // nil when process names are off
	home     geo.Location
	maxFlows int // caps how many arcs the browser is asked to draw; the quietest are left off
	public   bool
	idFor    func(netip.Addr) string
}

// addrID identifies a host by its address, for a page only this machine's user sees.
func addrID(ip netip.Addr) string { return ip.String() }

// hashedIDs identifies hosts without revealing their addresses: a keyed hash under a key that lives
// only in this process, so an id can't be reversed or linked to the same host after a restart.
func hashedIDs() func(netip.Addr) string {
	key := make([]byte, 32)
	rand.Read(key)
	return func(ip netip.Addr) string {
		mac := hmac.New(sha256.New, key)
		b := ip.As16()
		mac.Write(b[:])
		return hex.EncodeToString(mac.Sum(nil)[:8])
	}
}

func (s sources) snapshot(now time.Time, live []flows.Flow) snapshot {
	snap := snapshot{
		T:      now.UnixMilli(),
		Home:   point{Lat: s.home.Lat, Lon: s.home.Lon, City: s.home.City},
		Public: s.public,
		Flows:  make([]flowJSON, 0, min(len(live), s.maxFlows)),
	}
	for _, f := range live {
		snap.Up += f.RateUp
		snap.Down += f.RateDown
		loc, ok := s.db.Lookup(f.Remote)
		if !ok {
			snap.Unlocated++
			continue
		}
		if len(snap.Flows) == s.maxFlows {
			continue
		}
		fj := flowJSON{
			ID:    s.idFor(f.Remote),
			Lat:   loc.Lat,
			Lon:   loc.Lon,
			City:  loc.City,
			CC:    loc.Country,
			Host:  s.names.Lookup(f.Remote),
			Proto: f.Proto.String(),
			Port:  f.Port,
			Up:    math.Round(f.RateUp),
			Down:  math.Round(f.RateDown),
			RTT:   math.Round(float64(f.RTT.Microseconds())/100) / 10,
		}
		if !s.public {
			fj.IP = f.Remote.String()
		}
		if s.procs != nil {
			fj.Proc = s.procs.Lookup(f.Proto, f.LocalPort)
		}
		snap.Flows = append(snap.Flows, fj)
	}
	snap.Up, snap.Down = math.Round(snap.Up), math.Round(snap.Down)
	return snap
}
