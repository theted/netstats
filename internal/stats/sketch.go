package stats

import (
	"math"
	"math/bits"
)

// sketch counts distinct items in 2^p bytes, to within about 1.04/√(2^p): a HyperLogLog. It is fed
// hashes and keeps only the longest run of leading zeros seen in each of its registers, so the
// items themselves can't be read back out of it, and it never grows.
type sketch struct {
	p   uint8
	reg []uint8
}

func newSketch(p uint8) *sketch { return &sketch{p: p, reg: make([]uint8, 1<<p)} }

// add counts a 64-bit hash: its top p bits pick a register, and the rest are a geometric trial.
func (s *sketch) add(h uint64) {
	i := h >> (64 - s.p)
	// The guard bit caps the run at 64-p zeros, when the hash's remaining bits are all zero.
	run := uint8(bits.LeadingZeros64(h<<s.p|1<<(s.p-1))) + 1
	s.reg[i] = max(s.reg[i], run)
}

// count estimates how many distinct hashes have been added. Small counts, while registers are
// still empty, use linear counting, which is close to exact there.
func (s *sketch) count() uint64 {
	m := float64(len(s.reg))
	sum, empty := 0.0, 0
	for _, r := range s.reg {
		sum += math.Ldexp(1, -int(r))
		if r == 0 {
			empty++
		}
	}
	e := 0.7213 / (1 + 1.079/m) * m * m / sum
	if e <= 2.5*m && empty > 0 {
		e = m * math.Log(m/float64(empty))
	}
	return uint64(math.Round(e))
}
