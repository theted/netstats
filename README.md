# netstats

A machine's live network traffic on a spinning globe. A Go collector captures packet headers, sums
the bytes going to and from each remote host, and places each host on the map with a local DB-IP
database. It streams a snapshot to the browser over Server-Sent Events, and a three.js page draws
one arc per host, with pulses for the traffic.

It runs in two ways:

- **On your own machine:** your connections, with host names and the processes behind them.
- **Public, on a server:** the server's own traffic, for strangers to watch. It's live at
  [globe.sundbergsolutions.se](https://globe.sundbergsolutions.se), showing everything the shared
  EC2 box sends and receives.

## On your own machine

Needs Go, Node, libpcap and `sudo`, once per build, for the capture rights. Open the page in any
browser tab.

```bash
make run    # builds, grants the capture rights (asks for sudo), and serves http://127.0.0.1:7777
```

Packet capture needs `cap_net_raw,cap_net_admin` on the binary (`make caps`), and every Go
rebuild loses them. For frontend work, start the binary once with `-web web/dist`. After that a
change needs only `cd web && npm run build` and a reload. `make dev` gives hot reload on `:5173`,
and `?demo` shows made-up traffic without a collector.

| flag | |
|---|---|
| `-iface` | interface to capture on (default: the one with the default route) |
| `-addr` | where to serve the page (default `127.0.0.1:7777`) |
| `-home` | this machine's location, as `lat,lon` or as a public address to geolocate |
| `-geo` | the `.mmdb` database (default `data/dbip-city-lite.mmdb`, fetched by `scripts/fetch-geo.sh`) |
| `-web` | serve the page from a directory instead of the copy built into the binary |
| `-public` | for a page shown to strangers: opaque host ids instead of addresses, no process names |
| `-tick` | how often to send a snapshot (default `250ms`) |
| `-max-flows` | most hosts per snapshot (default 300) |
| `-max-viewers` | most browsers streaming at once (default: no limit) |

URL switches: `?demo`, `?springs` (springy controls), `?solid` (opaque globe), `?noglow`.

## Public mode

`-public` is for a page anyone can open:

- **No addresses.** Each host is identified by a keyed hash under a key that exists only in the
  running process. An id can't be turned back into an address, or linked to the same host after a
  restart. Places are city-level estimates.
- **Nothing is stored.** Snapshots live in memory for one tick.
- **No process names.**
- **Host names stay.** They come from the server's own DNS lookups, so they name what the server
  connects out to, never who connects in.

Each open tab costs the server bandwidth, so the stream is kept small:
- it is gzipped, which makes it about 8–10× smaller, since consecutive snapshots are nearly
  identical;
- the page closes it while its tab is hidden;
- `-tick 1s` and `-max-viewers` bound the rest.

## Docker

`docker compose up --build` runs the collector in a container. It uses host networking, so it sees
the host's traffic, and it keeps `NET_RAW` and drops every other capability. The DB-IP database
goes on a volume. `docker/entrypoint.sh` fetches it on the first start and again on any start once
it's over 35 days old. In a container the process names are missing, because the container can't
see the host's processes.

## Deploying (Main Vibe)

This follows archetype B in theted/infrastructure (`ec2-docker.md`, `the-box.md`). A push to
`master` runs the tests and then `deploy.yml`, which SSHes into the box, checks out the commit in
`/opt/netstats` and runs:

```bash
docker compose -f docker-compose.yml -f docker-compose.ec2.yml up -d --build
```

`docker-compose.ec2.yml` adds the public-mode flags. It also listens on `127.0.0.1:8084`, the port
claimed in `the-box.md`: with host networking, `-addr` is what keeps the collector off the internet.

One-time setup on the box:

1. `sudo git clone https://github.com/theted/netstats /opt/netstats && sudo chown -R ubuntu: /opt/netstats`
2. `sudo cp deploy/nginx.conf /etc/nginx/sites-available/netstats`,
   `sudo ln -s ../sites-available/netstats /etc/nginx/sites-enabled/`,
   `sudo nginx -t && sudo systemctl reload nginx`
3. At one.com, add `CNAME globe` → `ec2-63-34-177-63.eu-west-1.compute.amazonaws.com`, as for
   snippets and visits. It has to be explicit: the wildcard `CNAME` would otherwise send the name to
   the apex CloudFront site.
4. Once public DNS sends the name to the box, run the command below. Ask a public resolver, as Let's
   Encrypt does. On the box itself, the AWS resolver answers with the private address:
   `curl -s 'https://cloudflare-dns.com/dns-query?name=globe.sundbergsolutions.se&type=A' -H 'accept: application/dns-json'`
   `sudo certbot --nginx -d globe.sundbergsolutions.se`
5. Set the repo secrets `EC2_HOST`, `EC2_USER` and `EC2_SSH_KEY`.

Checks:

```bash
curl -sS -o /dev/null -w '%{http_code} cert=%{ssl_verify_result}\n' https://globe.sundbergsolutions.se/
curl -sN --compressed https://globe.sundbergsolutions.se/events | head -c 500
```

IP geolocation by [DB-IP](https://db-ip.com) (CC BY 4.0).
