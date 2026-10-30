extends SceneTree
## The engine track's gate (npm run engine:gate):
##   1. the tests in res://tests/ (each a script with `static func run() -> Array` of failures);
##   2. a smoke run: the main scene for SMOKE_FRAMES frames. Any script error fails the run.
##      2.30h: frames alone are not a check. No test ran, or a main scene without smoke_report(), fails.
##   3. 2.32.0: real input. When res://tools/controls.gd exists, every control it lists is pressed with a
##      real key or mouse event and its effect checked; results go to $STUDIO_CONTROLS_OUT (JSON) for the
##      harness's controls check. A control that does nothing fails the gate.
##   godot --headless --path engine/<game> --script res://tools/gate.gd

const SMOKE_FRAMES := 300
const WAIT_FRAMES := 12
var frames := 0
var failures := []
var tests_run := 0
var main: Node
var controls: Array = []
var ci := -1
var wait := 0
var before = null
var results := []


func _initialize() -> void:
	# A real window size, so clicks land on the HUD (headless defaults to 64x64: every button off screen).
	DisplayServer.window_set_size(Vector2i(1280, 720))
	root.min_size = Vector2i(1280, 720)
	root.size = Vector2i(1280, 720)
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
		main = scene.instantiate()
		root.add_child(main)
	if ResourceLoader.exists("res://tools/controls.gd"):
		controls = load("res://tools/controls.gd").controls()


func _process(_delta: float) -> bool:
	frames += 1
	if frames < SMOKE_FRAMES:
		return false
	if frames == SMOKE_FRAMES:
		if main and main.has_method("smoke_report"):
			for x in main.smoke_report():
				failures.append("smoke: %s" % x)
		else:
			failures.append("the main scene has no smoke_report(): the smoke run checked nothing but frames")
	if main and ci < controls.size():
		if wait > 0:
			wait -= 1
			return false
		if ci >= 0:
			var c: Dictionary = controls[ci]
			var ok: bool = c.expect.call(main, before)
			results.append({"id": c.id, "ok": ok, "what": c.get("what", "")})
			print("[gate] %s control %s" % ["PASS" if ok else "FAIL", c.id])
			if not ok:
				failures.append("control %s did nothing: %s" % [c.id, c.get("what", "")])
		ci += 1
		if ci < controls.size():
			before = controls[ci].before.call(main)
			controls[ci].press.call(main)
			wait = WAIT_FRAMES
			return false
	finish()
	return true


func finish() -> void:
	var out := OS.get_environment("STUDIO_CONTROLS_OUT")
	if out != "" and not controls.is_empty():
		var f := FileAccess.open(out, FileAccess.WRITE)
		if f:
			f.store_string(JSON.stringify({"engine": "godot", "at": Time.get_datetime_string_from_system(true) + "Z", "controls": results}))
			f.close()
	for f in failures:
		printerr("[gate] FAIL %s" % f)
	print("[gate] %s: %d test script(s), %d control(s), %d failure(s), %d smoke frames" % ["PASS" if failures.is_empty() else "FAIL", tests_run, results.size(), failures.size(), SMOKE_FRAMES])
	quit(0 if failures.is_empty() else 1)
