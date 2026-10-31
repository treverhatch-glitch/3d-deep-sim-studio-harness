using System;
using Studio.Sim;

// dotnet run --project tools/SimCli -- parity 1,2,3,4,5
public static class Program
{
    public static int Main(string[] args)
    {
        if (args.Length == 0 || args[0] != "parity")
        {
            Console.Error.WriteLine("usage: SimCli parity <seed,seed,...>");
            return 2;
        }
        var seeds = args.Length > 1 ? args[1] : "1,2,3,4,5";
        foreach (var s in seeds.Split(',', StringSplitOptions.RemoveEmptyEntries)) Console.WriteLine(Sim.ParityLine(uint.Parse(s.Trim())));
        return 0;
    }
}
