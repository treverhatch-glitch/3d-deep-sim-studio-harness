extends Node3D
## The playable build: the sim steps on a fixed tick (never the frame rate), and the scene is built in
## code so every change is a readable diff. Units are boxes; the label shows the numbers.

const Sim = preload("res://sim/sim.gd")
const TICKS_PER_SECOND := 30

var state: Dictionary
var acc := 0.0
var label: Label
var boxes := {}
var errors := []


func _ready() -> void:
	state = Sim.create_initial_state(1337)
	var cam := Camera3D.new()
	cam.position = Vector3(10, 12, 18)
	add_child(cam)
	cam.look_at(Vector3(10, 0, 0))
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 30, 0)
	add_child(sun)
	label = Label.new()
	label.position = Vector2(16, 16)
	add_child(label)


func _physics_process(delta: float) -> void:
	acc += delta
	while acc >= 1.0 / TICKS_PER_SECOND and Sim.outcome(state) == "":
		acc -= 1.0 / TICKS_PER_SECOND
		state = Sim.step(state, Sim.expand_policy(state, state.tick + 1))
	for e in state.entities:
		if not boxes.has(e.id):
			var m := MeshInstance3D.new()
			m.mesh = BoxMesh.new()
			add_child(m)
			boxes[e.id] = m
		boxes[e.id].position = Vector3(e.x, 0.5, e.z)
	label.text = "tick %d  credits %d  power %d  %s" % [state.tick, state.resources.credits, state.resources.energy, Sim.outcome(state)]


## What the gate's smoke run checks after its frames: the sim moved and the screen agrees with it.
func smoke_report() -> Array:
	if state.tick == 0:
		errors.append("the sim never stepped")
	if boxes.size() != state.entities.size():
		errors.append("%d boxes for %d entities" % [boxes.size(), state.entities.size()])
	return errors
