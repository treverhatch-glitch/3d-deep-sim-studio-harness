# Telemetry Notes

Every token number the harness shows is one a tool reported. Nothing is estimated.

- **Measured:** `agent.session.end` events carry what the tool reported when its session ended (Claude Code's
  result usage, Codex's turn totals, or a plain usage line): input, output and cache reads. `npm run tokens`
  and the War Room's "Tokens used" panel sum them by role, model, agent or tool, for the last 5 hours, today or
  the whole log. The run report's "Tokens by role" table uses the same events.
- **Not measured, and labelled so:** sessions whose tool reported no usage (listed by tool), and work outside
  the launcher (a person's own chat, IDE or terminal sessions).
- **Dollar figures:** Claude's `total_cost_usd` is what the same use would cost at API prices; a subscription
  isn't billed it. It is shown only as the tool reported it.
- **Savings:** only what rtk itself measured on the shell output it filtered. A total of "tokens saved" can't
  be measured honestly (nobody knows what an agent would have read otherwise), so none is shown.
- `npm run seed:events` adds a few demo events to an empty log so a fresh War Room isn't blank. They are
  marked `[demo]` and carry no token numbers; it refuses to run on a log that already has events.
