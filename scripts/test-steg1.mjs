/**
 * Offline checks for the things that fail silently.
 *
 * No network, no model calls, no API keys - it runs in under a second and is
 * meant to sit in front of the nightly build in brief.yml. Every case here is
 * something that has actually gone wrong or would cost money to discover: a
 * price table keyed to a model nobody calls, a json prompt DeepSeek rejects, a
 * non-political story chosen as Sveriges politik, a role routed to Opus with no
 * rate behind it.
 *
 * Paths are relative to this file's location in scripts/, so the repo layout is
 * part of what is being tested.
 */

import assert from 'node:assert/strict';
import { clusterItems, makeDeepseek, scriptSystemPrompt, SPHERE_KNOWLEDGE_DOMAIN } from './lib.mjs';
import { capPerSource, queryFor, topicQueryFor, chooseClusters, selectStories, PROVENANCE } from './sphere-sverige.mjs';
import { matchesDomain, hostOf, makeResearcher, siteClause } from './research.mjs';
import { PRICES, costOf, isPeak, startRun, recordCall } from './ledger.mjs';
import { resolveRole, roleMatches, makeRouter, makeAnthropic } from './model.mjs';

const ok = [];
const t = (name, fn) => { try { fn(); ok.push(`PASS  ${name}`); } catch (e) { ok.push(`FAIL  ${name}: ${e.message}`); } };

// --- clustering survived the move ------------------------------------------
t('clusterItems groups four outlets on one story', () => {
  const items = [
    { source: 'DN', title: 'Regeringen lägger fram budgetproposition med skattesänkning', summary: 'Finansministern presenterade budgeten idag', link: 'a' },
    { source: 'SvD', title: 'Budgetproposition från regeringen innehåller skattesänkning', summary: 'Finansministern presenterade budgeten', link: 'b' },
    { source: 'Aftonbladet', title: 'Skattesänkning i regeringens budgetproposition', summary: 'Finansministern presenterade budgeten idag', link: 'c' },
    { source: 'Barometern', title: 'Vindkraftverk stoppas efter överklagande i Kalmar', summary: 'Mark- och miljödomstolen prövar ärendet', link: 'd' }
  ];
  const c = clusterItems(items);
  assert.equal(c.length, 2, `expected 2 clusters, got ${c.length}`);
  assert.equal(c[0].sourceCount, 3);
  assert.ok(c[0].id && c[0].id.length === 16, 'cluster id should be a 16-char hash');
});

// --- the per-source cap ------------------------------------------------------
t('capPerSource limits one outlet without dropping others', () => {
  const items = [
    ...Array.from({ length: 20 }, (_, i) => ({ source: 'hd.se', title: `t${i}`, link: `h${i}` })),
    ...Array.from({ length: 3 }, (_, i) => ({ source: 'DN', title: `d${i}`, link: `d${i}` }))
  ];
  const out = capPerSource(items, 12);
  assert.equal(out.filter((x) => x.source === 'hd.se').length, 12);
  assert.equal(out.filter((x) => x.source === 'DN').length, 3);
});
t('capPerSource is a no-op when unset', () => {
  const items = [{ source: 'a', title: 'x' }, { source: 'a', title: 'y' }];
  assert.equal(capPerSource(items, 0).length, 2);
  assert.equal(capPerSource(items, undefined).length, 2);
});

// --- query building ----------------------------------------------------------
t('queryFor strips stopwords and punctuation from the lead headline', () => {
  const q = queryFor({ items: [{ title: 'Regeringen säger att budgeten ska läggas fram – efter kritiken från oppositionen' }] });
  assert.ok(!/\bsäger\b|\batt\b|\bska\b|\befter\b/.test(q), `stopwords survived: ${q}`);
  assert.ok(/Regeringen/.test(q) && /budgeten/.test(q), `lost the subject: ${q}`);
  assert.ok(!/[–—]/.test(q), 'punctuation survived');
});

