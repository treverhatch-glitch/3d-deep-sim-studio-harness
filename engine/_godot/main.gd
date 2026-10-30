extends Node3D
## The playable build: the sim steps on a fixed tick (never the frame rate), and the scene is built in
## code so every change is a readable diff. Units are boxes; the label shows the numbers.
##
## 2.32.0: the player drives it. B (or the Buy button) queues a "spawn" action, exactly like the web
## build, so tools/controls.gd can press every control in the Game Bible and check what it did. Before,
## the scene played itself with the scenario policy, which is how a Godot build passed every gate in
## the Marina run while nobody could play it. The policy only runs with autoplay on (the parity tool
## and demos), never by default.

const Sim = preload("res://sim/sim.gd")
const TICKS_PER_SECOND := 30

var state: Dictionary
var acc := 0.0
var label: Label
var buy_button: Button
var boxes := {}
var errors := []
var queued: Array = []
var autoplay := false


func _ready() -> void:
	state = Sim.create_initial_state(1337)
	autoplay = OS.get_environment("STUDIO_AUTOPLAY") == "1"
	var cam := Camera3D.new()
	cam.position = Vector3(10, 12, 18)
	add_child(cam)
	cam.look_at(Vector3(10, 0, 0))
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 30, 0)
	add_child(sun)
	var hud := CanvasLayer.new()
	add_child(hud)
	label = Label.new()
	label.position = Vector2(16, 16)
	hud.add_child(label)
	buy_button = Button.new()
	buy_button.name = "Buy"
	buy_button.text = "Buy unit (B)"
	buy_button.position = Vector2(16, 48)
	buy_button.size = Vector2(160, 36)
	buy_button.pressed.connect(buy)
	hud.add_child(buy_button)


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_B:
		buy()


## The one player action in the template: buy a unit on the next tick (the sim refuses it when credits are short).
func buy() -> void:
	queued.append({"type": "spawn", "kind": "vehicle", "id": "bought-%d-%d" % [state.tick + 1, queued.size()], "x": 0, "z": state.tick % 7})


## One fixed tick: the queued player actions (or, with autoplay, the scenario policy).
func tick_once() -> void:
	var acts: Array = queued
	queued = []
	if autoplay and acts.is_empty():
		acts = Sim.expand_policy(state, state.tick + 1)
	state = Sim.step(state, acts)


func _physics_process(delta: float) -> void:
	acc += delta
	while acc >= 1.0 / TICKS_PER_SECOND and Sim.outcome(state) == "":
		acc -= 1.0 / TICKS_PER_SECOND
		tick_once()
	draw()


func draw() -> void:
	for e in state.entities:
		if not boxes.has(e.id):
			var m := MeshInstance3D.new()
			m.mesh = BoxMesh.new()
			add_child(m)
			boxes[e.id] = m
		boxes[e.id].position = Vector3(e.x, 0.5, e.z)
	label.text = "tick %d  credits %d  power %d  units %d  %s" % [state.tick, state.resources.credits, state.resources.energy, Sim.unit_count(state), Sim.outcome(state)]


## What the gate's smoke run checks after its frames: the sim moved and the screen agrees with it.
func smoke_report() -> Array:
	if state.tick == 0:
		errors.append("the sim never stepped")
	if boxes.size() != state.entities.size():
		errors.append("%d boxes for %d entities" % [boxes.size(), state.entities.size()])
	return errors
