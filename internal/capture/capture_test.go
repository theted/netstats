package capture

import (
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/gopacket/gopacket"
	"github.com/gopacket/gopacket/layers"
)

var (
	local4 = netip.MustParseAddr("192.168.1.20")
	local6 = netip.MustParseAddr("2a02:aa1::20")
)

func isLocal(ip netip.Addr) bool { return ip == local4 || ip == local6 }

func frame(t *testing.T, ip gopacket.SerializableLayer, transport gopacket.SerializableLayer, payload int) []byte {
	t.Helper()
	eth := &layers.Ethernet{
		SrcMAC:       net.HardwareAddr{2, 0, 0, 0, 0, 1},
		DstMAC:       net.HardwareAddr{2, 0, 0, 0, 0, 2},
		EthernetType: layers.EthernetTypeIPv4,
	}
	if _, ok := ip.(*layers.IPv6); ok {
		eth.EthernetType = layers.EthernetTypeIPv6
	}
	if nl, ok := transport.(interface {
		SetNetworkLayerForChecksum(gopacket.NetworkLayer) error
	}); ok {
		nl.SetNetworkLayerForChecksum(ip.(gopacket.NetworkLayer))
	}
	buf := gopacket.NewSerializeBuffer()
	opts := gopacket.SerializeOptions{FixLengths: true, ComputeChecksums: true}
	if err := gopacket.SerializeLayers(buf, opts, eth, ip, transport, gopacket.Payload(make([]byte, payload))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func decode(t *testing.T, data []byte) (Packet, bool) {
	t.Helper()
	d, err := NewDecoder(layers.LinkTypeEthernet, isLocal)
	if err != nil {
		t.Fatal(err)
	}
	return d.Decode(data, gopacket.CaptureInfo{Timestamp: time.Unix(100, 0), CaptureLength: len(data), Length: len(data)})
}

func TestDecodeOutgoingTCPSyn(t *testing.T) {
	data := frame(t,
		&layers.IPv4{Version: 4, TTL: 64, Protocol: layers.IPProtocolTCP, SrcIP: local4.AsSlice(), DstIP: net.IPv4(1, 1, 1, 1)},
		&layers.TCP{SrcPort: 50000, DstPort: 443, SYN: true},
		0)
	p, ok := decode(t, data)
	if !ok {
		t.Fatal("not decoded")
	}
	if p.Dir != Up || p.Remote != netip.MustParseAddr("1.1.1.1") || p.Local != local4 {
		t.Errorf("got dir %v remote %v local %v", p.Dir, p.Remote, p.Local)
	}
	if p.Proto != ProtoTCP || p.LocalPort != 50000 || p.RemotePort != 443 || !p.SYN || p.ACK {
		t.Errorf("got %+v", p)
	}
	if p.Len != 40 {
		t.Errorf("len %d, want 40", p.Len)
	}
}

func TestDecodeIncomingUDPv6(t *testing.T) {
	remote := netip.MustParseAddr("2606:4700::1111")
	data := frame(t,
		&layers.IPv6{Version: 6, HopLimit: 64, NextHeader: layers.IPProtocolUDP, SrcIP: remote.AsSlice(), DstIP: local6.AsSlice()},
		&layers.UDP{SrcPort: 443, DstPort: 5555},
		100)
	p, ok := decode(t, data)
	if !ok {
		t.Fatal("not decoded")
	}
	if p.Dir != Down || p.Remote != remote || p.Proto != ProtoUDP || p.LocalPort != 5555 || p.RemotePort != 443 {
		t.Errorf("got %+v", p)
	}
	if p.Len != 40+8+100 {
		t.Errorf("len %d, want %d", p.Len, 40+8+100)
	}
}

// A frame cut short at Snaplen must still count the bytes the IP header says went over the wire.
func TestDecodeTruncatedKeepsWireLength(t *testing.T) {
	data := frame(t,
		&layers.IPv4{Version: 4, TTL: 64, Protocol: layers.IPProtocolTCP, SrcIP: net.IPv4(1, 1, 1, 1), DstIP: local4.AsSlice()},
		&layers.TCP{SrcPort: 443, DstPort: 50000, ACK: true},
		1400)
	p, ok := decode(t, data[:Snaplen])
	if !ok {
		t.Fatal("not decoded")
	}
	if p.Dir != Down || p.Len != 20+20+1400 {
		t.Errorf("dir %v len %d, want down %d", p.Dir, p.Len, 1440)
	}
}

func TestDecodeDropsTransitTraffic(t *testing.T) {
	data := frame(t,
		&layers.IPv4{Version: 4, TTL: 64, Protocol: layers.IPProtocolUDP, SrcIP: net.IPv4(8, 8, 8, 8), DstIP: net.IPv4(1, 1, 1, 1)},
		&layers.UDP{SrcPort: 53, DstPort: 53},
		10)
	if _, ok := decode(t, data); ok {
		t.Error("packet between two remote hosts was decoded")
	}
}

func TestRoutable(t *testing.T) {
	for addr, want := range map[string]bool{
		"1.1.1.1":         true,
		"::ffff:1.1.1.1":  true,
		"2606:4700::1111": true,
		"10.0.0.1":        false,
		"172.17.0.2":      false,
		"192.168.1.1":     false,
		"100.100.1.1":     false,
		"127.0.0.1":       false,
		"169.254.1.1":     false,
		"224.0.0.251":     false,
		"fe80::1":         false,
		"fd00::1":         false,
		"ff02::fb":        false,
		"::1":             false,
		"0.0.0.0":         false,
		"255.255.255.255": false,
	} {
		if got := Routable(netip.MustParseAddr(addr)); got != want {
			t.Errorf("Routable(%s) = %v, want %v", addr, got, want)
		}
	}
}