// --- domain matching ---------------------------------------------------------
t('matchesDomain accepts subdomains and rejects lookalikes', () => {
  assert.equal(matchesDomain('kvartal.se', 'kvartal.se'), true);
  assert.equal(matchesDomain('www.kvartal.se'.replace(/^www\./, ''), 'kvartal.se'), true);
  assert.equal(matchesDomain('artiklar.kvartal.se', 'kvartal.se'), true);
  assert.equal(matchesDomain('notkvartal.se', 'kvartal.se'), false, 'lookalike domain matched');
  assert.equal(matchesDomain('kvartal.se.evil.com', 'kvartal.se'), false, 'suffix attack matched');
});
t('hostOf drops www and survives junk', () => {
  assert.equal(hostOf('https://www.timbro.se/artikel/1'), 'timbro.se');
  assert.equal(hostOf('not a url'), '');
});

// --- the researcher degrades to nothing --------------------------------------
t('makeResearcher returns empty with no key', async () => {
  const r = makeResearcher({ research: { provider: 'brave' } }, {});
  assert.equal(r.live, false);
});

// --- the json-mode guard: the bug that cost the election window --------------
t('makeDeepseek appends the json requirement when no prompt mentions it', async () => {
  let body = null;
  global.fetch = async (_u, opts) => { body = JSON.parse(opts.body); return {
    ok: true, json: async () => ({ usage: {}, choices: [{ finish_reason: 'stop', message: { content: '{"a":1}' } }] })
  }; };
  const ds = makeDeepseek('k');
  const out = await ds([{ role: 'system', content: 'Write a segment.' }, { role: 'user', content: 'Go.' }], { json: true });
  assert.deepEqual(out, { a: 1 });
  const joined = body.messages.map((m) => m.content).join(' ');
  assert.ok(/json/i.test(joined), 'guard did not fire - this is the 400 that produced 0 published entries');
  assert.equal(body.messages.length, 2, 'guard must edit the last message, not add one');
});
t('makeDeepseek leaves prompts that already say json alone', async () => {
  let body = null;
  global.fetch = async (_u, opts) => { body = JSON.parse(opts.body); return {
    ok: true, json: async () => ({ usage: {}, choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })
  }; };
  const ds = makeDeepseek('k');
  const msgs = [{ role: 'system', content: 'Return strict JSON only.' }, { role: 'user', content: 'Go.' }];
  await ds(msgs, { json: true });
  assert.equal(body.messages[1].content, 'Go.', 'untouched prompt was modified');
});
t('makeDeepseek does not touch non-json calls', async () => {
  let body = null;
  global.fetch = async (_u, opts) => { body = JSON.parse(opts.body); return {
    ok: true, json: async () => ({ usage: {}, choices: [{ finish_reason: 'stop', message: { content: 'text' } }] })
  }; };
  const ds = makeDeepseek('k');
  await ds([{ role: 'user', content: 'Skriv avsnittet.' }], { json: false });
  assert.equal(body.messages[0].content, 'Skriv avsnittet.');
});

// --- end-to-end selection ----------------------------------------------------
t('chooseClusters caps, clusters and filters by minSources', () => {
  const now = new Date().toISOString();
  const coverage = [
    ...Array.from({ length: 30 }, (_, i) => ({ source: 'hd.se', title: `Kommunfullmäktige beslutar om lokalfråga nummer ${i} i Helsingborg`, summary: 'lokal notis', link: `h${i}`, publishedAt: now })),
    { source: 'DN', title: 'Statsministern kallar till presskonferens om regeringsbildningen', summary: 'Beskedet kom under måndagen', link: 'x1', publishedAt: now },
    { source: 'SvD', title: 'Presskonferens om regeringsbildningen kallar statsministern till', summary: 'Beskedet kom under måndagen', link: 'x2', publishedAt: now }
  ];
  const clusters = chooseClusters(coverage, { minSources: 2, maxItemsPerSource: 12 }, { maxCoverageItems: 300 });
  assert.ok(clusters.length >= 1, 'the two-outlet story should survive');
  assert.equal(clusters[0].sourceCount, 2);
});

t('PROVENANCE has the four tiers in order', () => {
  assert.deepEqual(PROVENANCE, ['verified', 'reported', 'circulating', 'tolkning']);
});

