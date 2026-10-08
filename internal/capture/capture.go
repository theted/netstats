// Package capture reads packets off an interface with libpcap and reduces each one to the few
// facts the globe needs: which remote host, which way, how many bytes.
package capture

import (
	"fmt"
	"net/netip"
	"time"

	"github.com/gopacket/gopacket"
	"github.com/gopacket/gopacket/layers"
	"github.com/gopacket/gopacket/pcap"
)

// Snaplen is enough for an Ethernet or SLL header, an IPv6 header and a TCP header with a full set
// of options. Nothing past the transport header is ever captured.
const Snaplen = 128

type Proto uint8

const (
	ProtoOther Proto = iota
	ProtoTCP
	ProtoUDP
)

func (p Proto) String() string {
	switch p {
	case ProtoTCP:
		return "tcp"
	case ProtoUDP:
		return "udp"
	}
	return "ip"
}

// Dir is the direction of a packet relative to this machine.
type Dir uint8

const (
	Up   Dir = iota // sent by this machine
	Down            // received by this machine
)

// Packet is one captured packet, seen from this machine's side.
type Packet struct {
	Time       time.Time
	Local      netip.Addr
	Remote     netip.Addr
	LocalPort  uint16
	RemotePort uint16
	Proto      Proto
	Dir        Dir
	Len        int // IP-level length: header plus payload, as it went over the wire
	SYN, ACK   bool
}

// Source is an open pcap handle.
type Source struct {
	h *pcap.Handle
}

// Open starts capturing on iface. It needs CAP_NET_RAW and CAP_NET_ADMIN.
func Open(iface string, snaplen int32, filter string) (*Source, error) {
	h, err := pcap.OpenLive(iface, snaplen, false, pcap.BlockForever)
	if err != nil {
		return nil, err
	}
	if filter != "" {
		if err := h.SetBPFFilter(filter); err != nil {
			h.Close()
			return nil, fmt.Errorf("setting filter %q: %w", filter, err)
		}
	}
	return &Source{h: h}, nil
}

func (s *Source) LinkType() layers.LinkType { return s.h.LinkType() }

// Read returns the next frame. The slice is only valid until the next call.
func (s *Source) Read() ([]byte, gopacket.CaptureInfo, error) {
	return s.h.ZeroCopyReadPacketData()
}

// Close stops the capture and wakes a blocked Read.
func (s *Source) Close() { s.h.Close() }

// Decoder turns raw frames into Packets without allocating. It reuses its layer structs, so it is not
// safe for concurrent use.
type Decoder struct {
	link    *gopacket.DecodingLayerParser // starts at the link layer
	ip4     *gopacket.DecodingLayerParser // for raw-IP links (tun, wireguard)
	ip6     *gopacket.DecodingLayerParser
	decoded []gopacket.LayerType
	isLocal func(netip.Addr) bool

	eth  layers.Ethernet
	sll  layers.LinuxSLL
	sll2 layers.LinuxSLL2
	v4   layers.IPv4
	v6   layers.IPv6
	tcp  layers.TCP
	udp  layers.UDP
}

// NewDecoder returns a decoder for frames of the given link type. isLocal decides which end of a
// packet is this machine; a packet with neither end local is dropped.
func NewDecoder(link layers.LinkType, isLocal func(netip.Addr) bool) (*Decoder, error) {
	d := &Decoder{isLocal: isLocal, decoded: make([]gopacket.LayerType, 0, 4)}
	all := []gopacket.DecodingLayer{&d.eth, &d.sll, &d.sll2, &d.v4, &d.v6, &d.tcp, &d.udp}
	parser := func(first gopacket.LayerType) *gopacket.DecodingLayerParser {
		p := gopacket.NewDecodingLayerParser(first, all...)
		p.IgnoreUnsupported = true
		return p
	}
	d.ip4 = parser(layers.LayerTypeIPv4)
	d.ip6 = parser(layers.LayerTypeIPv6)
	switch link {
	case layers.LinkTypeEthernet:
		d.link = parser(layers.LayerTypeEthernet)
	case layers.LinkTypeLinuxSLL:
		d.link = parser(layers.LayerTypeLinuxSLL)
	case layers.LinkTypeLinuxSLL2:
		d.link = parser(layers.LayerTypeLinuxSLL2)
	case layers.LinkTypeRaw, layers.LinkTypeIPv4, layers.LinkTypeIPv6:
		// chosen per packet from the IP version nibble
	default:
		return nil, fmt.Errorf("unsupported link type %v", link)
	}
	return d, nil
}

// Decode reduces one frame to a Packet. It reports false for anything that isn't IP traffic between
// this machine and another host.
func (d *Decoder) Decode(data []byte, ci gopacket.CaptureInfo) (Packet, bool) {
	p := d.link
	if p == nil {
		if len(data) == 0 {
			return Packet{}, false
		}
		switch data[0] >> 4 {
		case 4:
			p = d.ip4
		case 6:
			p = d.ip6
		default:
			return Packet{}, false
		}
	}
	// Errors are expected: frames are cut at Snaplen, so the transport layer may be partial. Whatever
	// decoded before the error is still good.
	_ = p.DecodeLayers(data, &d.decoded)

	var pkt Packet
	var src, dst netip.Addr
	var sport, dport uint16
	for _, lt := range d.decoded {
		switch lt {
		case layers.LayerTypeIPv4:
			src, _ = netip.AddrFromSlice(d.v4.SrcIP)
			dst, _ = netip.AddrFromSlice(d.v4.DstIP)
			pkt.Len = int(d.v4.Length)
		case layers.LayerTypeIPv6:
			src, _ = netip.AddrFromSlice(d.v6.SrcIP)
			dst, _ = netip.AddrFromSlice(d.v6.DstIP)
			pkt.Len = int(d.v6.Length) + 40
		case layers.LayerTypeTCP:
			pkt.Proto = ProtoTCP
			sport, dport = uint16(d.tcp.SrcPort), uint16(d.tcp.DstPort)
			pkt.SYN, pkt.ACK = d.tcp.SYN, d.tcp.ACK
		case layers.LayerTypeUDP:
			pkt.Proto = ProtoUDP
			sport, dport = uint16(d.udp.SrcPort), uint16(d.udp.DstPort)
		}
	}
	if !src.IsValid() || !dst.IsValid() {
		return Packet{}, false
	}
	src, dst = src.Unmap(), dst.Unmap()

	switch {
	case d.isLocal(src):
		pkt.Dir, pkt.Local, pkt.Remote, pkt.LocalPort, pkt.RemotePort = Up, src, dst, sport, dport
	case d.isLocal(dst):
		pkt.Dir, pkt.Local, pkt.Remote, pkt.LocalPort, pkt.RemotePort = Down, dst, src, dport, sport
	default:
		return Packet{}, false
	}
	pkt.Time = ci.Timestamp
	return pkt, true
}
