// StudioEditorService.cs — 2.84 (s): the editor side of the harness's editor service (harness/editor-service.mjs).
//
// UNTESTED ON A REAL EDITOR. This file has never been compiled or run in Unity: the harness side is tested against a
// stand-in editor (qa/fixtures/fake-editor.mjs) speaking the same file protocol. Read docs/NATIVE-ENGINE.md
// "The editor service" for what the first real run must check.
//
// Active ONLY when the editor was started with `-studioService <folder>` (the harness does that: `npm run editor --
// start`). A person's own editor, without that argument, never runs any of this.
//
// The protocol (files, no sockets), in <folder>:
//   requests/<id>.json   { id, kind, at, mode, filter, assemblyNames, resultsPath, scene, camera, width, height, out }
//                        kind: ping | refresh | compile | test | capture | quit
//   responses/<id>.json  { id, ok, kind, ms, errors: [{ file, line, code, message }], results, images, log, why }
//   heartbeat.json       { pid, at, busy, unityVersion, domainReloads }, every -studioHeartbeatSec seconds (default 5)
// One request at a time, oldest file name first (the harness names them <ms>-<pid>-<n>-<kind>). A compile or test
// request in flight survives a domain reload: its request and the errors so far are kept in SessionState (which lives
// for the editor session, across reloads) and it is finished after the reload.
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.Compilation;          // CompilationPipeline: compile events and RequestScriptCompilation (Unity 2019.3+)
using UnityEditor.SceneManagement;      // EditorSceneManager.OpenScene
using UnityEditor.TestTools.TestRunner.Api; // TestRunnerApi, ICallbacks, Filter (com.unity.test-framework 1.1+; the template has 1.4.6)
using UnityEngine;

[InitializeOnLoad]
public static class StudioEditorService
{
    [Serializable] class Request
    {
        public string id, kind, at, mode, filter, resultsPath, scene, camera;
        // "out" is a C# keyword: the verbatim name @out is still "out" to JsonUtility (it reads the field's name).
        public string @out;
        public string[] assemblyNames;
        public int width, height;
    }
    [Serializable] class Err { public string file; public int line; public string code; public string message; }
    [Serializable] class Response
    {
        public string id; public bool ok; public string kind; public long ms;
        public Err[] errors = new Err[0];
        public string results, log, why;
        public string[] images = new string[0];
    }
    [Serializable] class Heartbeat { public int pid; public long at; public string busy; public string unityVersion; public int domainReloads; }
    [Serializable] class ErrList { public List<Err> items = new List<Err>(); }

    const string KeyInflight = "StudioService.inflight";   // the request in flight (JSON)
    const string KeyStarted = "StudioService.started";     // when it started (ms), as a string
    const string KeyErrors = "StudioService.errors";       // compiler errors collected so far (JSON)
    const string KeyCompiled = "StudioService.compiled";   // "1" once compilationFinished fired for it
    const string KeyReloads = "StudioService.reloads";     // domain reloads this session

    static readonly string Folder;
    static readonly double BeatSec = 5;
    static double nextBeat;
    static double waitStarted; // EditorApplication.timeSinceStartup when this domain began waiting on the in-flight request

    static StudioEditorService()
    {
        Folder = Arg("-studioService");
        if (string.IsNullOrEmpty(Folder)) return; // a person's editor: nothing at all
        double b;
        if (double.TryParse(Arg("-studioHeartbeatSec"), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out b) && b > 0) BeatSec = b;
        Directory.CreateDirectory(Path.Combine(Folder, "requests"));
        Directory.CreateDirectory(Path.Combine(Folder, "responses"));
        // A static constructor of an [InitializeOnLoad] class runs after every domain reload: count them.
        SessionState.SetInt(KeyReloads, SessionState.GetInt(KeyReloads, -1) + 1);
        // CompilationPipeline.assemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages): per assembly.
        CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompiled;
        // CompilationPipeline.compilationFinished(object context): once per compilation, before any domain reload.
        CompilationPipeline.compilationFinished += _ => { if (InflightKind() == "compile") SessionState.SetString(KeyCompiled, "1"); };
        // Test callbacks are registered again after every reload (a Play Mode run reloads the domain); they act only
        // while a test request is in flight. ScriptableObject.CreateInstance<TestRunnerApi>() is the documented way to
        // get the API object.
        Api().RegisterCallbacks(new TestCallbacks());
        waitStarted = EditorApplication.timeSinceStartup;
        EditorApplication.update += Tick; // runs in batch mode too while the editor stays open (no -quit) — UNVERIFIED
    }

    static TestRunnerApi api;
    static TestRunnerApi Api() { if (api == null) api = ScriptableObject.CreateInstance<TestRunnerApi>(); return api; }

