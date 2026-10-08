package geo

import (
	"math"
	"net/netip"
	"testing"
)

func TestLookup(t *testing.T) {
	db, err := Open("../../data/dbip-city-lite.mmdb")
	if err != nil {
		t.Skipf("no database (run scripts/fetch-geo.sh): %v", err)
	}
	defer db.Close()

	loc, ok := db.Lookup(netip.MustParseAddr("1.1.1.1"))
	if !ok || loc.Country == "" || (loc.Lat == 0 && loc.Lon == 0) {
		t.Errorf("1.1.1.1: %+v, %v", loc, ok)
	}
	if _, ok := db.Lookup(netip.MustParseAddr("10.0.0.1")); ok {
		t.Error("10.0.0.1 has a location")
	}
	if again, _ := db.Lookup(netip.MustParseAddr("1.1.1.1")); again != loc {
		t.Error("cached lookup differs")
	}
}

func TestParseISO6709(t *testing.T) {
	for in, want := range map[string][2]float64{
		"+5920+01803":     {59 + 20.0/60, 18 + 3.0/60},
		"-3352+15113":     {-(33 + 52.0/60), 151 + 13.0/60},
		"+404251-0740023": {40 + 42.0/60 + 51.0/3600, -(74 + 0.0/60 + 23.0/3600)},
	} {
		lat, lon, ok := parseISO6709(in)
		if !ok || math.Abs(lat-want[0]) > 1e-9 || math.Abs(lon-want[1]) > 1e-9 {
			t.Errorf("%s: %v %v %v, want %v", in, lat, lon, ok, want)
		}
	}
}

func TestParseLatLon(t *testing.T) {
	if loc, err := ParseLatLon("59.33, 18.07"); err != nil || loc.Lat != 59.33 || loc.Lon != 18.07 {
		t.Errorf("got %+v %v", loc, err)
	}
	for _, bad := range []string{"", "59.33", "91,0", "0,181", "a,b"} {
		if _, err := ParseLatLon(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
