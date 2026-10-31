# Running the harness checks on your own PC (2.47.0)

A **private** repo gets 2,000 free GitHub Actions minutes a month. The harness checks use about 52 minutes a
push, which is about a week at a busy pace. A self-hosted runner runs the same checks on your own Windows PC,
for free.

**Only ever for a private repo.** On a public repo, anyone's pull request could run code on your PC.

## Set it up (once)

1. On the PC, install Node 24, Git, Python 3 and the .NET 8 SDK (all free).
2. Repo → **Settings** → **Actions** → **Runners** → **New self-hosted runner** → **Windows**.
3. In PowerShell, make a new empty folder and run the commands GitHub shows: download, then `config.cmd`
   with the one-time token from that page. Type the token there, never in a chat. Say yes to running it as a
   service, so it starts with Windows.
4. Repo → **Settings** → **Secrets and variables** → **Actions** → **Variables** → **New repository
   variable**: name `HARNESS_RUNNER`, value `self-hosted`.

From the next push, every GitHub-hosted job is skipped and the one `self-hosted` job runs on your PC, in this
order:
- protected files
- `npm run release` (every required gate and the self-test)
- the War Room and controls in Chromium
- the Unity template on .NET

## Good to know

- The checks run only while the PC is on and the runner service is running. Pushes made while it's off wait
  in the queue.
- To go back to GitHub's machines, delete the `HARNESS_RUNNER` variable.
- The runner runs as your Windows user, so it can read what you can. Keep it to this private repo.