// --- the ledger: the price table that has never priced anything -------------
t('PRICES has a key matching the model lib.mjs actually sends', () => {
  assert.ok(PRICES['deepseek-flash'], 'deepseek-flash missing - every run reports UNKNOWN');
});
t('costOf returns a real number for deepseek-flash', () => {
  const c = costOf({ model: 'deepseek-flash', inputTokens: 1e6, outputTokens: 1e6, at: '2026-09-14T00:00:00Z' });
  assert.notEqual(c, null, 'still unpriced');
  assert.ok(Math.abs(c - 0.75) < 1e-9, `off-peak 1M+1M should be 0.15+0.60=0.75, got ${c}`);
});
t('peak costs exactly double', () => {
  const off = costOf({ model: 'deepseek-flash', inputTokens: 1e6, outputTokens: 1e6, at: '2026-09-14T00:00:00Z' });
  const on  = costOf({ model: 'deepseek-flash', inputTokens: 1e6, outputTokens: 1e6, at: '2026-09-15T02:00:00Z' });
  assert.ok(Math.abs(on - off * 2) < 1e-9, `peak ${on} vs off-peak ${off}`);
});
t('the winter clock change moves the nightly run into peak', () => {
  // brief.yml fires 02:00 Europe/Stockholm. Summer CEST = 00:00 UTC, winter CET = 01:00 UTC.
  assert.equal(isPeak('2026-09-15T00:00:00Z'), false, 'summer run should be off-peak');
  assert.equal(isPeak('2026-11-10T01:00:00Z'), true, 'winter run should land in peak');
});
t('weekends are off-peak even inside the peak hours', () => {
  assert.equal(isPeak('2026-09-19T02:00:00Z'), false, 'Saturday 02:00 UTC');
  assert.equal(isPeak('2026-09-20T07:00:00Z'), false, 'Sunday 07:00 UTC');
});
t('deprecated deepseek-chat stays unpriced rather than priced as flash', () => {
  assert.equal(costOf({ model: 'deepseek-chat', inputTokens: 1e6, outputTokens: 1e6 }), null);
});
t('an unknown model still poisons the total honestly', () => {
  assert.equal(costOf({ model: 'gpt-whatever', inputTokens: 1e6 }), null);
});
t('recordCall stamps the call so it can be re-priced correctly', () => {
  const run = startRun('2026-09-14');
  const c = recordCall(run, { role: 'sverige-entry', model: 'deepseek-flash', usage: { prompt_tokens: 1000, completion_tokens: 500 } });
  assert.ok(c.at, 'no timestamp on the call');
  assert.notEqual(c.costUsd, null, 'call priced as unknown');
  assert.equal(c.role, 'sverige-entry');
});
t('a realistic night stays far inside the dollar', () => {
  const run = startRun('2026-09-14');
  // 4 sverige calls + congress + crypto + world + feed clustering + feed cards.
  for (let i = 0; i < 9; i++) {
    recordCall(run, { role: 'x', model: 'deepseek-flash', usage: { prompt_tokens: 60000, completion_tokens: 4000 } });
  }
  const total = run.calls.reduce((a, c) => a + c.costUsd, 0);
  assert.ok(total < 0.25, `nightly model spend ${total.toFixed(4)} - check the budget`);
  console.log(`       [estimated nightly DeepSeek spend at these rates: $${total.toFixed(4)}]`);
});

// --- the calibration loop: the number nothing used to read ------------------
const profileLevels = {
  _scale: '1 to 5. 1 = explain the basics. 5 = assume he knows the field.',
  swedishPolitics: { level: 4 },
  congressionalMachinery: { level: 2, note: 'explain procedure, never assume it' },
  marketsAndCrypto: { level: 5, note: 'never explain what a rate cut is' },
  internationalPolitics: { level: 4 }
};
const cfg = (levels) => ({
  listener: { general: 'A Swedish manager.', knowledge: { sverige: 'HIGH on Swedish politics.' }, levels },
  delivery: 'Measured.',
  segmentStructure: ['ANNOUNCE: ...'],
  craft: ['Attribute claims.']
});

