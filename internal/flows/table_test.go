package flows

import (
	"math"
	"net/netip"
	"testing"
	"time"

	"netstats/internal/capture"
)

var remote = netip.MustParseAddr("1.1.1.1")

func pkt(at time.Time, dir capture.Dir, n int) capture.Packet {
	return capture.Packet{Time: at, Remote: remote, Proto: capture.ProtoTCP, LocalPort: 50000, RemotePort: 443, Dir: dir, Len: n}
}

func TestRateConverges(t *testing.T) {
	tab := New(30 * time.Second)
	now := time.Unix(1000, 0)
	for range 40 { // ten seconds at 4 Hz, 25 kB down and 1 kB up per tick
		tab.Add(pkt(now, capture.Down, 25000))
		tab.Add(pkt(now, capture.Up, 1000))
		now = now.Add(250 * time.Millisecond)
		tab.Tick(now, 250*time.Millisecond)
	}
	f := tab.Snapshot()[0]
	if math.Abs(f.RateDown-100000) > 2000 || math.Abs(f.RateUp-4000) > 100 {
		t.Errorf("rates up %.0f down %.0f, want about 4000 and 100000", f.RateUp, f.RateDown)
	}
	if f.TotalDown != 40*25000 || f.Port != 443 {
		t.Errorf("total %d port %d", f.TotalDown, f.Port)
	}
}

func TestIgnoresNonRoutable(t *testing.T) {
	tab := New(30 * time.Second)
	p := pkt(time.Unix(1000, 0), capture.Down, 100)
	p.Remote = netip.MustParseAddr("172.17.0.2")
	tab.Add(p)
	if n := len(tab.Snapshot()); n != 0 {
		t.Errorf("%d flows, want 0", n)
	}
}

func TestEvictsIdle(t *testing.T) {
	tab := New(5 * time.Second)
	now := time.Unix(1000, 0)
	tab.Add(pkt(now, capture.Down, 100))
	tab.Tick(now.Add(4*time.Second), time.Second)
	if len(tab.Snapshot()) != 1 {
		t.Fatal("evicted too early")
	}
	tab.Tick(now.Add(6*time.Second), time.Second)
	if len(tab.Snapshot()) != 0 {
		t.Fatal("not evicted")
	}
}

func TestHandshakeRTT(t *testing.T) {
	tab := New(30 * time.Second)
	now := time.Unix(1000, 0)
	syn := pkt(now, capture.Up, 60)
	syn.SYN = true
	synAck := pkt(now.Add(30*time.Millisecond), capture.Down, 60)
	synAck.SYN, synAck.ACK = true, true
	tab.Add(syn)
	tab.Add(synAck)
	if rtt := tab.Snapshot()[0].RTT; rtt != 30*time.Millisecond {
		t.Errorf("rtt %v, want 30ms", rtt)
	}
}

func TestTickBytes(t *testing.T) {
	tab := New(30 * time.Second)
	now := time.Unix(1000, 0)
	tab.Add(pkt(now, capture.Down, 1500))
	tab.Add(pkt(now, capture.Down, 500))
	tab.Add(pkt(now, capture.Up, 60))
	now = now.Add(250 * time.Millisecond)
	tab.Tick(now, 250*time.Millisecond)
	if f := tab.Snapshot()[0]; f.TickDown != 2000 || f.TickUp != 60 {
		t.Errorf("first tick: up %d down %d, want 60 and 2000", f.TickUp, f.TickDown)
	}
	tab.Tick(now.Add(250*time.Millisecond), 250*time.Millisecond)
	if f := tab.Snapshot()[0]; f.TickDown != 0 || f.TickUp != 0 {
		t.Errorf("quiet tick: up %d down %d, want 0 and 0", f.TickUp, f.TickDown)
	}
}
