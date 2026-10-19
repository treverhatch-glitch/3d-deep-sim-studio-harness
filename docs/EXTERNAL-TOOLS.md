# External tools

Source: public post by @jowettbrendan (https://x.com/jowettbrendan/status/2112115634335363577).
These are public open-source projects. They are safe to read and optional to use.
Do not vendor them into this harness. Pin versions if you install one.
MCP tools that control an editor should stay on localhost.

## Worth noting for this harness

| Tool | What it is | Use here? |
|------|------------|-----------|
| [awesome-gamedev-agent-skills](https://github.com/gamedev-skills/awesome-gamedev-agent-skills) | Portable SKILL.md files for Godot, Unity, Unreal, Three.js | Yes, as optional agent skills. Do not copy the whole set into the public repo. |
| [CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp) | MCP bridge so an agent can edit Unity scenes, scripts, and tests | Yes, when porting a cartridge into Unity. Local only. |
| [IvanMurzak/Unity-MCP](https://github.com/IvanMurzak/Unity-MCP) | Another Unity MCP, editor plus runtime | Alternative to CoplayDev. Pick one. |
| [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) | Runs Godot, captures debug output, basic scene tools | Yes, for a Godot port. Local only. |
| [hi-godot/godot-ai](https://github.com/hi-godot/godot-ai) | Fuller live Godot editor MCP | Prefer this on Godot 4.7+. |
| [VAST-AI-Research/TripoSR](https://github.com/VAST-AI-Research/TripoSR) | Single image to 3D mesh, MIT | Optional prop prototype. Still needs approval before it enters the game. |
| [pmndrs/drei](https://github.com/pmndrs/drei) | React Three Fiber helpers | Useful if the presentation layer is R3F. |
| [@react-three/rapier](https://github.com/pmndrs/react-three-rapier) | Physics for R3F | Presentation only. Keep the pure sim free of it. |
| [yuka](https://github.com/Mugen87/yuka) | Steering, pathfinding, perception | Can inform NPC logic. Do not put it inside the pure sim unless you wrap it deterministically. |
| [three.quarks](https://github.com/Alchemist0823/three.quarks) | Three.js particles | Presentation / juice only. |
| [react-postprocessing](https://github.com/pmndrs/react-postprocessing) | Bloom, DOF, vignette | Presentation / polish only. |
| [colyseus](https://github.com/colyseus/colyseus) | Multiplayer rooms and state sync | Only if a game needs multiplayer. Not part of the harness default. |

## Safety

- Public GitHub projects. No install is required for this harness.
- MCP servers can change local project files. Bind them to localhost and do not expose them.
- Generated 3D from TripoSR is a prototype. It still goes through the approval gate before use.
- Physics, particles, and postprocessing stay outside the pure sim cartridge.
