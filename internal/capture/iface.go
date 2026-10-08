package capture

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
)

// DefaultInterface returns the interface that carries the IPv4 default route, preferring the lowest
// metric when there are several (wired and wireless both up, say).
func DefaultInterface() (string, error) {
	f, err := os.Open("/proc/net/route")
	if err != nil {
		return "", err
	}
	defer f.Close()

	best, bestMetric := "", -1
	sc := bufio.NewScanner(f)
	sc.Scan() // header: Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
	for sc.Scan() {
		cols := strings.Fields(sc.Text())
		if len(cols) < 8 || cols[1] != "00000000" || cols[7] != "00000000" {
			continue
		}
		metric, err := strconv.Atoi(cols[6])
		if err != nil {
			continue
		}
		if bestMetric < 0 || metric < bestMetric {
			best, bestMetric = cols[0], metric
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	if best == "" {
		return "", errors.New("no default route in /proc/net/route")
	}
	return best, nil
}

// LocalAddrs returns every address assigned to any interface on this machine. IPv6 privacy
// addresses rotate and DHCP leases change, so callers should refresh it now and then.
func LocalAddrs() (map[netip.Addr]bool, error) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, fmt.Errorf("listing interface addresses: %w", err)
	}
	set := make(map[netip.Addr]bool, len(addrs))
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		if ip, ok := netip.AddrFromSlice(ipn.IP); ok {
			set[ip.Unmap()] = true
		}
	}
	return set, nil
}

// Routable reports whether an address belongs to the public internet, as opposed to this machine,
// the LAN, a docker bridge, a CGNAT/tailnet range or a multicast group. Only routable addresses
// can be put on a map.
func Routable(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsValid() &&
		ip.IsGlobalUnicast() &&
		!ip.IsPrivate() &&
		!cgnat.Contains(ip)
}

var cgnat = netip.MustParsePrefix("100.64.0.0/10")
