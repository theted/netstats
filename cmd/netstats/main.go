// netstats captures this machine's traffic and streams it, per remote host and placed on the map,
// to a three.js globe in the browser.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"netstats/internal/capture"
	"netstats/internal/flows"
	"netstats/internal/geo"
	"netstats/internal/names"
	"netstats/internal/procs"
	"netstats/internal/server"
	"netstats/web"
)

func main() {
	var (
		iface   = flag.String("iface", "", "interface to capture on (default: the one carrying the default route)")
		addr    = flag.String("addr", "127.0.0.1:7777", "address to serve the globe on")
		geoPath = flag.String("geo", "data/dbip-city-lite.mmdb", "DB-IP or MaxMind City database (.mmdb)")
		homeArg = flag.String("home", "", "this machine's location as lat,lon, or a public address to geolocate\n(default: geolocate a public address on an interface, else use the time zone)")
		webDir  = flag.String("web", "", "serve the frontend from `dir` (e.g. web/dist) instead of the copy built in, so a frontend change\nonly needs npm run build and a reload, not a rebuild and a new setcap grant")
		public  = flag.Bool("public", false, "for a page shown to strangers: identify hosts by an opaque id instead of their address,\nand leave out process names")
		tick    = flag.Duration("tick", 250*time.Millisecond, "how often to send a snapshot to the browser")
		maxFlow = flag.Int("max-flows", 300, "most hosts to send per snapshot; the quietest are left off")
		viewers = flag.Int("max-viewers", 0, "most browsers to stream to at once; 0 means no limit")
	)
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *iface == "" {
		var err error
		if *iface, err = capture.DefaultInterface(); err != nil {
			log.Fatalf("finding the default interface: %v (pass -iface)", err)
		}
	}

	db, err := geo.Open(*geoPath)
	if err != nil {
		log.Fatalf("opening %s: %v\nfetch it with scripts/fetch-geo.sh", *geoPath, err)
	}
	defer db.Close()

	var local atomic.Pointer[map[netip.Addr]bool]
	refreshLocal := func() {
		if set, err := capture.LocalAddrs(); err == nil {
			local.Store(&set)
		} else {
			log.Print(err)
		}
	}
	refreshLocal()
	if local.Load() == nil {
		log.Fatal("no local addresses")
	}
	isLocal := func(ip netip.Addr) bool { return (*local.Load())[ip] }

	home, from := resolveHome(*homeArg, db, *local.Load())
	log.Printf("home: %.2f, %.2f %s (%s)", home.Lat, home.Lon, home.City, from)

	src, err := capture.Open(*iface, capture.Snaplen, "ip or ip6")
	if err != nil {
		dieCapture(*iface, err)
	}
	defer src.Close()
	dec, err := capture.NewDecoder(src.LinkType(), isLocal)
	if err != nil {
		log.Fatal(err)
	}

	table := flows.New(30 * time.Second)
	go func() {
		for {
			data, ci, err := src.Read()
			if err != nil {
				return
			}
			if p, ok := dec.Decode(data, ci); ok {
				table.Add(p)
			}
		}
	}()

	nm := names.New()
	if dnsSrc, err := capture.Open("any", 4096, names.Filter); err != nil {
		log.Printf("host names disabled: %v", err)
	} else {
		defer dnsSrc.Close()
		go names.Sniff(dnsSrc, nm)
	}

	hub := server.NewHub(*viewers)
	srcs := sources{db: db, names: nm, home: home, maxFlows: *maxFlow, public: *public, idFor: addrID}
	if *public {
		srcs.idFor = hashedIDs()
	} else {
		// In public mode this would only see its own container, and process names are nobody's business.
		srcs.procs = procs.New()
		go srcs.procs.Run(ctx, 2*time.Second)
	}
	go func() {
		t := time.NewTicker(*tick)
		defer t.Stop()
		prev, lastRefresh := time.Now(), time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				if now.Sub(lastRefresh) > 30*time.Second {
					refreshLocal()
					lastRefresh = now
				}
				table.Tick(now, now.Sub(prev))
				prev = now
				msg, err := json.Marshal(srcs.snapshot(now, table.Snapshot()))
				if err != nil {
					log.Print(err)
					continue
				}
				hub.Publish(msg)
			}
		}
	}()

	static, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		log.Fatal(err)
	}
	if *webDir != "" {
		if _, err := os.Stat(filepath.Join(*webDir, "index.html")); err != nil {
			log.Fatalf("-web: %v", err)
		}
		static = os.DirFS(*webDir)
		log.Printf("serving the frontend from %s", *webDir)
	}
	srv := &http.Server{
		Addr:    *addr,
		Handler: server.Handler(hub, static),
		// Event streams never end on their own; deriving them from ctx lets Shutdown finish.
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()

	log.Printf("capturing on %s, serving http://%s", *iface, *addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// resolveHome decides where this machine is: the -home flag, else the location of a public address
// on one of its interfaces (a global IPv6 address usually is one), else its time zone's city.
func resolveHome(arg string, db *geo.DB, local map[netip.Addr]bool) (geo.Location, string) {
	// A server behind NAT, such as an EC2 instance, has no public address on any interface, so it is
	// told its address instead.
	if ip, err := netip.ParseAddr(arg); err == nil {
		loc, ok := db.Lookup(ip)
		if !ok {
			log.Fatalf("-home: %s is not in the geo database", ip)
		}
		return loc, "geolocated -home " + ip.String()
	}
	if arg != "" {
		loc, err := geo.ParseLatLon(arg)
		if err != nil {
			log.Fatalf("-home: %v", err)
		}
		return loc, "-home"
	}
	var public []netip.Addr
	for ip := range local {
		if capture.Routable(ip) {
			public = append(public, ip)
		}
	}
	sort.Slice(public, func(i, j int) bool { return public[i].Less(public[j]) })
	for _, ip := range public {
		if loc, ok := db.Lookup(ip); ok {
			return loc, "geolocated " + ip.String()
		}
	}
	if loc, ok := geo.FromTimeZone(); ok {
		return loc, "time zone"
	}
	return geo.Location{}, "unknown; pass -home lat,lon"
}

func dieCapture(iface string, err error) {
	msg := err.Error()
	if strings.Contains(msg, "ermission") || strings.Contains(msg, "not permitted") {
		exe, _ := os.Executable()
		fmt.Fprintf(os.Stderr, "cannot capture on %s: %v\n\n"+
			"Packet capture needs two capabilities. Grant them to the binary (again after every rebuild):\n\n"+
			"  sudo setcap cap_net_raw,cap_net_admin+ep %s\n\n"+
			"or run `make run`, which does it for you.\n", iface, err, exe)
		os.Exit(1)
	}
	log.Fatalf("cannot capture on %s: %v", iface, err)
}
