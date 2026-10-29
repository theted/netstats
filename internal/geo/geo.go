// Package geo places IP addresses on the map with a local DB-IP (or MaxMind) City database.
package geo

import (
	"bufio"
	"fmt"
	"math"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/oschwald/maxminddb-golang/v2"
)

// Location is where an address is registered. Anycast and CDN addresses resolve to wherever the
// provider registered them, not to the edge that actually answered.
type Location struct {
	Lat, Lon float64
	City     string
	Country  string // ISO 3166-1 alpha-2
}

type record struct {
	City struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"city"`
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"country"`
	Location struct {
		Latitude  *float64 `maxminddb:"latitude"`
		Longitude *float64 `maxminddb:"longitude"`
	} `maxminddb:"location"`
}

// earthKm is the Earth's mean radius.
const earthKm = 6371.0

// Km is the great-circle distance to b: the shortest way round the globe, as a plane would fly it.
func (a Location) Km(b Location) float64 {
	rad := math.Pi / 180
	dLat := (b.Lat - a.Lat) * rad
	dLon := (b.Lon - a.Lon) * rad
	h := math.Pow(math.Sin(dLat/2), 2) + math.Cos(a.Lat*rad)*math.Cos(b.Lat*rad)*math.Pow(math.Sin(dLon/2), 2)
	return 2 * earthKm * math.Asin(math.Sqrt(min(h, 1)))
}

// cacheLimit bounds the lookup cache; it is simply cleared when full.
const cacheLimit = 20000

// DB is an open City database with a lookup cache. It is safe for concurrent use.
type DB struct {
	r     *maxminddb.Reader
	mu    sync.Mutex
	cache map[netip.Addr]*Location // nil entry: looked up, not found
}

func Open(path string) (*DB, error) {
	r, err := maxminddb.Open(path)
	if err != nil {
		return nil, err
	}
	return &DB{r: r, cache: make(map[netip.Addr]*Location)}, nil
}

func (d *DB) Close() error { return d.r.Close() }

// Lookup returns the location of ip, or false if the database has no coordinates for it.
func (d *DB) Lookup(ip netip.Addr) (Location, bool) {
	d.mu.Lock()
	loc, cached := d.cache[ip]
	d.mu.Unlock()
	if !cached {
		loc = d.lookup(ip)
		d.mu.Lock()
		if len(d.cache) >= cacheLimit {
			clear(d.cache)
		}
		d.cache[ip] = loc
		d.mu.Unlock()
	}
	if loc == nil {
		return Location{}, false
	}
	return *loc, true
}

func (d *DB) lookup(ip netip.Addr) *Location {
	var rec record
	if err := d.r.Lookup(ip).Decode(&rec); err != nil {
		return nil
	}
	if rec.Location.Latitude == nil || rec.Location.Longitude == nil {
		return nil
	}
	return &Location{
		Lat:     *rec.Location.Latitude,
		Lon:     *rec.Location.Longitude,
		City:    rec.City.Names["en"],
		Country: rec.Country.ISOCode,
	}
}

// ParseLatLon reads "59.33,18.07".
func ParseLatLon(s string) (Location, error) {
	a, b, ok := strings.Cut(s, ",")
	if !ok {
		return Location{}, fmt.Errorf("want lat,lon, got %q", s)
	}
	lat, err1 := strconv.ParseFloat(strings.TrimSpace(a), 64)
	lon, err2 := strconv.ParseFloat(strings.TrimSpace(b), 64)
	if err1 != nil || err2 != nil || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return Location{}, fmt.Errorf("want lat,lon in degrees, got %q", s)
	}
	return Location{Lat: lat, Lon: lon}, nil
}

// FromTimeZone places this machine at the reference city of its time zone, read from
// /etc/localtime and the tz database's zone.tab. It is the fallback when no interface has a public
// address to look up — the usual case behind a NAT without IPv6.
func FromTimeZone() (Location, bool) {
	target, err := os.Readlink("/etc/localtime")
	if err != nil {
		return Location{}, false
	}
	_, zone, ok := strings.Cut(target, "zoneinfo/")
	if !ok {
		return Location{}, false
	}
	for _, tab := range []string{"/usr/share/zoneinfo/zone.tab", "/usr/share/zoneinfo/zone1970.tab"} {
		if loc, ok := scanZoneTab(tab, filepath.Clean(zone)); ok {
			return loc, true
		}
	}
	return Location{}, false
}

func scanZoneTab(path, zone string) (Location, bool) {
	f, err := os.Open(path)
	if err != nil {
		return Location{}, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		cols := strings.Split(sc.Text(), "\t")
		if len(cols) < 3 || cols[2] != zone {
			continue
		}
		lat, lon, ok := parseISO6709(cols[1])
		if !ok {
			return Location{}, false
		}
		return Location{Lat: lat, Lon: lon, City: strings.ReplaceAll(filepath.Base(zone), "_", " ")}, true
	}
	return Location{}, false
}

// parseISO6709 reads zone.tab coordinates: ±DDMM±DDDMM or ±DDMMSS±DDDMMSS.
func parseISO6709(s string) (lat, lon float64, ok bool) {
	split := strings.LastIndexAny(s, "+-")
	if split <= 0 {
		return 0, 0, false
	}
	lat, ok1 := dms(s[:split], 2)
	lon, ok2 := dms(s[split:], 3)
	return lat, lon, ok1 && ok2
}

func dms(s string, degDigits int) (float64, bool) {
	if len(s) < 1+degDigits+2 {
		return 0, false
	}
	sign := 1.0
	if s[0] == '-' {
		sign = -1
	}
	digits := s[1:]
	var parts [3]float64
	widths := []int{degDigits, 2, 2}
	for i, w := range widths {
		if len(digits) == 0 {
			break
		}
		if len(digits) < w {
			return 0, false
		}
		v, err := strconv.Atoi(digits[:w])
		if err != nil {
			return 0, false
		}
		parts[i] = float64(v)
		digits = digits[w:]
	}
	return sign * (parts[0] + parts[1]/60 + parts[2]/3600), true
}
