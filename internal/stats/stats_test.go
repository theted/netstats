package stats

import (
	"encoding/binary"
	"hash/maphash"
	"math"
	"net/netip"
	"strings"
	"testing"
	"time"

	"netstats/internal/capture"
	"netstats/internal/flows"
	"netstats/internal/geo"
)

func TestSketchCounts(t *testing.T) {
	seed := maphash.MakeSeed()
	for _, n := range []int{0, 1, 40, 1000, 30000, 200000} {
		s := newSketch(hostsPrecision)
		var b [8]byte
		for i := range n {
			binary.LittleEndian.PutUint64(b[:], uint64(i))
			h := maphash.Bytes(seed, b[:])
			s.add(h)
			s.add(h) // a host seen again is the same host
		}
		got := float64(s.count())
		if tol := math.Max(1, float64(n)*0.03); math.Abs(got-float64(n)) > tol {
			t.Errorf("%d distinct: counted %.0f", n, got)
		}
	}
}

// places puts 203.0.113.x in Germany and 198.51.100.x in Australia; anything else is off the map.
type places struct{}

func (places) Lookup(ip netip.Addr) (geo.Location, bool) {
	switch {
	case netip.MustParsePrefix("203.0.113.0/24").Contains(ip):
		return geo.Location{Lat: 52.52, Lon: 13.40, City: "Berlin", Country: "DE"}, true
	case netip.MustParsePrefix("198.51.100.0/24").Contains(ip):
		return geo.Location{Lat: -33.87, Lon: 151.21, City: "Sydney", Country: "AU"}, true
	}
	return geo.Location{}, false
}

func flow(addr string, proto capture.Proto, port uint16, up, down uint64) flows.Flow {
	return flows.Flow{
		Remote: netip.MustParseAddr(addr), Proto: proto, Port: port,
		TickUp: up, TickDown: down, RateUp: float64(up) * 4, RateDown: float64(down) * 4,
	}
}

func TestTally(t *testing.T) {
	stockholm := geo.Location{Lat: 59.33, Lon: 18.07}
	start := time.Unix(1000, 0)
	tally := New(start, "", stockholm, places{})
	tally.Record([]flows.Flow{
		flow("203.0.113.1", capture.ProtoTCP, 443, 100, 5000),
		flow("203.0.113.2", capture.ProtoTCP, 443, 100, 1000),
		flow("198.51.100.1", capture.ProtoUDP, 443, 50, 20000),
		flow("192.0.2.1", capture.ProtoTCP, 22, 10, 10), // off the map
	})
	tally.Record([]flows.Flow{
		flow("203.0.113.1", capture.ProtoTCP, 443, 0, 1000),
		flow("203.0.113.2", capture.ProtoTCP, 443, 0, 0), // quiet this tick
	})
	r := tally.Report()

	if r.Since != start.UnixMilli() || r.Up != 260 || r.Down != 27010 || r.Hosts != 4 {
		t.Errorf("since %d up %d down %d hosts %d, want %d 260 27010 4", r.Since, r.Up, r.Down, r.Hosts, start.UnixMilli())
	}
	if r.PeakDown != 26010*4 || r.PeakUp != 260*4 {
		t.Errorf("peaks up %.0f down %.0f", r.PeakUp, r.PeakDown)
	}
	if r.CountryCount != 2 || len(r.Countries) != 2 ||
		r.Countries[0] != (Country{CC: "AU", Bytes: 20050, Hosts: 1}) ||
		r.Countries[1] != (Country{CC: "DE", Bytes: 7200, Hosts: 2}) {
		t.Errorf("countries %+v (%d)", r.Countries, r.CountryCount)
	}
	want := []Service{{"udp", 443, 20050}, {"tcp", 443, 7200}, {"tcp", 22, 20}}
	if len(r.Services) != len(want) {
		t.Fatalf("services %+v", r.Services)
	}
	for i := range want {
		if r.Services[i] != want[i] {
			t.Errorf("service %d: %+v, want %+v", i, r.Services[i], want[i])
		}
	}
	if r.Farthest == nil || r.Farthest.City != "Sydney" || math.Abs(r.Farthest.Km-15580) > 160 {
		t.Errorf("farthest %+v", r.Farthest)
	}
	if r.Iface != nil {
		t.Errorf("iface %+v with no interface named", r.Iface)
	}
}

// With more countries than fit, the list holds the busiest by traffic and then by hosts.
func TestTopCountriesByEitherRanking(t *testing.T) {
	tally := New(time.Unix(1000, 0), "", geo.Location{}, places{})
	for i := range listed + 3 {
		cc := string(rune('A'+i)) + "X"
		tally.countries[cc] = &country{bytes: uint64(1000 - i), hosts: newSketch(countryPrecision)}
	}
	quiet := tally.countries["KX"] // last by traffic, so first by hosts only
	for i := range 50 {
		quiet.hosts.add(maphash.String(tally.seed, string(rune(i))))
	}
	got := tally.Report().Countries
	if len(got) != listed+3 || got[0].CC != "AX" || got[listed].CC != "KX" || got[listed].Hosts < 47 {
		t.Errorf("countries %+v", got)
	}
}

func TestParseNetDev(t *testing.T) {
	const dev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  123456     100    0    0    0     0          0         0   123456     100    0    0    0     0       0          0
  ens5:987654321 654321    0    0    0     0          0         0 12345678   9876    0    0    0     0       0          0
`
	if c, ok := parseNetDev(strings.NewReader(dev), "ens5"); !ok || c != (Counters{Name: "ens5", Up: 12345678, Down: 987654321}) {
		t.Errorf("ens5: %+v %v", c, ok)
	}
	if _, ok := parseNetDev(strings.NewReader(dev), "eth0"); ok {
		t.Error("found eth0, which isn't there")
	}
}

func TestParseBootTime(t *testing.T) {
	const stat = "cpu  1 2 3 4\nintr 5\nctxt 6\nbtime 1761700000\nprocesses 7\n"
	if boot, ok := parseBootTime(strings.NewReader(stat)); !ok || boot.Unix() != 1761700000 {
		t.Errorf("boot %v %v", boot, ok)
	}
}
