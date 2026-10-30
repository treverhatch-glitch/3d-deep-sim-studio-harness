extends RefCounted
## Every control the Game Bible lists (studio/bible/controls.json), pressed the way a player presses it:
## a real key event or a real mouse click through the viewport, never a direct function call. The gate
## (tools/gate.gd) runs these after its smoke frames and writes one result per id to
## $STUDIO_CONTROLS_OUT, which the harness's controls check (qa/controls-check.mjs) compares with the
## Bible: a control the Bible lists with no passing result here fails the build.
##
## Each entry: id (the Bible's id), what (plain words), press(main), before(main), expect(main, before).

const Sim = preload("res://sim/sim.gd")


static func key(code: Key) -> void:
	var down := InputEventKey.new()
	down.keycode = code
	down.physical_keycode = code
	down.pressed = true
	Input.parse_input_event(down)
	var up := down.duplicate()
	up.pressed = false
	Input.parse_input_event(up)


## A left click at a screen point, through the viewport's own input path (the same route the OS's
## events take, so the GUI decides what was hit). Headless Godot doesn't route Input.parse_input_event
## mouse events to the GUI, so the event goes in with push_input.
static func click(main: Node, at: Vector2) -> void:
	var vp := main.get_viewport()
	var move := InputEventMouseMotion.new()
	move.position = at
	move.global_position = at
	vp.push_input(move)
	for pressed in [true, false]:
		var b := InputEventMouseButton.new()
		b.button_index = MOUSE_BUTTON_LEFT
		b.position = at
		b.global_position = at
		b.pressed = pressed
		vp.push_input(b)


static func controls() -> Array:
	return [
		{
			"id": "buy-unit",
			"what": "B buys a unit: a unit appears and credits are spent",
			"press": func(_main): key(KEY_B),
			"before": func(main): return Sim.unit_count(main.state),
			"expect": func(main, before): return Sim.unit_count(main.state) > before,
		},
		{
			"id": "buy-button",
			"what": "clicking the Buy button buys a unit",
			"press": func(main): click(main, main.buy_button.get_global_rect().get_center()),
			"before": func(main): return Sim.unit_count(main.state),
			"expect": func(main, before): return Sim.unit_count(main.state) > before,
		},
	]
