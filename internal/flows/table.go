// Package flows aggregates captured packets per remote host into smoothed byte rates.
package flows

import (
	"math"
	"net/netip"
	"sort"
	"sync"
	"time"

	"netstats/internal/capture"
)

// Tau is the time constant of the rate smoothing. A burst shows up within a tick and fades over a
// few seconds, which is about how long a pulse takes to cross the globe.
const Tau = 1500 * time.Millisecond

// Flow is everything known about traffic with one remote host.
type Flow struct {
	Remote    netip.Addr
	Proto     capture.Proto
	Port      uint16 // the service port: whichever end looks less ephemeral
	LocalPort uint16 // this machine's end, for finding the owning process
	FirstSeen time.Time
	LastSeen  time.Time
	TotalUp   uint64
	TotalDown uint64
	RateUp    float64       // bytes per second, smoothed
	RateDown  float64       // bytes per second, smoothed
	RTT       time.Duration // TCP handshake round trip; zero until one has been seen

	pendingUp   uint64
	pendingDown uint64
	synSent     map[uint16]time.Time // local port → when our SYN left
}

// Table holds the live flows. It is safe for concurrent use.
type Table struct {
	mu    sync.Mutex
	flows map[netip.Addr]*Flow
	idle  time.Duration
}

// New returns a table that forgets a host once it has been quiet for idle.
func New(idle time.Duration) *Table {
	return &Table{flows: make(map[netip.Addr]*Flow), idle: idle}
}

// Add counts one packet. Packets to or from non-routable addresses are ignored.
func (t *Table) Add(p capture.Packet) {
	if !capture.Routable(p.Remote) {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	f := t.flows[p.Remote]
	if f == nil {
		f = &Flow{Remote: p.Remote, FirstSeen: p.Time}
		t.flows[p.Remote] = f
	}
	f.LastSeen = p.Time
	f.Proto = p.Proto
	f.LocalPort = p.LocalPort
	if p.RemotePort != 0 && (p.LocalPort == 0 || p.RemotePort <= p.LocalPort) {
		f.Port = p.RemotePort
	} else {
		f.Port = p.LocalPort
	}

	n := uint64(p.Len)
	if p.Dir == capture.Up {
		f.TotalUp += n
		f.pendingUp += n
	} else {
		f.TotalDown += n
		f.pendingDown += n
	}

	if p.Proto != capture.ProtoTCP || !p.SYN {
		return
	}
	switch {
	case p.Dir == capture.Up && !p.ACK:
		if f.synSent == nil {
			f.synSent = make(map[uint16]time.Time)
		}
		f.synSent[p.LocalPort] = p.Time
	case p.Dir == capture.Down && p.ACK:
		sent, ok := f.synSent[p.LocalPort]
		if !ok {
			return
		}
		delete(f.synSent, p.LocalPort)
		sample := p.Time.Sub(sent)
		if f.RTT == 0 {
			f.RTT = sample
		} else {
			f.RTT = (f.RTT*4 + sample) / 5
		}
	}
}

// Tick folds the bytes counted since the previous tick into the smoothed rates and drops hosts that
// have gone quiet. Call it on a steady interval of dt.
func (t *Table) Tick(now time.Time, dt time.Duration) {
	alpha := 1 - math.Exp(-dt.Seconds()/Tau.Seconds())
	t.mu.Lock()
	defer t.mu.Unlock()
	for ip, f := range t.flows {
		if now.Sub(f.LastSeen) > t.idle {
			delete(t.flows, ip)
			continue
		}
		f.RateUp += alpha * (float64(f.pendingUp)/dt.Seconds() - f.RateUp)
		f.RateDown += alpha * (float64(f.pendingDown)/dt.Seconds() - f.RateDown)
		f.pendingUp, f.pendingDown = 0, 0
		for port, sent := range f.synSent {
			if now.Sub(sent) > 10*time.Second {
				delete(f.synSent, port) // the handshake never completed
			}
		}
	}
}

// Snapshot returns a copy of every live flow, busiest first.
func (t *Table) Snapshot() []Flow {
	t.mu.Lock()
	out := make([]Flow, 0, len(t.flows))
	for _, f := range t.flows {
		c := *f
		c.synSent = nil
		out = append(out, c)
	}
	t.mu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		return out[i].RateUp+out[i].RateDown > out[j].RateUp+out[j].RateDown
	})
	return out
}