t('every sphere maps to a domain that exists in profile.json', () => {
  for (const [sphere, domain] of Object.entries(SPHERE_KNOWLEDGE_DOMAIN)) {
    assert.ok(profileLevels[domain], `${sphere} -> ${domain} is not a key in profile.json`);
  }
});
t('the level reaches the prompt', () => {
  const p = scriptSystemPrompt({ id: 'sverige', label: 'Sveriges politik' }, cfg(profileLevels));
  assert.ok(/CALIBRATION/.test(p), 'no calibration block - the loop still changes nothing');
  assert.ok(/level for this subject to 4 of 5/.test(p), 'the number did not arrive');
  assert.ok(/follow the number/.test(p), 'no rule for which calibration wins');
  assert.ok(/HIGH on Swedish politics/.test(p), 'the prose was lost');
});
t('a per-domain note travels with the level', () => {
  const p = scriptSystemPrompt({ id: 'congress', label: 'Politik' }, cfg(profileLevels));
  assert.ok(/to 2 of 5/.test(p));
  assert.ok(/explain procedure, never assume it/.test(p));
});
t('a moved level changes the prompt', () => {
  const before = scriptSystemPrompt({ id: 'sverige', label: 'X' }, cfg(profileLevels));
  const after = scriptSystemPrompt({ id: 'sverige', label: 'X' },
    cfg({ ...profileLevels, swedishPolitics: { level: 5 } }));
  assert.notEqual(before, after, 'moving the level did not change the prompt - the loop is still inert');
  assert.ok(/to 5 of 5/.test(after));
});
t('no levels means the old prompt, not a broken one', () => {
  const p = scriptSystemPrompt({ id: 'sverige', label: 'X' }, cfg(undefined));
  assert.ok(!/CALIBRATION/.test(p));
  assert.ok(/HIGH on Swedish politics/.test(p), 'lost the prose when levels were absent');
});
t('the real profile.json renders no implementation detail into the prompt', async () => {
  const fs = await import('node:fs/promises');
  const real = JSON.parse(await fs.readFile(new URL('../profile.json', import.meta.url), 'utf8'));
  const p = scriptSystemPrompt({ id: 'sverige', label: 'Sveriges politik' },
    cfg(real.interests.knowledgeLevel));
  const block = p.slice(p.indexOf('CALIBRATION'), p.indexOf('DELIVERY'));
  assert.ok(!/\w+\(\)/.test(block), `a code identifier reached the prompt: ${block.match(/\w+\(\)/)}`);
  assert.ok(!/scripts\//.test(block), 'a file path reached the prompt');
  assert.ok(/to 4 of 5/.test(block), 'the level stopped arriving');
});
t('the non-rendered keys stay out of the prompt', async () => {
  const fs = await import('node:fs/promises');
  const real = JSON.parse(await fs.readFile(new URL('../profile.json', import.meta.url), 'utf8'));
  const p = scriptSystemPrompt({ id: 'sverige', label: 'X' }, cfg(real.interests.knowledgeLevel));
  assert.ok(!/hand-edit/.test(p), '_calibration leaked into the prompt');
  assert.ok(!/WRITE FOR THE MODEL/.test(p), '_rendered leaked into the prompt');
});
t('an unmapped sphere degrades quietly', () => {
  const p = scriptSystemPrompt({ id: 'football', label: 'Fotboll' }, cfg(profileLevels));
  assert.ok(!/CALIBRATION/.test(p));
});

// --- the selection gate: the wedding bombing ---------------------------------
// The three clusters the first live run actually chose, plus filler.
const liveClusters = [
  { id: 'a', sourceCount: 9, items: [{ title: 'Valet 2026: Så röstade dina grannar', summary: 'Kartan över valdistrikten' }] },
  { id: 'b', sourceCount: 4, items: [{ title: 'Preliminärt valresultat: Oppositionens ledning ökar', summary: 'Rösterna räknas' }] },
  { id: 'c', sourceCount: 3, items: [{ title: 'Bombades före bröllopet: ”En spektakulär dag”', summary: 'Paret vigdes ändå' }] },
  { id: 'd', sourceCount: 3, items: [{ title: 'Regeringen backar om utredningen', summary: 'Efter kritik från lagrådet' }] }
];
const fakeDeepseek = (beslut) => async () => ({ beslut });
const L4 = { selectFrom: 10, tokensSelect: 4000 };
const sph = { maxItemsPerEpisode: 3 };

t('a non-political cluster is dropped however many outlets carried it', async () => {
  const chosen = await selectStories(liveClusters, sph, {}, {
    L: L4,
    deepseek: fakeDeepseek([
      { index: 0, politisk: true, vikt: 2, varfor: 'valresultat, men referat' },
      { index: 1, politisk: true, vikt: 3, varfor: 'mandatläget rör regeringsbildningen' },
      { index: 2, politisk: false, vikt: 1, varfor: 'brott, ingen offentlig makt inblandad' },
      { index: 3, politisk: true, vikt: 5, varfor: 'lagrådskritik tvingar fram en omarbetning' }
    ])
  });
  assert.equal(chosen.length, 3);
  assert.ok(!chosen.some((c) => c.cluster.id === 'c'), 'the wedding bombing survived the gate');
  assert.equal(chosen[0].cluster.id, 'd', 'weight should outrank source count');
  assert.ok(chosen[0].reason.length > 0, 'no reason recorded');
});
t('weight beats source count, not the other way round', async () => {
  const chosen = await selectStories(liveClusters, sph, {}, {
    L: L4,
    deepseek: fakeDeepseek([
      { index: 0, politisk: true, vikt: 1, varfor: 'rent referat' },
      { index: 3, politisk: true, vikt: 5, varfor: 'verkliga följder' }
    ])
  });
  assert.equal(chosen[0].cluster.id, 'd', '9-source headline story outranked a weightier one');
});
t('fewer than three political stories gives a shorter episode, not filler', async () => {
  const chosen = await selectStories(liveClusters, sph, {}, {
    L: L4,
    deepseek: fakeDeepseek([
      { index: 1, politisk: true, vikt: 4, varfor: 'ok' },
      { index: 0, politisk: false, vikt: 1, varfor: 'nej' },
      { index: 2, politisk: false, vikt: 1, varfor: 'nej' },
      { index: 3, politisk: false, vikt: 1, varfor: 'nej' }
    ])
  });
  assert.equal(chosen.length, 1, 'the gate padded the episode');
});
t('an invented index cannot select a cluster', async () => {
  const chosen = await selectStories(liveClusters, sph, {}, {
    L: L4,
    deepseek: fakeDeepseek([
      { index: 99, politisk: true, vikt: 5, varfor: 'hallucinerat' },
      { index: -1, politisk: true, vikt: 5, varfor: 'hallucinerat' },
      { index: 3, politisk: true, vikt: 2, varfor: 'äkta' }
    ])
  });
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].cluster.id, 'd');
});
t('a duplicated index is counted once', async () => {
  const chosen = await selectStories(liveClusters, sph, {}, {
    L: L4,
    deepseek: fakeDeepseek([
      { index: 3, politisk: true, vikt: 5, varfor: 'en' },
      { index: 3, politisk: true, vikt: 5, varfor: 'två' }
    ])
  });
  assert.equal(chosen.length, 1);
});
t('an unusable response throws so the episode fails closed', async () => {
  await assert.rejects(
    () => selectStories(liveClusters, sph, {}, { L: L4, deepseek: async () => ({ beslut: [] }) }),
    /no usable decisions/
  );
});
t('a cluster the model never judged is not political by default', async () => {
  const chosen = await selectStories(liveClusters, sph, {}, {
    L: L4,
    deepseek: fakeDeepseek([{ index: 0, politisk: true, vikt: 3, varfor: 'ok' }])
  });
  assert.equal(chosen.length, 1, 'unjudged clusters leaked in');
});

