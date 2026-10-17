'use strict';
// A simple filter for words that don't belong on a school site. It checks whole words (so
// "assess" and "Scunthorpe" are fine), undoes common disguises (sh1t, $hit, f.u.c.k, fuuuck) and
// adds the words admins list on the Admin page. It is a first line of defense, not a guarantee:
// reports and admin removal handle the rest.

// Words that are blocked on their own and with any ending (e.g. "fucking", "shithead").
const STEMS = ['fuck', 'shit', 'cunt', 'nigg', 'faggot', 'motherf'];
// Words that are blocked on their own or with a common ending only (so "cocktail" or "dickens" pass).
const WORDS = ['ass', 'asshole', 'bitch', 'bastard', 'dick', 'cock', 'pussy', 'slut', 'whore', 'fag', 'retard', 'twat', 'wanker', 'jackass', 'dumbass', 'dipshit', 'piss'];
const ENDINGS = ['', 's', 'es', 'ed', 'er', 'ers', 'ing', 'in', 'y', 'ie', 'ies', 'head', 'heads', 'face', 'hole', 'holes', 'wad'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's' };

// Text -> lowercase words with disguises undone. Runs of single letters ("f u c k") are joined.
function words(text) {
  const s = String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[013457@$8]/g, (c) => LEET[c] || c)
    .replace(/(?<=[a-z])[!|](?=[a-z])/g, 'i'); // "sh!t", but not "wow!!"
  const raw = s.split(/[^a-z]+/).filter(Boolean);
  const out = [];
  let run = '';
  for (const w of raw) {
    if (w.length === 1) { run += w; continue; }
    if (run.length > 1) out.push(run);
    run = '';
    out.push(w);
  }
  if (run.length > 1) out.push(run);
  return out.flatMap((w) => [w, w.replace(/(.)\1+/g, '$1')]); // also "fuuuck" -> "fuck"
}

function createFilter(extra = () => []) {
  const blockedWord = (w, list) => list.some((b) => b && (w === b || ENDINGS.some((e) => e && w === b + e)));
  // Returns the first problem word found in any of the texts, or null.
  function find(...texts) {
    const custom = extra().map((x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean);
    for (const t of texts.flat()) {
      for (const w of words(t)) {
        if (STEMS.some((s) => w.startsWith(s)) || blockedWord(w, WORDS) || blockedWord(w, custom)) return w;
      }
    }
    return null;
  }
  return { find };
}

module.exports = { createFilter, words };
