extends SceneTree
## The engine track's gate (npm run engine:gate):
##   1. the tests in res://tests/ (each a script with `static func run() -> Array` of failures);
##   2. a smoke run: the main scene for SMOKE_FRAMES frames. Any script error fails the run.
##   2.30h: frames alone are not a check. No test ran, or a main scene without smoke_report(), fails.
##   godot --headless --path engine/<game> --script res://tools/gate.gd

const SMOKE_FRAMES := 300
var frames := 0
var failures := []
var tests_run := 0


func _initialize() -> void:
	var dir := DirAccess.open("res://tests")
	if dir:
		for f in dir.get_files():
			if not f.ends_with(".gd"):
				continue
			var t = load("res://tests/" + f)
			var found: Array = t.run()
			tests_run += 1
			for x in found:
				failures.append("%s: %s" % [f, x])
			print("[gate] %s %s" % ["PASS" if found.is_empty() else "FAIL", f])
	if tests_run == 0:
		failures.append("no test ran (res://tests/ is empty): frames rendered are not a check")
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
	else:
		failures.append("the main scene has no smoke_report(): the smoke run checked nothing but frames")
	for f in failures:
		printerr("[gate] FAIL %s" % f)
	print("[gate] %s: %d test script(s), %d failure(s), %d smoke frames" % ["PASS" if failures.is_empty() else "FAIL", tests_run, failures.size(), frames])
	quit(0 if failures.is_empty() else 1)
	return true
