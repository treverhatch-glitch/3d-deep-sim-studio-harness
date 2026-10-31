// Playable builds from the command line, so the Unity version can be played as it is built:
//   Unity -batchmode -nographics -projectPath <folder> -executeMethod StudioBuild.WebGL   -out <dir> -logFile -
//   Unity -batchmode -nographics -projectPath <folder> -executeMethod StudioBuild.Windows -out <dir> -logFile -
// (npm run engine:build -- web|windows does this.) The WebGL build lands in Build/WebGL by default, which is the
// track's webExport: the Arcade's engine tab plays it in a browser. The Windows build is Build/Windows/Game.exe.
// The game builds its scene in code (GameDriver boots itself), so the one scene a build needs is created empty
// here the first time and kept in Assets/Scenes/Main.unity.
using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class StudioBuild
{
    const string ScenePath = "Assets/Scenes/Main.unity";

    public static void WebGL() => Run(BuildTarget.WebGL, Arg("-out", "Build/WebGL"));

    public static void Windows() => Run(BuildTarget.StandaloneWindows64, Path.Combine(Arg("-out", "Build/Windows"), "Game.exe"));

    static string Arg(string name, string fallback)
    {
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
        return fallback;
    }

    static string[] Scenes()
    {
        if (!File.Exists(ScenePath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            EditorSceneManager.SaveScene(scene, ScenePath);
        }
        return new[] { ScenePath };
    }

    static void Run(BuildTarget target, string output)
    {
        if (target == BuildTarget.WebGL)
        {
            // Plays from any static host (the Arcade, Cloudflare Pages, a USB stick): compressed, with the
            // browser-side fallback so no server headers are needed.
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Gzip;
            PlayerSettings.WebGL.decompressionFallback = true;
        }
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions { scenes = Scenes(), locationPathName = output, target = target, options = BuildOptions.None });
        var s = report.summary;
        bool ok = s.result == BuildResult.Succeeded;
        Debug.Log($"[build] {(ok ? "PASS" : "FAIL")} {target} -> {output} ({s.totalSize} bytes, {s.totalErrors} error(s), {s.totalTime.TotalSeconds:0} s)");
        EditorApplication.Exit(ok ? 0 : 1);
    }
}
