// Package names learns host names by watching DNS answers go past, so an address can be labelled
// with the name an application actually asked for rather than a reverse-DNS PTR record.
package names

import (
	"net/netip"
	"strings"
	"sync"

	"github.com/gopacket/gopacket"
	"github.com/gopacket/gopacket/layers"

	"netstats/internal/capture"
)

// Filter selects DNS responses. Sniffing the "any" device sees both the upstream answers on the
// uplink and systemd-resolved's stub answers on lo, so cached lookups are learned too.
const Filter = "udp src port 53"

// limit bounds the table; it is simply cleared when full.
const limit = 50000

// Names maps addresses to the name last resolved to them. It is safe for concurrent use.
type Names struct {
	mu sync.RWMutex
	m  map[netip.Addr]string
}

func New() *Names { return &Names{m: make(map[netip.Addr]string)} }

// Lookup returns the name last resolved to ip, or "".
func (n *Names) Lookup(ip netip.Addr) string {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.m[ip]
}

// Observe records the A and AAAA answers of a DNS response under the name in its question. The
// question is used rather than the answer's owner name because a CNAME chain ends at something like
// e1234.a.akamaiedge.net, and the name worth showing is the one that was asked for.
func (n *Names) Observe(msg *layers.DNS) {
	if !msg.QR || len(msg.Questions) == 0 {
		return
	}
	name := strings.TrimSuffix(string(msg.Questions[0].Name), ".")
	if name == "" {
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, a := range msg.Answers {
		if a.Type != layers.DNSTypeA && a.Type != layers.DNSTypeAAAA {
			continue
		}
		ip, ok := netip.AddrFromSlice(a.IP)
		if !ok {
			continue
		}
		if len(n.m) >= limit {
			clear(n.m)
		}
		n.m[ip.Unmap()] = name
	}
}

// Sniff feeds every DNS response read from src into n. It returns when src is closed.
func Sniff(src *capture.Source, n *Names) error {
	link := src.LinkType()
	for {
		data, _, err := src.Read()
		if err != nil {
			return err
		}
		pkt := gopacket.NewPacket(data, link, gopacket.DecodeOptions{Lazy: true, NoCopy: true})
		if l, ok := pkt.Layer(layers.LayerTypeDNS).(*layers.DNS); ok {
			n.Observe(l)
		}
	}
}
