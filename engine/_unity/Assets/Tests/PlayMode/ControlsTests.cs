// Every control the Game Bible lists (studio/bible/controls.json), pressed the way a player presses it: a key
// or a mouse click through the Input System's own event path (InputTestFixture), never a direct method call.
// Each result goes to $STUDIO_CONTROLS_OUT as { "controls": [{ "id", "ok", "why" }] }, which the harness's
// controls check (qa/controls-check.mjs, track "unity") compares with the Bible: a listed control with no
// passing result here fails the build. Add one [UnityTest] per control, named by the Bible's id.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using NUnit.Framework;
using Studio.Sim;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.TestTools;

namespace Studio.Game.Tests
{
    public class ControlsTests : InputTestFixture
    {
        static readonly List<(string id, bool ok, string why)> Results = new List<(string, bool, string)>();
        Keyboard keyboard;
        Mouse mouse;
        GameDriver game;

        public override void Setup()
        {
            base.Setup(); // resets the input system to a known state with no devices
            keyboard = InputSystem.AddDevice<Keyboard>();
            mouse = InputSystem.AddDevice<Mouse>();
        }

        // The game booted before the fixture reset the input system: each test starts a new one, after the
        // reset, so its input actions bind to the test's keyboard and mouse.
        IEnumerator Begin()
        {
            if (GameDriver.Instance != null) UnityEngine.Object.Destroy(GameDriver.Instance.gameObject);
            yield return null;
            game = new GameObject("Game").AddComponent<GameDriver>();
            yield return null;
        }

        [UnityTearDown]
        public IEnumerator Stop()
        {
            if (game != null) UnityEngine.Object.Destroy(game.gameObject);
            yield return null;
        }

        static IEnumerator Ticks(int n)
        {
            for (int i = 0; i < n; i++) yield return new WaitForFixedUpdate();
        }

        void Report(string id, bool ok, string why)
        {
            Results.Add((id, ok, why));
            Assert.IsTrue(ok, $"{id}: {why}");
        }

        [UnityTest]
        public IEnumerator BuyUnit()
        {
            yield return Begin();
            int before = Sim.UnitCount(game.State);
            Press(keyboard.bKey);
            yield return null;
            Release(keyboard.bKey);
            yield return Ticks(3);
            int after = Sim.UnitCount(game.State);
            Report("buy-unit", after > before, $"units {before} -> {after} after pressing B");
        }

        [UnityTest]
        public IEnumerator BuyButton()
        {
            yield return Begin();
            int before = Sim.UnitCount(game.State);
            var corners = new Vector3[4];
            ((RectTransform)game.BuyButton.transform).GetWorldCorners(corners);
            var center = (Vector2)((corners[0] + corners[2]) / 2f);
            Set(mouse.position, center);
            yield return null;
            Press(mouse.leftButton);
            yield return null;
            Release(mouse.leftButton);
            yield return Ticks(3);
            int after = Sim.UnitCount(game.State);
            Report("buy-button", after > before, $"units {before} -> {after} after clicking Buy at {center}");
        }

        [OneTimeTearDown]
        public void WriteResults()
        {
            var file = Environment.GetEnvironmentVariable("STUDIO_CONTROLS_OUT");
            if (string.IsNullOrEmpty(file)) return;
            var sb = new StringBuilder("{\"controls\":[");
            for (int i = 0; i < Results.Count; i++)
            {
                var r = Results[i];
                if (i > 0) sb.Append(',');
                sb.Append("{\"id\":\"").Append(r.id).Append("\",\"ok\":").Append(r.ok ? "true" : "false")
                  .Append(",\"why\":\"").Append((r.why ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"")).Append("\"}");
            }
            sb.Append("]}");
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
            File.WriteAllText(file, sb.ToString());
        }
    }
}
