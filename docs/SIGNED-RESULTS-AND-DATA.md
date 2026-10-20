# Signed results, training data, and public receipts

Three optional layers on top of the SHA-256 goldens (`docs/HASH.md`), for when results are shared,
sold, rewarded or learned from. A person using the harness on their own needs none of them.

## Signed results (`npm run sign`)

A hash proves two states match. A signature proves who vouched for them.

```bash
npm run sign -- keygen                     # once: private key in .studio/keys/ (never committed), public key in studio/keys/
npm run verify                             # results are checked before they are signed
npm run sign -- result --by hatch --note "Phase 1 slice"
npm run sign -- verify studio/signed/<file>.json --replay
```

A signed result is a manifest that binds code, inputs and outputs, signed with Ed25519 (Node's
built-in crypto):

- **Code:** a SHA-256 over each cartridge's files (paths and contents), and one over the harness
  files that run and hash it.
- **Inputs:** each golden's and regression's own file SHA-256 (seed, tick, actions, scenario).
- **Outputs:** the state SHA-256 each one pins, and the actions SHA-256 for scenarios.
- The last gate run, the harness version and commit, the Game Bible's and asset manifest's SHA-256,
  who signed and when.

Signing refuses a gate run that is red, partial, missing any required gate from `studio/gates.json`,
or older than the last change to the game or its goldens, unless you pass `--allow-red`, which
records why in the manifest.

`verify` checks the signature and the key. `--replay` also checks the code in hand is the signed
code, then re-runs the goldens, regressions, purity and isolation checks and the vertical slice: that
proves this code produces what was signed, not just that someone signed it, even outside git. Publish
your key's fingerprint (`npm run sign -- fingerprint`) somewhere you control, so others can tell your
signatures from anyone else's.

## Training and evaluation data (`npm run trajectories`)

Every finished task leaves a full record: the brief, the commits, whether the checks passed, the
review, and any bug later traced back to it. That is the kind of data used to evaluate models and to
train them with automatic pass/fail grading.

```bash
npm run data                                # the sharing question and the current answer
npm run trajectories -- preview
npm run trajectories -- export --licence "<terms>" [--consent "<who agrees>"] [--with-briefs] [--with-diffs]
```

- **Allowed unless declined.** Intake and the Game plan view ask the game dev whether the studio's
  records may be shared with AI research partners. The box starts ticked; unticking it, or
  `npm run data -- decline --by <name>`, stops every export. Each change is kept with who and when
  (`studio/data-consent.json`), and every manifest records the answer it relied on: `default` (left
  ticked), `confirmed` (a deliberate yes) or `declined`. Terms (`--licence`) are always needed.
- **Scrubbed.** Every text field is cleaned of key-shaped strings with the secret scan's patterns.
- **Labelled.** `clean` (done first time, nothing came back), `needed-fixes` (refused, forced or
  reviewed with changes), `caused-bug` (reopened, or a bug traced back to it).
- **Local.** Files go to `.studio/exports/` (never committed), with a manifest holding the SHA-256.
- **Diffs, if you choose.** `--with-diffs` adds each commit's patch (studio records and lock files
  left out, 20,000 characters at most, scrubbed). Diffs are the most useful part for training and
  the most sensitive: they are your game's code.
- **Providers named.** Each record lists the model families whose work is in it, and the manifest
  counts them and repeats the warning below.

### Collect now, decide later

Collecting costs nothing and stays on your machine: the event log, briefs, tagged commits, reviews
and done-checks are written as the studio works. What can't be done later is recreating history, so
keep it: `npm run learn -- backup` (or `STUDIO_BACKUP_DIR`) copies the event log and briefs, which
live in `.studio/` and are never committed. Exporting is a separate, deliberate step.

### Before sharing with anyone else

Not legal advice; talk to a lawyer before a deal.

- **A pre-ticked box is weaker than a yes.** In the EU and UK a pre-ticked box doesn't count as
  consent for personal data, and Thailand's PDPA also expects consent to be clear. The records are
  mostly about work, not people, but agent names, notes and briefs can name people. For a deal, ask
  game devs to confirm (`how: confirmed` in the manifest), or export only `confirmed` studios.
- **Your consent and the game dev's.** If the studio builds someone else's game, their code and
  ideas are in the records. Get it in writing.
- **Model providers' terms.** Several providers' terms limit using their outputs to develop models
  that compete with theirs. Records full of one provider's output may not be yours to sell to
  another lab. Check each provider's current terms, and prefer records from open-weight models or
  your own work when the buyer trains models.
- **What buyers value.** Verified outcomes: a task, the work, and whether it held up (checks,
  review, bugs traced back). Sample exports from the example game and your own games are fine for
  showing the shape of the data.

Uses, in order: comparing and routing models (the scorecard already does a version of this);
fine-tuning a local model on your own studio's good work; and, only with consent and terms,
datasets for others. Game code can be private and valuable: share records, not repos, and check the
terms of every model provider whose output is in them.

## Public receipts (later, optional)

Planned for the platform stage, never required: write the SHA-256 of a signed manifest to a public
ledger as a receipt that a version existed at a time.

- **What it proves:** that you held exactly this file or result at that time. Useful as evidence of
  prior creation, resale history, or a marketplace badge.
- **What it doesn't:** ownership, licence, or that the code works. Copyright comes from making the
  work (and, where available, registering it); a receipt is evidence, not a title. Not legal advice.
- **Free route:** OpenTimestamps (anchored in Bitcoin, no wallet, no fee).
- **Paid route** for a marketplace: a low-cost chain, posted server-side so users never need a
  wallet.
- **Never inside the game.** Receipts stay with the files and listings; the game ships without
  blockchain parts. Stores such as Steam have refused games built on blockchain that issue or trade
  crypto or NFTs since 2021.
- **No tokens.** Credits plus tradable tokens can turn into a financial-regulation question.
