# The globe is built with node and embedded into the collector by go, and the collector runs on slim
# Debian with libpcap. The geo database is not in the image: docker/entrypoint.sh fetches it into a
# volume and refreshes it once it is a month old.

FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM golang:1.27-bookworm AS go
RUN apt-get update && apt-get install -y --no-install-recommends libpcap-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd cmd
COPY internal internal
COPY web/embed.go web/
COPY --from=web /src/web/dist web/dist
RUN go build -trimpath -ldflags='-s -w' -o /netstats ./cmd/netstats

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libpcap0.8 curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=go /netstats /usr/local/bin/netstats
COPY scripts/fetch-geo.sh scripts/
COPY docker/entrypoint.sh /usr/local/bin/
ENTRYPOINT ["entrypoint.sh"]
