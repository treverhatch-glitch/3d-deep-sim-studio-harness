// The playable build: the sim on a fixed tick, the scene built in code so every change is a readable diff
// (no scene or prefab YAML for agents to break). It starts itself in any scene (RuntimeInitializeOnLoadMethod).
//
// The sim owns the rules: FixedUpdate calls Sim.Step once per tick with what the player asked for since the
// last tick. This file only turns input into SimActions and draws the state. Nothing here changes the state.
using System.Collections.Generic;
using Studio.Sim;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.UI;
using UnityEngine.UI;

namespace Studio.Game
{
    public sealed class GameDriver : MonoBehaviour
    {
        public const float TickSeconds = 0.05f; // 20 ticks a second
        public static GameDriver Instance { get; private set; }

        public SimState State { get; private set; }
        public Button BuyButton { get; private set; }
        public uint Seed = 1337;

        readonly List<SimAction> pending = new List<SimAction>();
        readonly Dictionary<string, GameObject> views = new Dictionary<string, GameObject>();
        readonly List<GameObject> owned = new List<GameObject>();
        InputAction buyKey;
        Text hud;
        int asked;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Boot()
        {
            if (Instance != null) return;
            new GameObject("Game").AddComponent<GameDriver>();
        }

        void Awake()
        {
            Instance = this;
            DontDestroyOnLoad(gameObject);
            Time.fixedDeltaTime = TickSeconds;
            State = Sim.CreateInitialState(Seed);
            buyKey = new InputAction("buy", InputActionType.Button, "<Keyboard>/b");
            buyKey.performed += _ => Buy();
            buyKey.Enable();
            BuildScene();
        }

        void OnDestroy()
        {
            buyKey?.Disable();
            buyKey?.Dispose();
            foreach (var go in owned) if (go != null) Destroy(go);
            foreach (var go in views.Values) if (go != null) Destroy(go);
            if (Instance == this) Instance = null;
        }

        /// <summary>The player asks to buy a unit; the sim decides on the next tick whether it can be paid for.</summary>
        public void Buy()
        {
            asked += 1;
            pending.Add(SimAction.Spawn("vehicle", $"bought-{State.Tick}-{asked}", 0, asked % 7));
        }

        void FixedUpdate()
        {
            if (Sim.Outcome(State) != "") return;
            State = Sim.Step(State, pending.ToArray());
            pending.Clear();
        }

        void Update()
        {
            foreach (var e in State.Entities)
            {
                if (!views.TryGetValue(e.Id, out var go))
                {
                    go = GameObject.CreatePrimitive(e.Kind == "crate" ? PrimitiveType.Cube : PrimitiveType.Capsule);
                    go.name = e.Id;
                    views[e.Id] = go;
                }
                go.transform.position = new Vector3((float)e.X, (float)e.Y + 0.5f, (float)e.Z);
            }
            if (hud != null) hud.text = $"Credits {State.Credits}   Energy {State.Energy}   Units {Sim.UnitCount(State)}   Next unit {Sim.NextUnitCost(State)}   {Sim.Outcome(State)}";
        }

        void BuildScene()
        {
            if (Camera.main == null)
            {
                var cam = new GameObject("Main Camera").AddComponent<Camera>();
                cam.tag = "MainCamera";
                owned.Add(cam.gameObject);
                cam.transform.position = new Vector3(10, 12, -16);
                cam.transform.LookAt(new Vector3(10, 0, 0));
            }
            var light = new GameObject("Sun").AddComponent<Light>();
            light.type = LightType.Directional;
            light.transform.rotation = Quaternion.Euler(50, -30, 0);
            owned.Add(light.gameObject);

            if (FindAnyObjectByType<EventSystem>() == null)
            {
                var es = new GameObject("EventSystem");
                es.AddComponent<EventSystem>();
                es.AddComponent<InputSystemUIInputModule>();
                DontDestroyOnLoad(es);
                owned.Add(es);
            }
            var canvasGo = new GameObject("HUD");
            DontDestroyOnLoad(canvasGo);
            owned.Add(canvasGo);
            var canvas = canvasGo.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            var scaler = canvasGo.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ConstantPixelSize;
            canvasGo.AddComponent<GraphicRaycaster>();
            var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

            hud = NewText(canvasGo.transform, font, new Vector2(16, -16), new Vector2(900, 32));

            var buttonGo = new GameObject("Buy", typeof(RectTransform), typeof(Image), typeof(Button));
            buttonGo.transform.SetParent(canvasGo.transform, false);
            var rt = (RectTransform)buttonGo.transform;
            rt.anchorMin = rt.anchorMax = rt.pivot = new Vector2(0, 1);
            rt.anchoredPosition = new Vector2(16, -56);
            rt.sizeDelta = new Vector2(160, 40);
            BuyButton = buttonGo.GetComponent<Button>();
            BuyButton.onClick.AddListener(Buy);
            var label = NewText(buttonGo.transform, font, Vector2.zero, rt.sizeDelta);
            label.text = "Buy unit (B)";
            label.alignment = TextAnchor.MiddleCenter;
            label.color = Color.black;
        }

        static Text NewText(Transform parent, Font font, Vector2 at, Vector2 size)
        {
            var go = new GameObject("Text", typeof(RectTransform), typeof(Text));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchorMin = rt.anchorMax = rt.pivot = new Vector2(0, 1);
            rt.anchoredPosition = at;
            rt.sizeDelta = size;
            var t = go.GetComponent<Text>();
            t.font = font;
            t.fontSize = 20;
            t.color = Color.white;
            return t;
        }
    }
}
