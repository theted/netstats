package main

import (
	"bytes"
	"encoding/json"
	"net/netip"
	"testing"
	"time"

	"netstats/internal/capture"
	"netstats/internal/flows"
	"netstats/internal/geo"
	"netstats/internal/names"
	"netstats/internal/stats"
)

type berlin struct{}

func (berlin) Lookup(netip.Addr) (geo.Location, bool) {
	return geo.Location{Lat: 52.52, Lon: 13.40, City: "Berlin", Country: "DE"}, true
}

var addrs = []string{"203.0.113.7", "2001:db8::42"}

func live() []flows.Flow {
	var fs []flows.Flow
	for _, a := range addrs {
		fs = append(fs, flows.Flow{Remote: netip.MustParseAddr(a), Proto: capture.ProtoTCP, Port: 443, RateUp: 100, RateDown: 2000, TickUp: 25, TickDown: 500})
	}
	return fs
}

func TestPublicSnapshotWithholdsAddresses(t *testing.T) {
	s := sources{db: berlin{}, names: names.New(), maxFlows: 300, public: true, idFor: hashedIDs()}
	now := time.Unix(1000, 0)
	first := s.snapshot(now, live())
	tally := stats.New(now, "", s.home, s.db)
	tally.Record(live())
	report := tally.Report()
	first.Stats = &report
	msg, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(msg, []byte(`"ip"`)) {
		t.Errorf(`snapshot has an "ip" field: %s`, msg)
	}
	for _, a := range addrs {
		if bytes.Contains(msg, []byte(a)) {
			t.Errorf("snapshot gives away %s: %s", a, msg)
		}
	}
	if !bytes.Contains(msg, []byte(`"hosts":2`)) {
		t.Errorf("stats don't count the two hosts: %s", msg)
	}
	if !first.Public || len(first.Flows) != 2 || first.Flows[0].ID == first.Flows[1].ID {
		t.Fatalf("want two flows with distinct ids in a public snapshot, got %+v", first)
	}
	next := s.snapshot(now.Add(time.Second), live())
	for i := range next.Flows {
		if next.Flows[i].ID != first.Flows[i].ID {
			t.Errorf("flow %d changed id between snapshots: %s, then %s", i, first.Flows[i].ID, next.Flows[i].ID)
		}
	}
}

func TestLocalSnapshotKeepsAddresses(t *testing.T) {
	s := sources{db: berlin{}, names: names.New(), maxFlows: 1, idFor: addrID}
	snap := s.snapshot(time.Unix(1000, 0), live())
	if snap.Public || len(snap.Flows) != 1 {
		t.Fatalf("want one flow (capped) in a local snapshot, got %+v", snap)
	}
	if f := snap.Flows[0]; f.IP != addrs[0] || f.ID != addrs[0] {
		t.Errorf("id %q ip %q, want both %s", f.ID, f.IP, addrs[0])
	}
}
