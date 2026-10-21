extends SceneTree
## Parity with the web game: plays start-to-win for each seed and prints one JSON line per seed,
## {"seed":1,"outcome":"won","tick":300}. npm run parity compares them with the web cartridge.
##   godot --headless --path engine/<game> --script res://tools/parity.gd -- 1,2,3,4,5

const Sim = preload("res://sim/sim.gd")


func _initialize() -> void:
	var seeds := [1, 2, 3, 4, 5]
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		seeds = []
		for s in String(args[0]).split(",", false):
			seeds.append(int(s))
	for seed in seeds:
		var r := Sim.run_scenario(seed)
		print(JSON.stringify({"seed": seed, "outcome": r.outcome, "tick": r.tick, "resources.credits": r.state.resources.credits}))
	quit(0)
