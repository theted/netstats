BIN := bin/netstats
GEO := data/dbip-city-lite.mmdb

.PHONY: all web build caps run dev test clean

all: build

web/node_modules: web/package.json
	cd web && npm install
	touch $@

web: web/node_modules
	cd web && npm run build

build: web
	go build -o $(BIN) ./cmd/netstats

$(GEO):
	scripts/fetch-geo.sh

# Packet capture needs these two capabilities. setcap's grant is lost whenever the binary is rebuilt.
caps:
	sudo setcap cap_net_raw,cap_net_admin+ep $(BIN)

run: build caps $(GEO)
	./$(BIN)

# Frontend with hot reload on :5173, proxying /events to a collector started separately (make run).
# Open http://localhost:5173/?demo to work on it without the collector.
dev: web/node_modules
	cd web && npm run dev

test:
	go test ./internal/... ./cmd/...
	cd web && npm run typecheck

clean:
	rm -rf bin web/dist
