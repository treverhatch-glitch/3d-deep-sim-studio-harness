extends SceneTree
## The engine track's gate (npm run engine:gate):
##   1. the tests in res://tests/ (each a script with `static func run() -> Array` of failures);
##   2. a smoke run: the main scene for SMOKE_FRAMES frames. Any script error fails the run.
##   godot --headless --path engine/<game> --script res://tools/gate.gd

const SMOKE_FRAMES := 300
var frames := 0
var failures := []


func _initialize() -> void:
	var dir := DirAccess.open("res://tests")
	if dir:
		for f in dir.get_files():
			if not f.ends_with(".gd"):
				continue
			var t = load("res://tests/" + f)
			var found: Array = t.run()
			for x in found:
				failures.append("%s: %s" % [f, x])
			print("[gate] %s %s" % ["PASS" if found.is_empty() else "FAIL", f])
	var scene = load(ProjectSettings.get_setting("application/run/main_scene"))
	if scene == null:
		failures.append("the main scene didn't load")
	else:
		root.add_child(scene.instantiate())


func _process(_delta: float) -> bool:
	frames += 1
	if frames < SMOKE_FRAMES:
		return false
	var main := root.get_child(root.get_child_count() - 1)
	if main and main.has_method("smoke_report"):
		for x in main.smoke_report():
			failures.append("smoke: %s" % x)
	for f in failures:
		printerr("[gate] FAIL %s" % f)
	print("[gate] %s: %d test failure(s), %d smoke frames" % ["PASS" if failures.is_empty() else "FAIL", failures.size(), frames])
	quit(0 if failures.is_empty() else 1)
	return true
