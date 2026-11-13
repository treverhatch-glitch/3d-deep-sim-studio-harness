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
 *   unless    (2.83) words that match rx but are plainly something else: returns why, or null (then it is the owner's);
 *             2.85: (text, context) for money, the context an ask carries (ask.mjs askContext)
 *   also      (2.85) words that name the act with none of rx's words in them
 */
// 2.83: what tells the game's own money from real money, and removing code from deleting data. A crew's owner was
// paged for a balance question ("the grace week hands out money the game doesn't need") and for a task that removed
// three unwired modules: neither is what this list is for. Both readings are narrow on purpose: the words must say what
// it is, and one word of the real thing keeps it the owner's.
const IN_GAME = /\b(in[- ]game|in the game|the game'?s (?:own )?(?:economy|money|currency|cash|balance|prices?|finances?|costs?)|players?(?:'s|')?|gameplay|game design|game balance|balanc(?:e|ing) pass|playtest(?:s|ing)?|difficulty|the sim(?:ulation)?(?:'s)?|scenario|tuning|the game (?:doesn'?t|does not|needs?|gives?|hands out|pays?|charges?)|career (?:start|mode)|starting (?:money|cash|funds|budget)|(?:early|mid|late)[- ]game)\b/i;
// 2.85 (B-136): real spending, by family. One match keeps a question the owner's whatever else it says, whatever tag it
// carries and whatever task it is tied to; the refusal names the word. A family is a list of words that say real money
// leaves the studio: a game's own fee, price or cost never matches. Tests: qa/selftest-285c.mjs, one per family.
export const REAL_SPEND_FAMILIES = Object.freeze({
  currency: /\b(real[- ](?:money|world|cash|currenc(?:y|ies))|usd|eur|gbp|thb|baht|euros?|paypal|stripe|venmo|wire transfer|bank (?:account|card|transfer)|(?:account|bank|wallet|api|credit|card) balance|crypto(?:currency)?|bitcoin)\b/i,
  plan: /\b(paid (?:plan|tier|service|tool|asset|licen[cs]e|account|seat|api|model|version|edition|add-?on)s?|(?:pro|premium|plus|team|business|enterprise|max) (?:plan|tier|seat|subscription|edition|account)s?|upgrade (?:to )?(?:a |the )?(?:paid|pro|premium|plus|business|enterprise|max)\b|free trial|licen[cs]e (?:fees?|keys?|costs?|seats?)|per[- ]seat|\d+ (?:a|per) seat|pay[- ]as[- ]you[- ]go|paid \S+ (?:plan|tier|service|tool|version)s?|premium (?:\S+ )?(?:librar(?:y|ies)|versions?)|(?:cancel|keep|renew|our|the studio'?s) (?:\S+ ){0,2}?memberships?)\b/i,
  subscription: /\b(subscri(?:be|bes|bed|bing|ption|ptions)|renew(?:s|ed|ing|al)? (?:the |our |a )?(?:plan|subscription|licen[cs]e))\b/i,
  invoice: /\b(invoices?|invoiced|billing|bill(?:ed)? (?:us|me|the owner|the studio)|receipts?)\b/i,
  vendor: /\b((?<!(?:npc|in[- ]game|game|shop) )vendors?(?![-/ ](?:folder|dir|directory|code|chunks?|bundles?|libs?|prefix|files?))|contractors?|freelancers?|freelance|outsourc(?:e|es|ed|ing)|commission(?:s|ed|ing)? (?:an? |the )?(?:artists?|composers?|musicians?|writers?|voice|art|music|tracks?|pieces?|models?)|sign(?:s|ed|ing)? (?:a|the|our|this) contract|retainer|contract (?:\S+ )?(?:artists?|modell?ers?|animators?|riggers?|devs?|developers?|programmers?|designers?|composers?|writers?)|composers?|voice actors?|translators?|illustrators?|session musicians?|lawyers?|accountants?|consultants?)\b/i,
  store: /\b(asset store|app store|play store|online store|web ?store|marketplace|checkout|store price|price on (?:steam|itch|the store)|steam(?! (?:engines?|locomotives?|trains?|power|pressure|boilers?|turbines?))|itch(?:\.io)?|gumroad|envato|fab\.com|fiverr|upwork|kickstarter|patreon|ko-?fi|backers?|(?:launch|retail|regional|base) price|(?:buy|buys|buying|bought|purchase|sell|sells) (?:the|our) (?:game|demo|dlc|soundtrack|full version))\b/i,
  card: /\b(credit cards?|debit cards?|card (?:number|on file|details)|(?:our|my|your|the owner'?s|company|business|corporate|studio|prepaid|gift) cards?|charge(?:d|s)? (?:it |this |that |them )?(?:to|on) (?:the |our |my )?(?:card|account))\b/i,
  topup: /\b(top[- ]ups?|topups?|top up (?:the |our |my )?(?:account|credits?|balance|wallet|api|tokens?|plan|key)|recharge (?:the |our )?(?:account|credits?|wallet))\b/i,
  api: /\b(api (?:costs?|credits?|bill|spend|usage|account|pricing|plan|fees?)|usage (?:bill|costs?|limits?)|(?:token|model|llm|compute|gpu|cloud|hosting) (?:costs?|bills?|spend|credits?|fees?)|credit (?:pack|bundle)s?|spending (?:limit|cap|rule)s?|spend(?:ing)? cap)\b/i,
  hiring: /\b(hir(?:e|es|ed|ing)\b (?:\S+ ){0,3}?(?:artists?|composers?|musicians?|freelancers?|contractors?|writers?|translators?|voice actors?|developers?|programmers?|designers?|testers?|qa|someone|a person|people|humans?)|(?:we|us|i|the studio|the owner) (?:\S+ ){0,2}?hir(?:e|es|ed|ing)|pay(?:s|ing)? (?:the |our |a |an )?(?:playtesters?|testers?|artists?|composers?|freelancers?|contractors?|people|humans?|writers?|translators?))\b/i,
  bounty: /\b(bug bount(?:y|ies)|bount(?:y|ies) (?:program|platform|payout|on (?:github|the issue|the repo))|(?:post|offer|fund|set up)(?:s|ed|ing)? (?:a |the )?bounty)\b/i,
  buying: /\b((?:buy|buys|buying|bought|purchas(?:e|es|ed|ing)|pay(?:s|ing)?(?:\s+\S+){0,2}?\s+for|order(?:s|ed|ing)?(?=\s+(?:a|an|\d+|two|three|some|more|new|another|used)\b)|spend(?:s|ing)? (?!(?:more |less |some |the |a |an |our )?(?:time|effort|hours?|days?|weeks?|turns?|cycles|context)\b)(?:\S+ ){0,3}?on|rent(?:s|ed|ing)?|leas(?:e|es|ed|ing)|licen[cs](?:e|es|ed|ing))\s+(?:\S+\s+){0,4}?(?:assets?|packs?|plugins?|tools?|licen[cs]es?|plans?|seats?|services?|models?|fonts?|music|sounds?|soundtracks?|tracks?|songs?|servers?|vps|droplets?|gpus?|domains?|hosting|credits?|tokens?|software|copies|a copy|kits?|librar(?:y|ies)|icon sets?|campaigns?|ads|editors?|apps?)|(?:we|us|i|the studio|the owner)\s+(?:\S+\s+){0,2}?(?:buy|purchase|spend|subscribe|rent|lease|pay|donate|tip|sponsor|licen[cs]e))\b|(?:^|[.?!:;]\s+)(?:please\s+)?(?:buy|purchase|subscribe to|rent|keep paying|licen[cs]e|donate|sponsor|pay(?= (?:for|\$?\d))|tip(?= (?:the|an?|our|\$?\d)))\b(?!\s+(?:price|cost|button|menu|screen|panel|rate))/i,
  // 2.85 (B-136 hardening): real costs named with no buying verb and no money word (ads, a domain, a rented GPU, a font
  // licence, tax, a dev kit, a tool's bill or credits, an amount next to a pack or plugin, a store's sale price).
  outside: /\b(ad spend|ads? campaigns?|(?:reddit|facebook|meta|tiktok|google|youtube|steam) ads|influencers?|domain names?|(?:a|the|our|new) domain (?:for|name)|(?:buy|get|register|renew)(?:s|ed|ing)? (?:a |the |our )?domain|register [\w-]+\.(?:com|net|io|gg|dev|games)|vps|droplets?|rented gpus?|rent(?:s|ed|ing)? (?:an? )?(?:gpu|a100|h100)|trademarks?|vat (?:on|for|return|number|rate)|sales tax|withholding tax|(?:font|music|asset|commercial) licen[cs]es?|usdt|usdc|eth|gift cards?|'s (?:visa|mastercard|amex)|(?:visa|mastercard|amex) (?:card|ending)|donat(?:e|es|ed|ing|ion)|real spend|(?:approve|approves|approved) (?:the |an? )?expense|expense (?:it|claim|report)|(?:from|on|in|off) the (?!game\b)(?:\w+ )?(?:asset store|marketplace)|(?:with|complete|finish) the checkout|(?:second|new|used|another) (?:monitor|gpu|graphics card|headset|laptop|pc|mac)|dev ?kits?|(?:openai|anthropic|claude|gemini|elevenlabs|midjourney|replicate|cloudflare|vercel|aws|azure|gcp|github|figma|adobe) (?:bill|credits?|plan|tier|seats?|subscription|membership)|(?:put|add|load)(?:s|ing)? (?:\S+ ){0,2}?(?:money|credits?|funds) (?:on|into|to) (?:the |our )?\S+ (?:account|wallet|balance|credits)|\d[\d.,]*\s?(?:usd|dollars?|bucks|eur|euros?|baht)\s+(?:\S+\s+){0,3}?(?:packs?|plugins?|tools?|fonts?|licen[cs]es?|assets?|kits?)|sells? for on (?:steam|itch)|the (?:game|demo|dlc) (?:sells?|costs?|retails?) (?:for |at )?\$?\d[\d.,]*|(?:steam|summer|winter|seasonal) sale|on sale at)\b|\$\s?\d[\d.,]*\s+(?:\S+\s+){0,3}?(?:packs?|plugins?|tools?|fonts?|licen[cs]es?|assets?|kits?)\b/i,
  owner: /\b(the owner'?s (?:money|card|account|wallet)|our (?:money|budget|spend|bill|account)|in[- ]app purchases?|iap|microtransactions?)\b/i,
});
const REAL_SPEND = new RegExp(Object.values(REAL_SPEND_FAMILIES).map((r) => `(?:${r.source})`).join('|'), 'i');
// 2.85 (hardening): a higher or next tier of a named product ("the next tier of Toolname"): case-sensitive, so the game's
// own "next tier of upgrades" is not one. Read as the plan family.
const PRODUCT_TIER = /\b(?:[Hh]igher|[Nn]ext|[Tt]op|[Bb]igger|[Pp]aid) (?:tier|plan) (?:of|on|for) (?!(?:The|A|An|Our|This)\b)[A-Z][\w.-]+/;
// 2.85: someone inside the game doing the buying ("players buy tools from the shop", "the player hires a second
// cleaner") is the game's own money. Those words are set aside before the families are read, so only the buying and
// hiring verbs lose their match: a plan, a card, a store or a real currency in the same question still makes it the owner's.
// Hardening: a player buying the game itself (the game, its demo, DLC or soundtrack) is a real sale, never in-game.
const GAME_ACTOR_BUYS = /\b(?:players?|passengers?|customers?|guests?|visitors?|npcs?|tenants?|shoppers?|citizens?|villagers?|heroes|the hero|merchants?|traders?|the city|shops?)\s+(?:(?:can|may|must|will|would|could|should|to|then|who|that|also|now|only)\s+){0,2}(?!(?:buy(?:s|ing)?|bought|purchas(?:e|es|ed|ing)|pay(?:s|ing)? for)\s+(?:the|our|this|a copy of the)\s+(?:game|demo|dlc|soundtrack|season pass|full version)\b)(?:buy|buys|buying|bought|purchas(?:e|es|ed|ing)|pay(?:s|ing)?(?:\s+for)?|order(?:s|ed|ing)?|rent(?:s|ed|ing)?|leas(?:e|es|ed|ing)|hir(?:e|es|ed|ing)|spend(?:s|ing)?)\b/gi;
const outsideGame = (t) => String(t || '').replace(GAME_ACTOR_BUYS, ' (the player does) ');
// 2.85: these name real spending even with no money word in them ("upgrade to the paid tier", "top up the API
// account"): owner-only on their own. Hiring and stores are left out (an agent is hired; "the store" can be the game's).
// Hardening: buying, vendors and the outside costs too ("rent a GPU", "hire a freelancer", "license a soundtrack" have
// no money word). Read past the game's own buyers (outsideGame), as the families are.
const SPEND_ALONE_RX = new RegExp(['currency', 'plan', 'subscription', 'invoice', 'card', 'topup', 'api', 'bounty', 'owner', 'outside', 'buying', 'vendor'].map((k) => `(?:${REAL_SPEND_FAMILIES[k].source})`).join('|'), 'i');
const SPEND_ALONE = { test: (t) => SPEND_ALONE_RX.test(t) || PRODUCT_TIER.test(t) };
const realSpendIn = (t) => { const x = outsideGame(t); return x.match(REAL_SPEND) || x.match(PRODUCT_TIER); };
/** 2.85: the first words of real spending in a text and their family, or null. */
export const realSpendWord = (t) => {
  const m = realSpendIn(t);
  if (!m) return null;
  const word = m[0].replace(/^[.?!:;\s]+/, '').trim();
  const family = Object.keys(REAL_SPEND_FAMILIES).find((k) => REAL_SPEND_FAMILIES[k].test(m[0])) || (PRODUCT_TIER.test(m[0]) ? 'plan' : 'buying');
  return { word, family };
};
// 2.85 (B-136): a game-design subject. Money words (dollars, fee, price, pay as a game verb) in a question about the
// game's rules, balance, economy, content or UI text are a design question. Only read when no real-spending word is in
// the question (REAL_SPEND first, always). "rule" never counts as the studio's or the owner's own rules.
const GAME_SUBJECT = /\b(game[- ]?rules?|(?<!(?:studio|harness|house|spending|budget|owner'?s|our|team|permission) )rules?|(?<!(?:account|bank|card|wallet|api|credit) )balanc(?:e|ed|es|ing)|fee cards?|price cards?|price lists?|fee tables?|contracts?|tiers?|levels?|unlocks?|tuning|tunables?|the bible|pillars?|economy|upkeep|payouts?|rewards?|price curves?|game (?:systems?|content|ui|text|data|mechanics?)|(?:ui|hud|tooltip|panel|button) (?:text|copy|labels?)|tooltips?|gold|gems|coins|hud|salar(?:y|ies)|wages|first place|prize money)\b/i;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 2.85: a Bible system name (a kept layer's label or keyword, a pillar's name) in the text, or null. */
const termIn = (t, terms) => (Array.isArray(terms) ? terms : []).map((x) => String(x || '').trim()).filter((x) => x.length >= 3).find((x) => new RegExp(`\\b${esc(x)}\\b`, 'i').test(t)) || null;
const GAME_MONEY = "it is about the game's own money, not real money";
const HARD_DELETE = /\b(wip(?:e|es|ed|ing)|eras(?:e|es|ed|ing)|purg(?:e|es|ed|ing)|destroy(?:s|ed|ing)?)\b|\brm -r|--force\b|\bforce[- ]push/i;
const CODE_THING = /\b(modules?|source files?|code|scripts?|class(?:es)?|functions?|components?|imports?|tests?|test files?|dead code|unused|unwired|stubs?|helpers?)\b|[\w-]+\.(?:mjs|cjs|js|jsx|ts|tsx|cs|py|gd|cpp|h|css|html|json)\b|\b[\w-]+\/(?=[\s,.;:)]|$)/i;
const DATA_THING = /\b(repo|repos|repository|repositories|history|backups?|saves?|saved games?|save files?|user data|player data|players?'? ?data|data|databases?|\bdb\b|records?|logs?|events?|ledgers?|branch(?:es)?|worktrees?|stash(?:es)?|tags?|(?<!\b(?:in|through|via|inside) (?:this|a|an|the|its|their|my|his|her) )lanes?|checkouts?|builds?|assets?|art|models|textures?|audio|uploads?|downloads?|drive|disk|folder on|accounts?|keys?|secrets?)\b|\.studio\b|\.git\b|\.env\b/i;

export const OWNER_ONLY = Object.freeze([
  Object.freeze({ act: 'money', what: 'real money (buying, paying, a paid plan, tool or asset)', actions: ['money', 'spend', 'payment', 'pay', 'purchase', 'buy'],
    rx: /\b(money|pay(?:s|ing|ment|ments|ed)?|purchas(?:e|es|ed|ing)|buy(?:s|ing)?|bought|invoice|subscri(?:be|ption)|credit card|bank|dollars?|euros?|baht|usd|eur|thb|refund)\b|\$\s?\d/i,
    // 2.85: real spending named with no money word in it ("upgrade to the paid tier") is the owner's too.
    also: SPEND_ALONE,
    // 2.83: the game's own money is not real money. 2.85 (B-136): read from more than the IN_GAME words. Real spending
    // (REAL_SPEND) first, always: then the owner's, whatever the tag or task. Otherwise the question is the game's own
    // money when it says so (IN_GAME), names a game-design subject (GAME_SUBJECT, or a system the Bible names:
    // ctx.terms), is tied to a game-work task (ctx.gameTie, worked out by ask.mjs), or was tagged --game-rules
    // (ctx.gameRules). Nothing of these: the owner's (the safe default).
    unless: (t, ctx = {}) => {
      if (realSpendIn(t)) return null;
      if (new RegExp(GAME_ACTOR_BUYS.source, 'i').test(t)) return `${GAME_MONEY} (the buyer is inside the game)`;
      if (IN_GAME.test(t)) return GAME_MONEY;
      const g = t.match(GAME_SUBJECT);
      if (g) return `${GAME_MONEY} (a game-design subject: "${g[0]}")`;
      const term = termIn(t, ctx.terms);
      if (term) return `${GAME_MONEY} (a system the Bible names: "${term}")`;
      if (typeof ctx.gameTie === 'string' && ctx.gameTie.trim()) return `${GAME_MONEY} (tied to ${ctx.gameTie})`;
      if (ctx.gameRules === true) return `${GAME_MONEY} (the asker tagged it --game-rules)`;
      return null;
    },
    // 2.85: the word that made it real money, for the refusal.
    word: (t) => { const r = realSpendWord(t); if (r) return `"${r.word}" names real spending (${r.family})`; const m = t.match(/\b(money|pay(?:s|ing|ment|ments|ed)?|purchas(?:e|es|ed|ing)|buy(?:s|ing)?|bought|invoice|subscri(?:be|ption)|credit card|bank|dollars?|euros?|baht|usd|eur|thb|refund)\b|\$\s?\d+/i); return m ? `"${m[0]}", and nothing ties the question to the game's rules (no game-design subject, no game task, no --game-rules tag)` : ''; } }),
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

// 2.85: the texts and, as a last argument, the context of an ask ({ gameTie, gameRules, terms }) that the money reading uses.
const split = (args) => {
  const last = args[args.length - 1];
  const ctx = last && typeof last === 'object' && !Array.isArray(last) ? last : null;
  return [(ctx ? args.slice(0, -1) : args).map((x) => String(x || '')).join('\n'), ctx || {}];
};
// Hardening: the money entry's `also` is read past the game's own buyers (outsideGame), as the families are.
const names = (o, t) => o.rx.test(t) || Boolean(o.also && o.also.test(o.act === 'money' ? outsideGame(t) : t));

/** The entry an ask's words name (question, why[, context]), or null. */
export const ownerOnlyTopic = (...args) => {
  const [t, ctx] = split(args);
  return OWNER_ONLY.find((o) => names(o, t) && !(o.unless && o.unless(t, ctx))) || null;
};

/**
 * 2.83: the owner-only words an ask uses that were read as something else (the game's own money, code removed in a
 * lane): [{ act, why }]. An answer by a stand-in records them, so the owner can see every such reading afterwards.
 * 2.85: the same arguments as ownerOnlyTopic (a context last).
 */
export const ownerOnlyReadAs = (...args) => {
  const [t, ctx] = split(args);
  return OWNER_ONLY.filter((o) => names(o, t) && o.unless && o.unless(t, ctx)).map((o) => ({ act: o.act, why: o.unless(t, ctx) }));
};

/** 2.85: why an ask is owner-only, in words: the word that made it so (money), or ''. */
export const ownerOnlyWord = (o, ...args) => { const [t] = split(args); return o?.word ? o.word(t) : ''; };

/**
 * 2.85 (hardening): do these texts carry any money signal (the money entry's words, or real spending named without
 * them), whatever the reading? ask.mjs gives such an ask no timer: a reading as the game's own money only changes who may
 * answer it, never that the asker's default applies by itself. The word lists cannot be complete; this is the backstop.
 */
export const moneyWorded = (...texts) => { const t = texts.map((x) => String(x || '')).join('\n'); const o = OWNER_ONLY[0]; return o.rx.test(t) || o.also.test(outsideGame(t)); };

/** One sentence for a refusal: what it is and that only the owner does it. */
export const ownerOnlyWhy = (o, who = '') => `${o.what} stays the owner's own (studio rule, harness/owner-acts.mjs): ${who ? `${who} may not do it, ` : ''}even in beta mode and even as the owner's proxy; the owner does it in their own terminal`;
