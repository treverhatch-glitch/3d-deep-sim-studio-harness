extends RefCounted
## The sim, ported 1:1 from the web cartridge (this template ports cartridges/example-sim/index.mjs).
## Same seed and same actions give the same outcome on the same tick: `npm run parity` checks it.
## Rules for a port: integers stay integers, 32-bit maths goes through u32/i32/imul below, JS
## Math.round(x) is floor(x + 0.5), no engine physics or randomness inside the sim, one step per tick.

const TUNING := {
	"startCredits": 1500,
	"startEnergy": 600,
	"energyPerTick": 1,
	"baseIncome": 20,
	"unitIncome": 12,
	"unitUpkeep": 4,
	"spawnCost": 400,
	"spawnCostGrowth": 60,
	"driftRange": 40,
	"winCredits": 25000,
}
const UNIT_KINDS := ["vehicle", "sensor"]
const M32 := 0xFFFFFFFF


static func u32(x: int) -> int:
	return x & M32


static func i32(x: int) -> int:
	x &= M32
	return x - 0x100000000 if x >= 0x80000000 else x


## JavaScript's Math.imul: the low 32 bits of a * b, as a signed 32-bit integer.
static func imul(a: int, b: int) -> int:
	var x := u32(a)
	var y := u32(b)
	var lo := (x & 0xFFFF) * (y & 0xFFFF)
	var mid := (((x >> 16) & 0xFFFF) * (y & 0xFFFF) + (x & 0xFFFF) * ((y >> 16) & 0xFFFF)) & 0xFFFF
	return i32(lo + (mid << 16))


## Mulberry32, bit for bit the web cartridge's nextMulberry32.
static func next_mulberry32(rng_state: int) -> Dictionary:
	var t := i32(rng_state + 0x6d2b79f5)
	t = imul(i32(t ^ (u32(t) >> 15)), i32(t | 1))
	t = i32(t ^ i32(t + imul(i32(t ^ (u32(t) >> 7)), i32(t | 61))))
	var next_state := u32(rng_state + 0x6d2b79f5)
	var value := float(u32(t ^ (u32(t) >> 14))) / 4294967296.0
	return {"value": value, "rngState": next_state}


static func js_round(x: float) -> int:
	return int(floor(x + 0.5))


static func create_initial_state(seed: int) -> Dictionary:
	var clean := u32(seed)
	var t := TUNING.duplicate()
	return {
		"seed": clean,
		"rngState": clean,
		"tick": 0,
		"paused": false,
		"won": false,
		"lost": false,
		"tuning": t,
		"resources": {"credits": t.startCredits, "energy": t.startEnergy},
		"entities": [
			{"id": "unit-1", "kind": "vehicle", "x": 0.0, "y": 0, "z": 0, "speed": 1},
			{"id": "prop-1", "kind": "crate", "x": 4.0, "y": 0, "z": -2, "speed": 0},
		],
		"actionLog": [],
	}


static func unit_count(state: Dictionary) -> int:
	var n := 0
	for e in state.entities:
		if UNIT_KINDS.has(e.kind):
			n += 1
	return n


static func next_unit_cost(state: Dictionary) -> int:
	return state.tuning.spawnCost + state.tuning.spawnCostGrowth * (unit_count(state) - 1)


static func step(prev: Dictionary, actions: Array = []) -> Dictionary:
	var resume := false
	for a in actions:
		if a.get("type", "") == "RESUME":
			resume = true
	if prev.paused and not resume:
		return prev
	var state: Dictionary = prev.duplicate(true)
	var t: Dictionary = state.tuning
	state.tick += 1
	for act in actions:
		var type: String = act.get("type", "")
		if type == "":
			continue
		if type == "PAUSE":
			state.paused = true
		if type == "RESUME":
			state.paused = false
		if type == "SPAWN_ENTITY" or type == "spawn":
			var kind: String = act.get("kind", "crate")
			var cost := next_unit_cost(state) if UNIT_KINDS.has(kind) else 0
			var ok: bool = state.resources.credits >= cost
			state.actionLog.append({"tick": state.tick, "action": act, "ok": ok})
			if not ok:
				continue
			state.entities.append({
				"id": act.get("id", "entity-%d-%d" % [state.tick, state.entities.size()]),
				"kind": kind,
				"x": float(act.get("x", 0)),
				"y": 0,
				"z": act.get("z", 0),
				"speed": 1 if UNIT_KINDS.has(kind) else 0,
			})
			state.resources.credits -= cost
			continue
		state.actionLog.append({"tick": state.tick, "action": act, "ok": true})
	var rng := next_mulberry32(state.rngState)
	state.rngState = rng.rngState
	var drift := js_round((rng.value - 0.45) * t.driftRange)
	var units := unit_count(state)
	state.resources.credits += t.baseIncome + units * (t.unitIncome - t.unitUpkeep) + drift
	state.resources.energy = max(0, state.resources.energy - t.energyPerTick)
	for ent in state.entities:
		if ent.speed > 0:
			ent.x = snappedf(ent.x + ent.speed * 0.5, 0.001)
	if not state.won and not state.lost:
		if state.resources.credits >= t.winCredits:
			state.won = true
		elif state.resources.credits < 0 or state.resources.energy <= 0:
			state.lost = true
	return state


static func invariants(state: Dictionary) -> Array:
	var found := []
	if state.resources.energy < 0 or state.resources.energy > state.tuning.startEnergy:
		found.append("ENERGY_RANGE: energy %d" % state.resources.energy)
	if state.won and state.lost:
		found.append("WON_AND_LOST")
	var ids := {}
	for e in state.entities:
		if ids.has(e.id):
			found.append("DUPLICATE_ID: %s" % e.id)
		ids[e.id] = true
	return found


static func outcome(state: Dictionary) -> String:
	return "won" if state.won else ("lost" if state.lost else "")


## The web cartridge's start-to-win policy (cartridges/example-sim/qa.mjs expandPolicy).
static func expand_policy(state: Dictionary, tick: int) -> Array:
	var cost := next_unit_cost(state)
	var net: int = state.tuning.unitIncome - state.tuning.unitUpkeep
	var pays_back := net > 0 and float(cost) / net < float(state.resources.energy) / 2.0
	if pays_back and state.resources.credits >= cost + 200:
		return [{"type": "spawn", "kind": "vehicle", "id": "bought-%d" % tick, "x": 0, "z": tick % 7}]
	return []


## The start-to-win scenario, as harness/cartridge.mjs runScenario plays it.
static func run_scenario(seed: int, max_ticks: int = 600) -> Dictionary:
	var state := create_initial_state(seed)
	var ticks := 0
	for t in range(1, max_ticks + 1):
		state = step(state, expand_policy(state, t))
		ticks = t
		var bad := invariants(state)
		if not bad.is_empty():
			return {"outcome": "", "tick": t, "findings": bad, "state": state}
		if outcome(state) != "":
			break
	return {"outcome": outcome(state), "tick": ticks, "findings": [], "state": state}
