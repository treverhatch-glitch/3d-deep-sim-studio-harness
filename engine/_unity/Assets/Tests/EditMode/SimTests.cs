// The port's checks. Pure NUnit on the pure sim: Unity runs them in Edit Mode (-runTests -testPlatform EditMode),
// and tools/SimTests runs the same file with plain .NET (`dotnet test`), so they run without the editor or a licence.
using System.Collections.Generic;
using NUnit.Framework;

namespace Studio.Sim.Tests
{
    public class SimTests
    {
        [Test]
        public void SameSeedSameRun()
        {
            var a = Sim.RunScenario(1337);
            var b = Sim.RunScenario(1337);
            Assert.AreEqual(a.Outcome, b.Outcome);
            Assert.AreEqual(a.Tick, b.Tick);
            Assert.AreEqual(a.State.Credits, b.State.Credits);
        }

        [Test]
        public void RngMatchesTheWebGame()
        {
            // nextMulberry32(1337) in cartridges/example-sim/index.mjs, bit for bit.
            var r = Sim.NextMulberry32(1337);
            Assert.AreEqual(1337u + 0x6D2B79F5u, r.State);
            Assert.That(r.Value, Is.GreaterThanOrEqualTo(0.0).And.LessThan(1.0));
            Assert.AreEqual(Sim.NextMulberry32(1337).Value, r.Value);
        }

        [Test]
        public void JsRoundIsNotBankersRounding()
        {
            Assert.AreEqual(3, Sim.JsRound(2.5));
            Assert.AreEqual(-2, Sim.JsRound(-2.5));
        }

        [Test]
        public void StepNeverChangesThePreviousState()
        {
            var s0 = Sim.CreateInitialState(7);
            var s1 = Sim.Step(s0, new[] { SimAction.Spawn("vehicle", "v-1") });
            Assert.AreEqual(0, s0.Tick);
            Assert.AreEqual(2, s0.Entities.Count);
            Assert.AreEqual(3, s1.Entities.Count);
        }

        [Test]
        public void BuyingAUnitSpendsCredits()
        {
            var s0 = Sim.CreateInitialState(7);
            var cost = Sim.NextUnitCost(s0);
            var s1 = Sim.Step(s0, new[] { SimAction.Spawn("vehicle", "v-1") });
            var idle = Sim.Step(s0);
            // The new unit also earns its net income on the same tick.
            Assert.AreEqual(idle.Credits - cost + (s0.Tuning.UnitIncome - s0.Tuning.UnitUpkeep), s1.Credits);
        }

        [Test]
        public void InvariantsHoldAndTheSliceIsWon()
        {
            var r = Sim.RunScenario(1337);
            CollectionAssert.IsEmpty(r.Findings);
            Assert.AreEqual("won", r.Outcome);
        }

        [Test]
        public void IdleRunsOutOfPower()
        {
            var s = Sim.CreateInitialState(1337);
            for (int t = 0; t < 600 && Sim.Outcome(s) == ""; t++) s = Sim.Step(s);
            Assert.AreEqual("lost", Sim.Outcome(s));
        }
    }
}