// --- tiered retrieval --------------------------------------------------------
t('siteClause builds an OR chain and reports what it dropped', () => {
  const { clause, used, dropped } = siteClause(['kvartal.se', 'timbro.se', 'sns.se']);
  assert.equal(clause, 'site:kvartal.se OR site:timbro.se OR site:sns.se');
  assert.equal(used, 3);
  assert.equal(dropped, 0);
});
t('siteClause stays inside the budget instead of sending an over-long query', () => {
  const many = Array.from({ length: 40 }, (_, i) => `domain-nummer-${i}.se`);
  const { clause, used, dropped } = siteClause(many, 360);
  assert.ok(clause.length <= 360, `clause is ${clause.length} chars`);
  assert.ok(dropped > 0, 'nothing was dropped from 40 domains');
  assert.equal(used + dropped, 40);
});
t('the real domain lists both fit in one query', async () => {
  const fs = await import('node:fs/promises');
  const sph = JSON.parse(await fs.readFile(new URL('../spheres/sverige.json', import.meta.url), 'utf8'));
  for (const key of ['analysisDomains', 'documentDomains']) {
    const topic = 'regeringen utredning lagrådet migration';
    const { dropped, clause } = siteClause(sph[key], 360 - topic.length - 1);
    assert.equal(dropped, 0, `${key}: ${dropped} domain(s) would not fit`);
    const q = `${topic} ${clause}`;
    assert.ok(q.length <= 400, `${key}: query is ${q.length} chars, Brave's ceiling is 400`);
    assert.ok(q.split(/\s+/).length <= 50, `${key}: ${q.split(/\s+/).length} words, ceiling is 50`);
  }
});
t('the two domain lists do not overlap', async () => {
  const fs = await import('node:fs/promises');
  const sph = JSON.parse(await fs.readFile(new URL('../spheres/sverige.json', import.meta.url), 'utf8'));
  const both = sph.analysisDomains.filter((d) => sph.documentDomains.includes(d));
  assert.deepEqual(both, [], 'a domain in both lists could carry commentary under "verified"');
});

