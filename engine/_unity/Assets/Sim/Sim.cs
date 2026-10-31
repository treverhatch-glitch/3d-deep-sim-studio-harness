// The sim, ported 1:1 from the web cartridge (this template ports cartridges/example-sim/index.mjs).
// Same seed and same actions give the same outcome on the same tick: `npm run parity` checks it.
//
// Rules for a port (the sim purity check enforces the first three):
//   - This assembly has no engine references (Sim.asmdef: noEngineReferences). No UnityEngine, no Time,
//     no UnityEngine.Random, no DateTime.Now, no unseeded System.Random: the only randomness is the
//     seeded Mulberry32 below, and the only clock is the tick.
//   - One Step per tick. Unity's FixedUpdate (Assets/Game/GameDriver.cs) calls it; the sim never asks
//     how much time passed.
//   - 32-bit maths stays 32-bit: uint arithmetic wraps exactly like JavaScript's Math.imul and >>> 0.
//   - JavaScript's Math.round(x) is Math.Floor(x + 0.5), not C#'s Math.Round (banker's rounding).
//   - State is plain data a test can compare: integers stay integers.
// C# 9 only (Unity 6's compiler): tools/SimTests builds this with LangVersion 9, so newer syntax fails there first.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Studio.Sim
{
    public sealed class Tuning
    {
        public int StartCredits = 1500;
        public int StartEnergy = 600;
        public int EnergyPerTick = 1;
        public int BaseIncome = 20;
        public int UnitIncome = 12;
        public int UnitUpkeep = 4;
        public int SpawnCost = 400;
        public int SpawnCostGrowth = 60;
        public int DriftRange = 40;
        public int WinCredits = 25000;

        public Tuning Clone() => (Tuning)MemberwiseClone();
    }

    public sealed class Entity
    {
        public string Id = "";
        public string Kind = "crate";
        public double X;
        public double Y;
        public double Z;
        public int Speed;

        public Entity Clone() => (Entity)MemberwiseClone();
    }

    public sealed class SimAction
    {
        public string Type = "";
        public string Kind = "";
        public string Id = "";
        public double X;
        public double Z;

        public static SimAction Spawn(string kind, string id = "", double x = 0, double z = 0) =>
            new SimAction { Type = "spawn", Kind = kind, Id = id, X = x, Z = z };
    }

    public sealed class LogEntry
    {
        public int Tick;
        public SimAction Action = new SimAction();
        public bool Ok;
    }

    public sealed class SimState
    {
        public uint Seed;
        public uint RngState;
        public int Tick;
        public bool Paused;
        public bool Won;
        public bool Lost;
        public Tuning Tuning = new Tuning();
        public int Credits;
        public int Energy;
        public List<Entity> Entities = new List<Entity>();
        public List<LogEntry> ActionLog = new List<LogEntry>();

        public SimState Clone()
        {
            var s = (SimState)MemberwiseClone();
            s.Tuning = Tuning.Clone();
            s.Entities = new List<Entity>(Entities.Count);
            foreach (var e in Entities) s.Entities.Add(e.Clone());
            s.ActionLog = new List<LogEntry>(ActionLog);
            return s;
        }
    }

    public readonly struct RngStep
    {
        public readonly double Value;
        public readonly uint State;
        public RngStep(double value, uint state) { Value = value; State = state; }
    }

    public static class Sim
    {
        static readonly HashSet<string> UnitKinds = new HashSet<string> { "vehicle", "sensor" };

        /// <summary>Mulberry32, bit for bit the web cartridge's nextMulberry32.</summary>
        public static RngStep NextMulberry32(uint rngState)
        {
            uint next = unchecked(rngState + 0x6D2B79F5u);
            uint t = next;
            t = unchecked((t ^ (t >> 15)) * (t | 1u));
            t ^= unchecked(t + (t ^ (t >> 7)) * (t | 61u));
            return new RngStep((t ^ (t >> 14)) / 4294967296.0, next);
        }

        /// <summary>JavaScript's Math.round: floor(x + 0.5).</summary>
        public static int JsRound(double x) => (int)Math.Floor(x + 0.5);

        /// <summary>JavaScript's Number(x.toFixed(3)) for the small positive positions the sim makes.</summary>
        public static double Fixed3(double x) => Math.Round(x, 3, MidpointRounding.AwayFromZero);

        public static SimState CreateInitialState(uint seed, Tuning tuning = null)
        {
            var t = tuning?.Clone() ?? new Tuning();
            var s = new SimState { Seed = seed, RngState = seed, Tuning = t, Credits = t.StartCredits, Energy = t.StartEnergy };
            s.Entities.Add(new Entity { Id = "unit-1", Kind = "vehicle", X = 0, Y = 0, Z = 0, Speed = 1 });
            s.Entities.Add(new Entity { Id = "prop-1", Kind = "crate", X = 4, Y = 0, Z = -2, Speed = 0 });
            return s;
        }

        public static int UnitCount(SimState s)
        {
            int n = 0;
            foreach (var e in s.Entities) if (UnitKinds.Contains(e.Kind)) n++;
            return n;
        }

        public static int NextUnitCost(SimState s) => s.Tuning.SpawnCost + s.Tuning.SpawnCostGrowth * (UnitCount(s) - 1);

        /// <summary>One tick. Returns a new state; the previous one is never changed.</summary>
        public static SimState Step(SimState prev, IReadOnlyList<SimAction> actions = null)
        {
            actions ??= Array.Empty<SimAction>();
            bool resume = false;
            foreach (var a in actions) if (a != null && a.Type == "RESUME") resume = true;
            if (prev.Paused && !resume) return prev;
            var state = prev.Clone();
            var t = state.Tuning;
            state.Tick += 1;

            foreach (var act in actions)
            {
                if (act == null || string.IsNullOrEmpty(act.Type)) continue;
                if (act.Type == "PAUSE") state.Paused = true;
                if (act.Type == "RESUME") state.Paused = false;
                if (act.Type == "SPAWN_ENTITY" || act.Type == "spawn")
                {
                    var kind = string.IsNullOrEmpty(act.Kind) ? "crate" : act.Kind;
                    int cost = UnitKinds.Contains(kind) ? NextUnitCost(state) : 0;
                    bool ok = state.Credits >= cost;
                    state.ActionLog.Add(new LogEntry { Tick = state.Tick, Action = act, Ok = ok });
                    if (!ok) continue;
                    state.Entities.Add(new Entity
                    {
                        Id = string.IsNullOrEmpty(act.Id) ? $"entity-{state.Tick}-{state.Entities.Count}" : act.Id,
                        Kind = kind,
                        X = act.X,
                        Y = 0,
                        Z = act.Z,
                        Speed = UnitKinds.Contains(kind) ? 1 : 0,
                    });
                    state.Credits -= cost;
                    continue;
                }
                state.ActionLog.Add(new LogEntry { Tick = state.Tick, Action = act, Ok = true });
            }

            var rng = NextMulberry32(state.RngState);
            state.RngState = rng.State;
            int drift = JsRound((rng.Value - 0.45) * t.DriftRange);
            int units = UnitCount(state);
            state.Credits += t.BaseIncome + units * (t.UnitIncome - t.UnitUpkeep) + drift;
            state.Energy = Math.Max(0, state.Energy - t.EnergyPerTick);

            foreach (var e in state.Entities) if (e.Speed > 0) e.X = Fixed3(e.X + e.Speed * 0.5);

            if (!state.Won && !state.Lost)
            {
                if (state.Credits >= t.WinCredits) state.Won = true;
                else if (state.Credits < 0 || state.Energy <= 0) state.Lost = true;
            }
            return state;
        }

        public static List<string> Invariants(SimState s)
        {
            var found = new List<string>();
            if (s.Energy < 0 || s.Energy > s.Tuning.StartEnergy) found.Add($"ENERGY_RANGE: energy {s.Energy}");
            if (s.Won && s.Lost) found.Add("WON_AND_LOST");
            var ids = new HashSet<string>();
            foreach (var e in s.Entities) if (!ids.Add(e.Id)) found.Add($"DUPLICATE_ID: {e.Id}");
            return found;
        }

        public static string Outcome(SimState s) => s.Won ? "won" : s.Lost ? "lost" : "";

        /// <summary>The web cartridge's start-to-win policy (cartridges/example-sim/qa.mjs expandPolicy).</summary>
        public static SimAction[] ExpandPolicy(SimState s, int tick)
        {
            int cost = NextUnitCost(s);
            int net = s.Tuning.UnitIncome - s.Tuning.UnitUpkeep;
            bool paysBack = net > 0 && (double)cost / net < s.Energy / 2.0;
            if (paysBack && s.Credits >= cost + 200) return new[] { SimAction.Spawn("vehicle", $"bought-{tick}", 0, tick % 7) };
            return Array.Empty<SimAction>();
        }

        public sealed class ScenarioResult
        {
            public string Outcome = "";
            public int Tick;
            public List<string> Findings = new List<string>();
            public SimState State;
        }

        /// <summary>The start-to-win scenario, as harness/cartridge.mjs runScenario plays it.</summary>
        public static ScenarioResult RunScenario(uint seed, int maxTicks = 600)
        {
            var state = CreateInitialState(seed);
            int ticks = 0;
            for (int t = 1; t <= maxTicks; t++)
            {
                state = Step(state, ExpandPolicy(state, t));
                ticks = t;
                var bad = Invariants(state);
                if (bad.Count > 0) return new ScenarioResult { Tick = t, Findings = bad, State = state };
                if (Outcome(state) != "") break;
            }
            return new ScenarioResult { Outcome = Outcome(state), Tick = ticks, State = state };
        }

        /// <summary>One parity line, the format qa/parity.mjs reads: {"seed":1,"outcome":"won","tick":300,"resources.credits":25013}.</summary>
        public static string ParityLine(uint seed)
        {
            var r = RunScenario(seed);
            var sb = new StringBuilder();
            sb.Append("{\"seed\":").Append(seed.ToString(CultureInfo.InvariantCulture))
              .Append(",\"outcome\":\"").Append(r.Outcome).Append('"')
              .Append(",\"tick\":").Append(r.Tick.ToString(CultureInfo.InvariantCulture))
              .Append(",\"resources.credits\":").Append(r.State.Credits.ToString(CultureInfo.InvariantCulture))
              .Append('}');
            return sb.ToString();
        }
    }
}
