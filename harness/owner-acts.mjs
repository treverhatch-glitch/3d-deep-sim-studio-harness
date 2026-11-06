/**
 * harness/owner-acts.mjs — 2.79 (c): the one list of what stays the owner's own, always.
 *
 * The owner's words (2026-11-06): "make it so Patch can sign off on everything and not need me", with these left out:
 * real money, deleting data, keys and credentials, publishing outside the PC, and turning beta mode off. Beta mode
 * (harness/beta-mode.mjs), the owner proxy (harness/owner-proxy.mjs), an outside signer and every launched session are
 * refused these, with the reason; only a person's own terminal does them. This file is that list and nothing else (no
 * imports), so permission.mjs, beta-mode.mjs, owner-proxy.mjs, delegation.mjs and ask.mjs all read the same one.
 *
 *   act       the name a refusal and the decisions log use
 *   actions   delegation action names it covers (delegationFor refuses them to the proxy and beta mode)
 *   rx        how an ask's question (and why) names it: kept narrow, so a token budget or a protected file isn't one
 */
export const OWNER_ONLY = Object.freeze([
  Object.freeze({ act: 'money', what: 'real money (buying, paying, a paid plan, tool or asset)', actions: ['money', 'spend', 'payment', 'pay', 'purchase', 'buy'],
    rx: /\b(money|pay(?:s|ing|ment|ments|ed)?|purchas(?:e|es|ed|ing)|buy(?:s|ing)?|bought|invoice|subscri(?:be|ption)|credit card|bank|dollars?|euros?|baht|usd|eur|thb|refund)\b|\$\s?\d/i }),
  Object.freeze({ act: 'delete', what: 'deleting data', actions: ['delete', 'delete-data', 'wipe'],
    rx: /\b(delet(?:e|es|ed|ing)|wip(?:e|es|ed|ing)|eras(?:e|es|ed|ing)|purg(?:e|es|ed|ing)|destroy|remove (?:the )?(?:repo|repository|history|backups?|saves?|data))\b/i }),
  Object.freeze({ act: 'credentials', what: 'keys and credentials', actions: ['keys', 'credentials', 'keygen', 'secrets'],
    rx: /\b(api[- ]?keys?|access tokens?|auth tokens?|credentials?|passwords?|secrets?|private keys?|owner key|ssh keys?|keymap|webhook (?:url|secret))\b/i }),
  Object.freeze({ act: 'publish', what: 'publishing outside the PC', actions: ['publish', 'deploy'],
    rx: /\b(publish(?:es|ed|ing)?|deploy(?:s|ed|ing)? (?:to|on) (?:the )?(?:web|internet|store|production|public|server)|release (?:it |the game )?(?:to|on) (?:the )?(?:store|public|steam|itch)|upload(?:s|ed|ing)? (?:it |the build )?to (?:steam|itch|the store|the web|a server))\b/i }),
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
  return OWNER_ONLY.find((o) => o.rx.test(t)) || null;
};

/** One sentence for a refusal: what it is and that only the owner does it. */
export const ownerOnlyWhy = (o, who = '') => `${o.what} stays the owner's own (studio rule, harness/owner-acts.mjs): ${who ? `${who} may not do it, ` : ''}even in beta mode and even as the owner's proxy; the owner does it in their own terminal`;
