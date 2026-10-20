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

A signed result is a manifest of the studio's verified state: every golden's and regression's
SHA-256, the last gate run, the harness version and commit, the Game Bible's and asset manifest's
SHA-256, who signed and when, signed with Ed25519 (Node's built-in crypto). Signing refuses a red or
partial verify unless you pass `--allow-red`, which records the failures in the manifest.

`verify` checks the signature and the key. `--replay` also re-runs every golden and regression: that
proves the code in hand still produces what was signed, not just that someone signed it. Publish
your key's fingerprint (`npm run sign -- fingerprint`) somewhere you control, so others can tell your
signatures from anyone else's.

## Training and evaluation data (`npm run trajectories`)

Every finished task leaves a full record: the brief, the commits, whether the checks passed, the
review, and any bug later traced back to it. That is the kind of data used to evaluate models and to
train them with automatic pass/fail grading.

```bash
npm run trajectories -- preview
npm run trajectories -- export --consent "<who agrees>" --licence "<terms>" [--with-briefs]
```

- **Opt-in.** Nothing is exported without consent and terms; both go in the manifest.
- **Scrubbed.** Every text field is cleaned of key-shaped strings with the secret scan's patterns.
- **Labelled.** `clean` (done first time, nothing came back), `needed-fixes` (refused, forced or
  reviewed with changes), `caused-bug` (reopened, or a bug traced back to it).
- **Local.** Files go to `.studio/exports/` (never committed), with a manifest holding the SHA-256.

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
