# Skill: research

**When.** The Producer (or the owner) wants a question answered from outside sources before work is planned: how
an engine feature behaves, what a tool or service costs, what other games did. Queued with
`npm run task -- add "<the question>" --type research`.

**Steps.**
1. `npm run task -- start <ID> --agent <you>` writes the template to `docs/research/<ID>.md` (or the game's own
   `docs/research/` when the game has a docs folder).
2. Write the one question you are answering.
3. Read the sources. List each one under **Sources** with its link (`https://…`) and the date you read it.
4. **Findings**: what the sources say, each finding naming its source.
5. **Unverified**: what you could not confirm from a source (one forum post, a guess, an untested claim), or "none".
6. **Recommendation**: what to do next in one or two lines, and the tasks it leads to (queue them with
   `npm run task -- add`, or propose them).
7. Commit the write-up, then `npm run task -- done <ID> --agent <you>`.

**Done means.** The write-up exists and its Sources section holds at least one link. The digest lists finished
research with its file and recommendation. No verify: research changes no game code.

**Never.** Present an unverified claim as a finding. Paste keys, private links or paid content into the write-up.
Copy another game's code, art, audio or text into the repo.
