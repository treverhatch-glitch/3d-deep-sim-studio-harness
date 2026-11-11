/**
 * harness/owner-acts.mjs — 2.79 (c): the one list of what stays the owner's own, always.
 *
 * The owner's words (2026-11-06): "make it so Patch can sign off on everything and not need me", with these left out:
 * real money, deleting data, keys and credentials, publishing outside the PC, and turning beta mode off (2.79.1: and
 * defining the tools the harness launches, studio/tools.json). Beta mode
 * (harness/beta-mode.mjs), the owner proxy (harness/owner-proxy.mjs), an outside signer and every launched session are
 * refused these, with the reason; only a person's own terminal does them. This file is that list and nothing else (no
 * imports), so permission.mjs, beta-mode.mjs, owner-proxy.mjs, delegation.mjs and ask.mjs all read the same one.
 *
 *   act       the name a refusal and the decisions log use
 *   actions   delegation action names it covers (delegationFor refuses them to the proxy and beta mode)
 *   rx        how an ask's question (and why) names it: kept narrow, so a token budget or a protected file isn't one
 *   unless    (2.83) words that match rx but are plainly something else: returns why, or null (then it is the owner's)
 */
// 2.83: what tells the game's own money from real money, and removing code from deleting data. A crew's owner was
// paged for a balance question ("the grace week hands out money the game doesn't need") and for a task that removed
// three unwired modules: neither is what this list is for. Both readings are narrow on purpose: the words must say what
// it is, and one word of the real thing keeps it the owner's.
const IN_GAME = /\b(in[- ]game|in the game|the game'?s (?:own )?(?:economy|money|currency|cash|balance|prices?|finances?|costs?)|players?(?:'s|')?|gameplay|game design|game balance|balanc(?:e|ing) pass|playtest(?:s|ing)?|difficulty|the sim(?:ulation)?(?:'s)?|scenario|tuning|the game (?:doesn'?t|does not|needs?|gives?|hands out|pays?|charges?)|career (?:start|mode)|starting (?:money|cash|funds|budget)|(?:early|mid|late)[- ]game)\b/i;
const REAL_SPEND = /\b(real[- ](?:money|world|cash|currenc(?:y|ies))|paid (?:plan|tier|service|tool|asset|licen[cs]e|account|seat|api|model|version)|subscri(?:be|bes|bed|bing|ption|ptions)|invoices?|credit card|debit card|bank (?:account|card|transfer)|billing|bill(?:ed)? (?:us|me|the owner)|checkout|licen[cs]e fees?|asset store|marketplace|api (?:costs?|credits?|bill|spend)|usage (?:bill|costs?|limits?)|spending limit|the owner'?s (?:money|card|account|wallet)|our (?:money|budget|spend|bill)|usd|eur|thb|baht|euros?|paypal|stripe|in[- ]app purchases?|iap|microtransactions?|store price|price on (?:steam|itch|the store)|steam|itch\.io)\b|\b(?:buy|buys|buying|bought|purchas(?:e|es|ed|ing)|pay(?:s|ing)? for|order(?:s|ed|ing)?)\s+(?:\S+\s+){0,4}?(?:assets?|packs?|plugins?|tools?|licen[cs]es?|plans?|seats?|services?|models?|fonts?|music|sounds?|servers?|domains?|hosting|credits?)\b/i;
const HARD_DELETE = /\b(wip(?:e|es|ed|ing)|eras(?:e|es|ed|ing)|purg(?:e|es|ed|ing)|destroy(?:s|ed|ing)?)\b|\brm -r|--force\b|\bforce[- ]push/i;
const CODE_THING = /\b(modules?|source files?|code|scripts?|class(?:es)?|functions?|components?|imports?|tests?|test files?|dead code|unused|unwired|stubs?|helpers?)\b|[\w-]+\.(?:mjs|cjs|js|jsx|ts|tsx|cs|py|gd|cpp|h|css|html|json)\b|\b[\w-]+\/(?=[\s,.;:)]|$)/i;
const DATA_THING = /\b(repo|repos|repository|repositories|history|backups?|saves?|saved games?|save files?|user data|player data|players?'? ?data|data|databases?|\bdb\b|records?|logs?|events?|ledgers?|branch(?:es)?|worktrees?|stash(?:es)?|tags?|(?<!\b(?:in|through|via|inside) (?:this|a|an|the|its|their|my|his|her) )lanes?|checkouts?|builds?|assets?|art|models|textures?|audio|uploads?|downloads?|drive|disk|folder on|accounts?|keys?|secrets?)\b|\.studio\b|\.git\b|\.env\b/i;

export const OWNER_ONLY = Object.freeze([
  Object.freeze({ act: 'money', what: 'real money (buying, paying, a paid plan, tool or asset)', actions: ['money', 'spend', 'payment', 'pay', 'purchase', 'buy'],
    rx: /\b(money|pay(?:s|ing|ment|ments|ed)?|purchas(?:e|es|ed|ing)|buy(?:s|ing)?|bought|invoice|subscri(?:be|ption)|credit card|bank|dollars?|euros?|baht|usd|eur|thb|refund)\b|\$\s?\d/i,
    // 2.83: the game's own money is not real money. A question that says it is about the game (IN_GAME) and names nothing
    // of real spending (REAL_SPEND) is a design question; anything else that names money stays the owner's.
    unless: (t) => (IN_GAME.test(t) && !REAL_SPEND.test(t) ? "it is about the game's own money, not real money" : null) }),
  Object.freeze({ act: 'delete', what: 'deleting data', actions: ['delete', 'delete-data', 'wipe'],
    rx: /\b(delet(?:e|es|ed|ing)|wip(?:e|es|ed|ing)|eras(?:e|es|ed|ing)|purg(?:e|es|ed|ing)|destroy|remove (?:the )?(?:repo|repository|history|backups?|saves?|data))\b/i,
    // 2.83: deleting code through a lane (reviewed, in git history, undone by a revert) is not deleting data. Only the
    // plain verbs (delete, remove) can be read that way, only when the words name code, and never when they name data.
    unless: (t) => (!HARD_DELETE.test(t) && CODE_THING.test(t) && !DATA_THING.test(t) ? 'it is about removing code in a lane (kept in git history), not deleting data' : null) }),
  Object.freeze({ act: 'credentials', what: 'keys and credentials', actions: ['keys', 'credentials', 'keygen', 'secrets'],
    rx: /\b(api[- ]?keys?|access tokens?|auth tokens?|credentials?|passwords?|secrets?|private keys?|owner key|ssh keys?|keymap|webhook (?:url|secret))\b/i }),
  Object.freeze({ act: 'publish', what: 'publishing outside the PC', actions: ['publish', 'deploy'],
    rx: /\b(publish(?:es|ed|ing)?|deploy(?:s|ed|ing)? (?:to|on) (?:the )?(?:web|internet|store|production|public|server)|release (?:it |the game )?(?:to|on) (?:the )?(?:store|public|steam|itch)|upload(?:s|ed|ing)? (?:it |the build )?to (?:steam|itch|the store|the web|a server))\b/i }),
  // 2.79.1 (a): defining or changing a tool the harness launches (studio/tools.json: its command, key names, models,
  // prices, roles), like keys and money. Launching a registered tool and setting spend budgets are not on this list.
  Object.freeze({ act: 'tools', what: 'defining or changing an owner tool (studio/tools.json: its command, keys, models or prices)', actions: ['tools', 'tool-define', 'define-tool'],
    rx: /\bstudio\/tools\.json\b|\b(?:defin|regist)(?:e|es|ed|er|ers|ing) (?:a |an |the )?(?:new )?(?:owner[- ])?tool\b|\btool registry\b/i }),
  Object.freeze({ act: 'beta-off', what: 'turning beta mode off', actions: ['beta-off'],
    rx: /\bbeta(?: mode)? off\b|\bturn(?:s|ing)? (?:off beta|beta(?: mode)? off)\b|\bend(?:s|ing)? beta mode\b/i }),
]);

/** Every delegation action name on the list (the owner proxy and beta mode never cover these). */
export const OWNER_ONLY_ACTIONS = Object.freeze([...new Set(OWNER_ONLY.flatMap((o) => o.actions))]);

/** The entry an action name is, or null. */
export const ownerOnlyAction = (action) => OWNER_ONLY.find((o) => o.actions.includes(String(action || '').trim().toLowerCase())) || null;

/** The entry an ask's words name (question, why), or null. */
export const ownerOnlyTopic = (...texts) => {
  const t = texts.map((x) => String(x || '')).join('\n');
  return OWNER_ONLY.find((o) => o.rx.test(t) && !(o.unless && o.unless(t))) || null;
};

/**
 * 2.83: the owner-only words an ask uses that were read as something else (the game's own money, code removed in a
 * lane): [{ act, why }]. An answer by a stand-in records them, so the owner can see every such reading afterwards.
 */
export const ownerOnlyReadAs = (...texts) => {
  const t = texts.map((x) => String(x || '')).join('\n');
  return OWNER_ONLY.filter((o) => o.rx.test(t) && o.unless && o.unless(t)).map((o) => ({ act: o.act, why: o.unless(t) }));
};

/** One sentence for a refusal: what it is and that only the owner does it. */
export const ownerOnlyWhy = (o, who = '') => `${o.what} stays the owner's own (studio rule, harness/owner-acts.mjs): ${who ? `${who} may not do it, ` : ''}even in beta mode and even as the owner's proxy; the owner does it in their own terminal`;
