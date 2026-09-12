/**
 * speakable() — deterministic normalization of a finished script into text a
 * Swedish TTS voice can say correctly.
 *
 * Not a model pass. A model rewriting the finished script is a new place where
 * figures and names can drift, and that fights the rule that the model only
 * restates what the material gave it. Rules and a lexicon cannot invent a
 * number.
 *
 * The output is Swedish respelling, never IPA: custom pronunciations are
 * explicitly unavailable for sv-SE in Cloud TTS, so pronunciation has to be
 * solved in the text.
 *
 * The most important function here is findUnresolved(). Without a log of what
 * the lexicon did not know, a repair loop costs the same every night forever
 * and never improves.
 */

const ONES = ['noll', 'ett', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta', 'nio',
  'tio', 'elva', 'tolv', 'tretton', 'fjorton', 'femton', 'sexton', 'sjutton', 'arton', 'nitton'];
const TENS = ['', '', 'tjugo', 'trettio', 'fyrtio', 'femtio', 'sextio', 'sjuttio', 'åttio', 'nittio'];

export function integerToSwedish(n) {
  if (n < 0) return `minus ${integerToSwedish(-n)}`;
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const r = n % 10;
    return r === 0 ? TENS[t] : `${TENS[t]}${ONES[r]}`;
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    const head = h === 1 ? 'etthundra' : `${ONES[h]}hundra`;
    return r === 0 ? head : `${head}${integerToSwedish(r)}`;
  }
  if (n < 1000000) {
    const th = Math.floor(n / 1000);
    const r = n % 1000;
    const head = th === 1 ? 'ettusen' : `${integerToSwedish(th)}tusen`;
    return r === 0 ? head : `${head} ${integerToSwedish(r)}`;
  }
  return String(n); // out of range: left alone deliberately, rather than guessed at
}

// Swedish decimals use a comma. Left as digits, "20,4" is read as two numbers
// with a pause between them — one of the clearest machine tells in the read.
export function decimalToSwedish(intPart, fracPart) {
  const digits = fracPart.split('').map((d) => ONES[Number(d)]).join(' ');
  return `${integerToSwedish(Number(intPart))} komma ${digits}`;
}

// Order matters: the most specific pattern has to match before the bare-integer
// rule swallows its digits.
const UNIT_RULES = [
  [/(\d+),(\d+)\s*%/g, (_, a, b) => `${decimalToSwedish(a, b)} procent`],
  [/(\d+)\s*%/g, (_, a) => `${integerToSwedish(Number(a))} procent`],
  [/(\d+),(\d+)\s*(mdr|miljarder)\b/gi, (_, a, b) => `${decimalToSwedish(a, b)} miljarder`],
  [/(\d+)\s*(mdr|miljarder)\b/gi, (_, a) => `${integerToSwedish(Number(a))} miljarder`],
  [/(\d+)\s*(mkr|miljoner)\b/gi, (_, a) => `${integerToSwedish(Number(a))} miljoner`],
  [/(\d+)\s*(kr|SEK)\b/g, (_, a) => `${integerToSwedish(Number(a))} kronor`],
  [/(\d+)\s*(USD|dollar)\b/gi, (_, a) => `${integerToSwedish(Number(a))} dollar`],
  [/(\d+),(\d+)(?!\d)/g, (_, a, b) => decimalToSwedish(a, b)],
  [/\b(\d{1,6})\b/g, (_, a) => integerToSwedish(Number(a))],
];

// Party letters read as letters are a coin flip. Expanding them is deterministic
// and reads the way a host would say it anyway.
const PARTY_EXPANSIONS = {
  S: 'Socialdemokraterna',
  M: 'Moderaterna',
  SD: 'Sverigedemokraterna',
  C: 'Centerpartiet',
  V: 'Vänsterpartiet',
  L: 'Liberalerna',
  KD: 'Kristdemokraterna',
  MP: 'Miljöpartiet',
};

export function expandParties(text) {
  const expanded = text.replace(/\((S|M|SD|C|V|L|KD|MP)\)/g, (m, p) => {
    const full = PARTY_EXPANSIONS[p];
    return full ? ` från ${full}` : m;
  });

  // "Moderaterna (M) fick..." would otherwise become "Moderaterna från
  // Moderaterna". The rule is written for "Ulf Kristersson (M)", where the
  // preceding words are a person; when the party name is already there, the
  // expansion is redundant rather than wrong, so it is collapsed.
  const names = Object.values(PARTY_EXPANSIONS).join('|');
  return expanded
    .replace(new RegExp(`\\b(${names})\\s+från\\s+\\1\\b`, 'g'), '$1')
    .replace(/\s{2,}/g, ' ');
}

/**
 * Which tokens did the lexicon not know?
 *
 * There is no Swedish dictionary available here, and requiring one would block
 * the whole mechanism. So this does not ask "is this a Swedish word" — it asks
 * "is this a name or an acronym", which is the actual risk class:
 *
 *   - capitalised and NOT at the start of a sentence  -> proper noun
 *   - two or more capitals in a row                   -> acronym
 *
 * Ordinary Swedish prose produces almost no false positives under those two
 * rules, and the tokens it does catch are exactly the ones a Swedish voice
 * mispronounces.
 */
export function findUnresolved(text, lexicon = {}) {
  const unresolved = new Set();
  const known = new Set(Object.keys(lexicon).map((k) => k.toLowerCase()));

  // Split into sentences so "first word of a sentence" is knowable.
  for (const sentence of text.split(/(?<=[.!?:])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/);
    words.forEach((raw, i) => {
      const token = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (token.length < 2) return;
      if (known.has(token.toLowerCase())) return;

      const isAcronym = /^[\p{Lu}]{2,}$/u.test(token);
      const isProperNoun = i > 0 && /^[\p{Lu}][\p{Ll}]/u.test(token);
      if (isAcronym || isProperNoun) unresolved.add(token);
    });
  }
  return [...unresolved];
}

export function applyLexicon(text, lexicon) {
  let out = text;
  // Longest first, so "New York Times" wins over "New York".
  for (const key of Object.keys(lexicon).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    out = out.replace(re, lexicon[key]);
  }
  return out;
}

// Pause tags only work in the markup input field. Sent in the plain text field
// they are read aloud, literally.
export function insertPauses(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' [long pause] ')
    .replace(/([.!?])\s+(?=[\p{Lu}])/gu, '$1 [medium pause] ');
}

/**
 * @param {string} script
 * @param {object} opts
 * @param {Record<string,string>} opts.lexicon  term -> Swedish respelling
 * @param {(tokens:string[])=>void} [opts.onUnresolved]
 * @returns {{ markup: string, unresolved: string[] }}
 */
export function speakable(script, { lexicon = {}, onUnresolved } = {}) {
  // Detection runs on the ORIGINAL script, before any substitution.
  //
  // Run it on the output instead and the log fills with the pipeline's own
  // work: every generated number word and every lexicon replacement comes back
  // as an unknown token. The signal-to-noise ratio is then bad from day one,
  // nobody reads the log, and the lexicon never grows — which kills the only
  // mechanism that makes the repair loop an investment rather than a
  // subscription.
  const unresolved = findUnresolved(script, lexicon);
  if (unresolved.length && onUnresolved) onUnresolved(unresolved);

  let text = expandParties(script);
  text = applyLexicon(text, lexicon);
  for (const [re, fn] of UNIT_RULES) text = text.replace(re, fn);

  return { markup: insertPauses(text), unresolved };
}