// --- the topic query: why the first version found nothing --------------------
t('topicQueryFor drops the headline and keeps the subject', () => {
  const cluster = { items: [
    { title: 'Regeringen backar om utredningen efter hård kritik från Lagrådet' },
    { title: 'Lagrådet sågar förslaget — utredningen görs om' }
  ] };
  const topic = topicQueryFor(cluster);
  const words = topic.split(/\s+/);
  assert.ok(words.length <= 4, `too long for a restricted search: ${topic}`);
  assert.ok(/Lagrådet/i.test(topic), `lost the institution: ${topic}`);
  assert.ok(!/^Regeringen/.test(topic), 'took a sentence-opening capital as a proper noun');
  assert.ok(topic.length < queryFor(cluster).length, 'topic query is not narrower than the open query');
});
t('topicQueryFor survives a headline with no proper nouns', () => {
  const topic = topicQueryFor({ items: [{ title: 'nya regler för sjukförsäkringen träder i kraft' }] });
  assert.ok(topic.length > 0, 'returned nothing');
  assert.ok(/sjukförsäkringen/.test(topic), `lost the longest specific word: ${topic}`);
});

// --- model routing -----------------------------------------------------------
const ALL_ROLES = ['congress-linking','congress-cards','congress-script','congress-fallback-script',
  'crypto-linking','crypto-cards','crypto-script','world-clustering','world-cards','world-script',
  'sverige-select','sverige-entry','sverige-script','feed-clustering','feed-cards'];

t('every role in the pipeline resolves to a priced model', async () => {
  const fs = await import('node:fs/promises');
  const cfg = JSON.parse(await fs.readFile(new URL('../config.json', import.meta.url), 'utf8'));
  for (const r of ALL_ROLES) {
    const { model } = resolveRole(cfg.models, r);
    const c = costOf({ model, inputTokens: 1000, outputTokens: 100, at: '2026-09-15T00:00:00Z' });
    assert.notEqual(c, null, `${r} -> ${model} has no rate in PRICES`);
  }
});
t('all four spheres write their script on Opus', async () => {
  const fs = await import('node:fs/promises');
  const cfg = JSON.parse(await fs.readFile(new URL('../config.json', import.meta.url), 'utf8'));
  for (const r of ['congress-script','crypto-script','world-script','sverige-script']) {
    assert.equal(resolveRole(cfg.models, r).model, 'claude-opus-5', `${r} is not on Opus`);
  }
});
t('the reading-heavy roles stay off Opus', async () => {
  const fs = await import('node:fs/promises');
  const cfg = JSON.parse(await fs.readFile(new URL('../config.json', import.meta.url), 'utf8'));
  for (const r of ['sverige-entry','feed-cards','world-cards','congress-cards','crypto-cards','feed-clustering']) {
    assert.equal(resolveRole(cfg.models, r).provider, 'deepseek', `${r} would pay Opus rates to read RSS`);
  }
});
t('an exact key beats a wildcard regardless of file order', () => {
  const models = { default: { provider: 'deepseek', model: 'd' },
    byRole: { '*-script': { provider: 'a', model: 'wild' }, 'world-script': { provider: 'a', model: 'exact' } } };
  assert.equal(resolveRole(models, 'world-script').model, 'exact');
  assert.equal(resolveRole(models, 'crypto-script').model, 'wild');
});
t('roleMatches does not treat a role as a regex', () => {
  assert.equal(roleMatches('*-script', 'sverige-script'), true);
  assert.equal(roleMatches('*-script', 'sverige-scriptx'), false);
  assert.equal(roleMatches('sverige-entry', 'sverige-entry'), true);
  assert.equal(roleMatches('sverige.entry', 'sverige-entry'), false, 'the dot was treated as a wildcard');
});
t('a missing ANTHROPIC_API_KEY falls back instead of killing the brief', async () => {
  const calls = [];
  const clients = {
    deepseek: async (_m, o) => { calls.push(o.model); return 'text'; },
    anthropic: async () => { throw new Error('should not be called'); }
  };
  const models = { default: { provider: 'deepseek', model: 'deepseek-flash' },
    byRole: { '*-script': { provider: 'anthropic', model: 'claude-opus-5' } } };
  const route = makeRouter({ models }, clients, {});
  assert.equal(await route([], { role: 'sverige-script' }), 'text');
  assert.deepEqual(calls, ['deepseek-flash']);
});
t('the router passes the resolved model down to the client', async () => {
  let got = null;
  const clients = { deepseek: async () => 'x', anthropic: async (_m, o) => { got = o.model; return 'y'; } };
  const models = { default: { provider: 'deepseek', model: 'deepseek-flash' },
    byRole: { '*-script': { provider: 'anthropic', model: 'claude-opus-5' } } };
  const route = makeRouter({ models }, clients, { ANTHROPIC_API_KEY: 'k' });
  await route([], { role: 'world-script' });
  assert.equal(got, 'claude-opus-5');
});

