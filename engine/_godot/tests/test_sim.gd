extends RefCounted
## The port's own checks: deterministic, invariants hold, the vertical slice is won.

const Sim = preload("res://sim/sim.gd")


static func run() -> Array:
	var out := []
	var a := Sim.run_scenario(1337)
	var b := Sim.run_scenario(1337)
	if JSON.stringify(a.state) != JSON.stringify(b.state):
		out.append("two runs of seed 1337 differ")
	if a.outcome != "won":
		out.append("start-to-win ended %s at tick %d" % [a.outcome, a.tick])
	if not a.findings.is_empty():
		out.append("invariants: %s" % ", ".join(a.findings))
	# Mulberry32 against the web cartridge's first value for seed 1 (node: nextMulberry32(1)).
	var r := Sim.next_mulberry32(1)
	if abs(r.value - 0.6270739405881613) > 1e-15:
		out.append("mulberry32(1) = %s, the web gives 0.6270739405881613" % r.value)
	return out