    static string Arg(string name)
    {
        var a = Environment.GetCommandLineArgs();
        for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i + 1];
        return null;
    }

    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    static void WriteAtomic(string file, string text)
    {
        var tmp = file + "." + System.Diagnostics.Process.GetCurrentProcess().Id + ".tmp";
        File.WriteAllText(tmp, text);
        // File.Move fails when the target exists (Mono/.NET Framework): delete first. A reader may see no file for a
        // moment; the harness reads again on its next poll.
        if (File.Exists(file)) File.Delete(file);
        File.Move(tmp, file);
    }

    static Request Inflight()
    {
        var s = SessionState.GetString(KeyInflight, "");
        return string.IsNullOrEmpty(s) ? null : JsonUtility.FromJson<Request>(s);
    }
    static string InflightKind() { var r = Inflight(); return r == null ? null : r.kind; }

    static void Beat()
    {
        if (EditorApplication.timeSinceStartup < nextBeat) return;
        nextBeat = EditorApplication.timeSinceStartup + BeatSec;
        var r = Inflight();
        var hb = new Heartbeat { pid = System.Diagnostics.Process.GetCurrentProcess().Id, at = Now(), busy = r == null ? "" : r.id, unityVersion = Application.unityVersion, domainReloads = Math.Max(0, SessionState.GetInt(KeyReloads, 0)) };
        try { WriteAtomic(Path.Combine(Folder, "heartbeat.json"), JsonUtility.ToJson(hb)); } catch (Exception) { /* skip a beat */ }
    }

    static void Tick()
    {
        Beat();
        var r = Inflight();
        if (r != null) { Continue(r); return; }
        string[] files;
        try { files = Directory.GetFiles(Path.Combine(Folder, "requests"), "*.json"); } catch (Exception) { return; }
        Array.Sort(files, StringComparer.Ordinal);
        foreach (var f in files)
        {
            if (Path.GetFileName(f).StartsWith(".")) continue; // the harness's temp files
            Request req;
            try { req = JsonUtility.FromJson<Request>(File.ReadAllText(f)); } catch (Exception) { continue; } // half written: next tick
            if (req == null || string.IsNullOrEmpty(req.id)) continue;
            Begin(req);
            return; // one request at a time
        }
    }

    static void Begin(Request req)
    {
        SessionState.SetString(KeyInflight, JsonUtility.ToJson(req));
        SessionState.SetString(KeyStarted, Now().ToString());
        SessionState.SetString(KeyErrors, "");
        SessionState.SetString(KeyCompiled, "");
        waitStarted = EditorApplication.timeSinceStartup;
        nextBeat = 0; Beat(); // say "busy" at once
        try
        {
            switch (req.kind)
            {
                case "ping": Finish(true, null); return;
                case "quit":
                    Finish(true, null);
                    EditorApplication.Exit(0); // ends the editor process with this exit code
                    return;
                case "refresh":
                    AssetDatabase.Refresh(); // imports what changed on disk; may start a compile
                    return; // finished in Continue once nothing is updating or compiling
                case "compile":
                    AssetDatabase.Refresh();
                    // Forces a compile even when no script changed, so the errors are always fresh (Unity 2019.3+).
                    CompilationPipeline.RequestScriptCompilation();
                    return;
                case "test":
                    var filter = new Filter { testMode = req.mode == "PlayMode" ? TestMode.PlayMode : TestMode.EditMode };
                    if (!string.IsNullOrEmpty(req.filter)) filter.groupNames = req.filter.Split(';'); // regexes on full names, like -testFilter
                    if (req.assemblyNames != null && req.assemblyNames.Length > 0) filter.assemblyNames = req.assemblyNames;
                    Api().Execute(new ExecutionSettings(filter)); // asynchronous: TestCallbacks.RunFinished answers
                    return;
                case "capture": Capture(req); return;
                default: Finish(false, "unknown kind " + req.kind); return;
            }
        }
        catch (Exception e) { Finish(false, req.kind + ": " + e.Message); }
    }

    static void Continue(Request r)
    {
        if (r.kind == "refresh")
        {
            if (!EditorApplication.isUpdating && !EditorApplication.isCompiling) Finish(true, null);
            return;
        }
        if (r.kind == "compile")
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
            bool done = SessionState.GetString(KeyCompiled, "") == "1";
            // Nothing compiled after a while (no compile was needed after all): answer with what the editor knows.
            bool quiet = EditorApplication.timeSinceStartup - waitStarted > 10;
            if (!done && !quiet) return;
            var errs = Errors();
            // EditorUtility.scriptCompilationFailed: true while the last compile has errors.
            if (errs.items.Count == 0 && EditorUtility.scriptCompilationFailed)
                errs.items.Add(new Err { file = "", line = 0, code = "", message = "the scripts have compile errors (see the editor log)" });
            Finish(errs.items.Count == 0, null, errs.items.ToArray());
            return;
        }
        // test and capture answer from their own callbacks; a request in flight from before a reload that is neither
        // (it cannot be resumed) is answered as failed so the queue moves on.
        if (r.kind != "test") Finish(false, "interrupted by a domain reload");
    }

    static ErrList Errors()
    {
        var s = SessionState.GetString(KeyErrors, "");
        return string.IsNullOrEmpty(s) ? new ErrList() : JsonUtility.FromJson<ErrList>(s);
    }

    static readonly Regex CodeRe = new Regex(@"\b(CS\d{4})\b");
    static readonly Regex TailRe = new Regex(@"error\s+CS\d{4}\s*:\s*(.*)$");

    // CompilerMessage: { message, file, line, column, type } (UnityEditor.Compilation).
    static void OnAssemblyCompiled(string assemblyPath, CompilerMessage[] messages)
    {
        if (InflightKind() != "compile" || messages == null) return;
        var errs = Errors();
        var root = Path.GetFullPath(Path.Combine(Application.dataPath, "..")).Replace('\\', '/').TrimEnd('/') + "/";
        foreach (var m in messages)
        {
            if (m.type != CompilerMessageType.Error) continue;
            var file = (m.file ?? "").Replace('\\', '/');
            if (file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) file = file.Substring(root.Length);
            var code = CodeRe.Match(m.message ?? ""); var tail = TailRe.Match(m.message ?? "");
            errs.items.Add(new Err { file = file, line = m.line, code = code.Success ? code.Groups[1].Value : "", message = tail.Success ? tail.Groups[1].Value : m.message });
        }
        SessionState.SetString(KeyErrors, JsonUtility.ToJson(errs));
    }

    class TestCallbacks : ICallbacks
    {
        public void RunStarted(ITestAdaptor testsToRun) { }
        public void TestStarted(ITestAdaptor test) { }
        public void TestFinished(ITestResultAdaptor result) { }
        public void RunFinished(ITestResultAdaptor result)
        {
            var r = Inflight();
            if (r == null || r.kind != "test") return;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(r.resultsPath)));
                // TestRunnerApi.SaveResultToFile(ITestResultAdaptor, string): writes the NUnit 3 XML. LEAST SURE: present in
                // the test framework since 1.1 as far as known; if the template's version lacks it this file does not compile.
                TestRunnerApi.SaveResultToFile(result, r.resultsPath);
                // TestStatus: Passed / Failed / Skipped / Inconclusive.
                Finish(result.TestStatus != TestStatus.Failed, result.TestStatus == TestStatus.Failed ? result.FailCount + " test(s) failed" : null, null, r.resultsPath);
            }
            catch (Exception e) { Finish(false, "test results: " + e.Message); }
        }
    }

    static void Capture(Request r)
    {
        int w = r.width > 0 ? r.width : 1280, h = r.height > 0 ? r.height : 720;
        if (!string.IsNullOrEmpty(r.scene)) EditorSceneManager.OpenScene(r.scene, OpenSceneMode.Single);
        Camera cam = null;
        if (!string.IsNullOrEmpty(r.camera)) { var go = GameObject.Find(r.camera); if (go != null) cam = go.GetComponent<Camera>(); }
        if (cam == null) cam = Camera.main; // the camera tagged MainCamera
        if (cam == null) { var all = UnityEngine.Object.FindObjectsByType<Camera>(FindObjectsSortMode.None); if (all.Length > 0) cam = all[0]; } // Unity 2023.1+/6 API
        if (cam == null) { Finish(false, "no camera in the scene"); return; }
        var rt = new RenderTexture(w, h, 24);
        var prevTarget = cam.targetTexture; var prevActive = RenderTexture.active;
        Texture2D tex = null;
        try
        {
            cam.targetTexture = rt;
            cam.Render(); // renders once into rt (built-in pipeline; URP routes it through its own path — UNVERIFIED)
            RenderTexture.active = rt;
            tex = new Texture2D(w, h, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            tex.Apply();
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(r.@out)));
            File.WriteAllBytes(r.@out, tex.EncodeToPNG()); // ImageConversion.EncodeToPNG (an extension method)
        }
        finally
        {
            cam.targetTexture = prevTarget; RenderTexture.active = prevActive;
            UnityEngine.Object.DestroyImmediate(rt);
            if (tex != null) UnityEngine.Object.DestroyImmediate(tex);
        }
        Finish(true, null, null, null, new[] { r.@out });
    }

    static void Finish(bool ok, string why, Err[] errors = null, string results = null, string[] images = null)
    {
        var r = Inflight();
        if (r == null) return;
        long started; long.TryParse(SessionState.GetString(KeyStarted, "0"), out started);
        var resp = new Response { id = r.id, ok = ok, kind = r.kind, ms = Math.Max(0, Now() - started), errors = errors ?? new Err[0], results = results, images = images ?? new string[0], log = Arg("-logFile"), why = why };
        try { WriteAtomic(Path.Combine(Folder, "responses", r.id + ".json"), JsonUtility.ToJson(resp)); } catch (Exception e) { Debug.LogError("[studio-service] could not answer " + r.id + ": " + e.Message); }
        try { File.Delete(Path.Combine(Folder, "requests", r.id + ".json")); } catch (Exception) { }
        SessionState.EraseString(KeyInflight);
        SessionState.EraseString(KeyErrors);
        SessionState.EraseString(KeyCompiled);
        nextBeat = 0; Beat();
    }
}
#endif
