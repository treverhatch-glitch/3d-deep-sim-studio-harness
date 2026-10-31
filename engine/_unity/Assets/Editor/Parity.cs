// Parity from inside Unity, for a check on the editor's own compiler and runtime:
//   Unity -batchmode -nographics -projectPath <folder> -executeMethod Parity.Run -seeds 1,2,3 -logFile -
// The everyday parity check needs no editor: dotnet run --project tools/SimCli -- parity 1,2,3 (same source).
using System;
using Studio.Sim;
using UnityEditor;
using UnityEngine;

public static class Parity
{
    public static void Run()
    {
        var args = Environment.GetCommandLineArgs();
        var seeds = "1,2,3,4,5";
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == "-seeds") seeds = args[i + 1];
        foreach (var s in seeds.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries)) Debug.Log(Sim.ParityLine(uint.Parse(s.Trim())));
        EditorApplication.Exit(0);
    }
}
