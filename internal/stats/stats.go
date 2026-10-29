// Package stats keeps running totals of the traffic since the collector started: the bytes each
// way, the busiest moment, how many distinct hosts were seen, the countries and services the
// traffic went to, and the farthest place it reached. No address is kept: distinct hosts are
// counted with HyperLogLog sketches, which hold only maxima of hash bits.
package stats

import (
	"cmp"
	"hash/maphash"
	"math"
	"net/netip"
	"slices"
	"strings"
	"time"

	"netstats/internal/capture"
	"netstats/internal/flows"
	"netstats/internal/geo"
)

// Locator places an address on the map.
type Locator interface {
	Lookup(netip.Addr) (geo.Location, bool)
}

const (
	// hostsPrecision sizes the sketch of every host: 16 KiB, counting to within about 1%.
	hostsPrecision = 14
	// countryPrecision sizes each country's sketch: 1 KiB, counting to within about 3%.
	countryPrecision = 10
	// listed is how many services, and how many countries by each ranking, a report lists.
	listed = 8
)

// Report is the tally so far, as the page shows it.
type Report struct {
	Since    int64   `json:"since"`          // unix ms: when counting began
	Boot     int64   `json:"boot,omitempty"` // unix ms: when the machine booted, where known
	Up       uint64  `json:"up"`             // bytes sent to internet hosts since counting began
	Down     uint64  `json:"down"`           // bytes received from them
	PeakUp   float64 `json:"peakUp"`         // the highest total rate, bytes/s
	PeakDown float64 `json:"peakDown"`
	Hosts    uint64  `json:"hosts"` // distinct remote hosts, estimated
	// The capture interface's own counters, since boot. Linux only.
	Iface *Counters `json:"iface,omitempty"`
	// The countries with the most hosts, and those with the most traffic: one list, so the page
	// can rank them either way.
	Countries    []Country `json:"countries"`
	CountryCount int       `json:"countryCount"`
	Services     []Service `json:"services"` // by traffic
	Farthest     *Place    `json:"farthest,omitempty"`
}

type Country struct {
	CC    string `json:"cc"`
	Bytes uint64 `json:"bytes"`
	Hosts uint64 `json:"hosts"`
}

// Service is a protocol and port: the server's port for traffic either way.
type Service struct {
	Proto string `json:"proto"`
	Port  uint16 `json:"port"`
	Bytes uint64 `json:"bytes"`
}

type Place struct {
	City string  `json:"city,omitempty"`
	CC   string  `json:"cc,omitempty"`
	Km   float64 `json:"km"`
}

type country struct {
	bytes uint64
	hosts *sketch
}

type service struct {
	proto capture.Proto
	port  uint16
}

// Tally keeps the running totals. It is not safe for concurrent use: the collector feeds it from
// the goroutine that makes the snapshots.
type Tally struct {
	since     time.Time
	boot      time.Time // zero where unknown
	iface     string
	home      geo.Location
	locate    Locator
	seed      maphash.Seed
	up, down  uint64
	peakUp    float64
	peakDown  float64
	hosts     *sketch
	countries map[string]*country
	services  map[service]uint64
	farthest  Place
}

// New starts a tally at now. iface names the interface whose own counters a report includes; ""
// leaves them out.
func New(now time.Time, iface string, home geo.Location, locate Locator) *Tally {
	boot, _ := bootTime()
	return &Tally{
		since:     now,
		boot:      boot,
		iface:     iface,
		home:      home,
		locate:    locate,
		seed:      maphash.MakeSeed(),
		hosts:     newSketch(hostsPrecision),
		countries: make(map[string]*country),
		services:  make(map[service]uint64),
	}
}

// Record counts the bytes each flow moved in the tick just closed. Call it once per tick, with
// every live flow, not only those sent to the page.
func (t *Tally) Record(live []flows.Flow) {
	var up, down float64
	for _, f := range live {
		up += f.RateUp
		down += f.RateDown
		n := f.TickUp + f.TickDown
		if n == 0 {
			continue
		}
		t.up += f.TickUp
		t.down += f.TickDown
		t.services[service{f.Proto, f.Port}] += n
		addr := f.Remote.As16()
		h := maphash.Bytes(t.seed, addr[:])
		t.hosts.add(h)

		loc, ok := t.locate.Lookup(f.Remote)
		if !ok || loc.Country == "" {
			continue
		}
		c := t.countries[loc.Country]
		if c == nil {
			c = &country{hosts: newSketch(countryPrecision)}
			t.countries[loc.Country] = c
		}
		c.bytes += n
		c.hosts.add(h)
		if km := t.home.Km(loc); km > t.farthest.Km {
			t.farthest = Place{City: loc.City, CC: loc.Country, Km: km}
		}
	}
	t.peakUp = max(t.peakUp, up)
	t.peakDown = max(t.peakDown, down)
}

// Report sums up the tally so far.
func (t *Tally) Report() Report {
	r := Report{
		Since:        t.since.UnixMilli(),
		Up:           t.up,
		Down:         t.down,
		PeakUp:       math.Round(t.peakUp),
		PeakDown:     math.Round(t.peakDown),
		Hosts:        t.hosts.count(),
		Countries:    t.topCountries(),
		CountryCount: len(t.countries),
		Services:     t.topServices(),
	}
	if !t.boot.IsZero() {
		r.Boot = t.boot.UnixMilli()
	}
	if c, ok := readCounters(t.iface); ok {
		r.Iface = &c
	}
	if t.farthest.Km > 0 {
		far := t.farthest
		far.Km = math.Round(far.Km)
		r.Farthest = &far
	}
	return r
}

// topCountries lists the countries with the most traffic, then those with the most hosts that
// aren't already listed.
func (t *Tally) topCountries() []Country {
	all := make([]Country, 0, len(t.countries))
	for cc, c := range t.countries {
		all = append(all, Country{CC: cc, Bytes: c.bytes, Hosts: c.hosts.count()})
	}
	slices.SortFunc(all, func(a, b Country) int {
		return cmp.Or(cmp.Compare(b.Bytes, a.Bytes), strings.Compare(a.CC, b.CC))
	})
	byBytes := min(listed, len(all))
	rest := all[byBytes:]
	slices.SortFunc(rest, func(a, b Country) int {
		return cmp.Or(cmp.Compare(b.Hosts, a.Hosts), strings.Compare(a.CC, b.CC))
	})
	return all[:byBytes+min(listed, len(rest))]
}

func (t *Tally) topServices() []Service {
	all := make([]Service, 0, len(t.services))
	for s, bytes := range t.services {
		all = append(all, Service{Proto: s.proto.String(), Port: s.port, Bytes: bytes})
	}
	slices.SortFunc(all, func(a, b Service) int {
		return cmp.Or(cmp.Compare(b.Bytes, a.Bytes), cmp.Compare(a.Port, b.Port), strings.Compare(a.Proto, b.Proto))
	})
	return all[:min(listed, len(all))]
}