t('a failing Anthropic call costs the wording, not the episode', async () => {
  const clients = {
    deepseek: async () => 'fallback text',
    anthropic: async () => { throw new Error('Anthropic 400: output_config not recognised'); }
  };
  const models = { default: { provider: 'deepseek', model: 'deepseek-flash' },
    byRole: { '*-script': { provider: 'anthropic', model: 'claude-opus-5' } } };
  const route = makeRouter({ models }, clients, { ANTHROPIC_API_KEY: 'k' });
  assert.equal(await route([], { role: 'sverige-script' }), 'fallback text');
});
t('a failing default provider still throws', async () => {
  const clients = { deepseek: async () => { throw new Error('DeepSeek 500'); } };
  const models = { default: { provider: 'deepseek', model: 'deepseek-flash' }, byRole: {} };
  const route = makeRouter({ models }, clients, {});
  await assert.rejects(() => route([], { role: 'feed-cards' }), /DeepSeek 500/);
});

// --- the Anthropic client ----------------------------------------------------
t('system messages become the top-level system parameter', async () => {
  let body = null;
  global.fetch = async (_u, o) => { body = JSON.parse(o.body); return {
    ok: true, json: async () => ({ content: [{ type: 'text', text: 'hej' }], usage: { input_tokens: 5, output_tokens: 2 } })
  }; };
  const a = makeAnthropic('k');
  const out = await a([{ role: 'system', content: 'REGLER' }, { role: 'user', content: 'Skriv.' }],
    { maxTokens: 500, role: 'sverige-script', model: 'claude-opus-5' });
  assert.equal(out, 'hej');
  assert.equal(body.system, 'REGLER');
  assert.equal(body.messages.length, 1, 'the system message was left in messages');
  assert.equal(body.max_tokens, 500);
});
t('a json role with a schema asks for structured output', async () => {
  let body = null;
  global.fetch = async (_u, o) => { body = JSON.parse(o.body); return {
    ok: true, json: async () => ({ content: [{ type: 'text', text: '{"beslut":[]}' }], usage: {} })
  }; };
  const a = makeAnthropic('k');
  const out = await a([{ role: 'user', content: 'x' }], { json: true, role: 'sverige-select', model: 'claude-opus-5' });
  assert.deepEqual(out, { beslut: [] });
  assert.equal(body.output_config?.format?.type, 'json_schema');
});
t('usage is reported with the model that produced it', async () => {
  const seen = [];
  global.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 100, output_tokens: 10 } }) });
  const a = makeAnthropic('k', { onUsage: (u, r, m) => seen.push([r, m, u.input_tokens]) });
  await a([{ role: 'user', content: 'x' }], { role: 'world-script', model: 'claude-opus-5' });
  assert.deepEqual(seen, [['world-script', 'claude-opus-5', 100]]);
});

await new Promise((r) => setTimeout(r, 50));
console.log(ok.join('\n'));
console.log(`\n${ok.filter((l) => l.startsWith('PASS')).length}/${ok.length} passed`);
process.exit(ok.some((l) => l.startsWith('FAIL')) ? 1 : 0);
