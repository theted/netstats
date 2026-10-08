// Package web holds the built frontend, so the collector ships as a single binary.
package web

import "embed"

// Dist is the output of `npm run build`; build the frontend before the Go binary.
//
//go:embed all:dist
var Dist embed.FS
