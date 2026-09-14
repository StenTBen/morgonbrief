/**
 * model.mjs - which model does which job.
 *
 * Until now every call in the pipeline went to one DeepSeek client, and the
 * only way to change that was to edit call sites. This routes by ROLE instead:
 * each call already names what it is doing ('sverige-script', 'feed-cards'),
 * config.json maps those names to a provider and a model, and the call sites
 * stay exactly as they were.
 *
 * WHY ROLE AND NOT SPHERE. The expensive judgement in this pipeline is not
 * spread evenly. Deciding what the brief is about and writing the spoken text
 * are small calls where quality is visible in the output; linking, clustering
 * and card-writing are large calls that mostly restate material already in
 * context. Routing by sphere would pay Opus rates to read RSS. Routing by role
 * puts the money where the judgement is.
 *
 * WHAT STAYS ON DEEPSEEK, and why it is not stinginess: the entry and card
 * writers take five full articles plus retrieved bodies, roughly 36k tokens per
 * call. That is the shape of work DeepSeek is good at and where a frontier
 * model's advantage is smallest - the material is all in context and the job is
 * to compress it faithfully. The measured cost of that layer is about three
 * cents a night for the whole pipeline.
 *
 * THE ROUTER IS A DROP-IN. It returns a function with the same signature as
 * makeDeepseek's: (messages, { json, maxTokens, role }). Every sphere module
 * calls it as `deepseek` and none of them know the difference.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// The Messages API version header. Long-standing and stable, but it was not
// re-verified against the docs in this build - if a call returns 400 with a
// version complaint, this line is the first place to look.
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * JSON schemas for roles routed to Anthropic that ask for { json: true }.
 *
 * Anthropic enforces JSON through output_config.format with a schema rather
 * than through a response_format flag, so a role needs its shape declared here
 * before it can be routed to Claude and still return parseable JSON. Roles
 * without an entry fall back to instructing JSON in the prompt and parsing
 * tolerantly, which works but is not guaranteed - the log says which path ran.
 */
const SCHEMAS = {
  'sverige-select': {
    type: 'object',
    properties: {
      beslut: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            politisk: { type: 'boolean' },
            vikt: { type: 'integer' },
            varfor: { type: 'string' }
          },
          required: ['index', 'politisk', 'vikt', 'varfor'],
          additionalProperties: false
        }
      }
    },
    required: ['beslut'],
    additionalProperties: false
  }
};

/**
 * Pulls the first valid JSON object out of a text response.
 *
 * Only used on the fallback path, where a model was asked for JSON in prose
 * rather than held to a schema. Deliberately narrow: it finds the outermost
 * braces and parses, and throws if that is not valid. Anything cleverer would
 * be repairing malformed output, which hides the failure instead of reporting
 * it.
 */
function parseLooseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`no json object in response: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * An Anthropic client with the same call shape as makeDeepseek's.
 *
 * The two APIs differ in three ways that matter here, all handled inside:
 * the system prompt is a top-level parameter rather than a message with
 * role 'system'; max_tokens is required rather than optional; and the response
 * is an array of content blocks rather than a single message string.
 */
export function makeAnthropic(apiKey, { onUsage } = {}) {
  return async function anthropic(messages, { json = false, maxTokens = 4000, role = 'anthropic', model } = {}) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: String(m.content) }));

    const body = { model, max_tokens: maxTokens, messages: turns };
    if (system) body.system = system;

    const schema = json ? SCHEMAS[role] : null;
    if (schema) {
      body.output_config = { format: { type: 'json_schema', schema } };
    } else if (json) {
      console.log(`  ${role}: no schema registered for this role - falling back to prompt-instructed json`);
    }

    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error(`Anthropic ${res.status} on ${role}: ${(await res.text()).slice(0, 300)}`);

    const data = await res.json();
    onUsage?.(data.usage ?? {}, role, model);

    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (data.stop_reason === 'max_tokens') {
      // Named rather than silently returned. A truncated script reads as a
      // short episode, and a truncated JSON body throws somewhere unrelated.
      console.log(`  ${role}: hit max_tokens (${maxTokens}) - output is cut off`);
    }

    return json ? (schema ? JSON.parse(text) : parseLooseJson(text)) : text;
  };
}

// ---------------------------------------------------------------------- router

/**
 * Matches a role against a rule key, where '*' stands for any run of
 * characters. Lets config say '*-script' once instead of naming four spheres,
 * and keeps a sphere added later on the same routing without a config edit.
 */
export function roleMatches(pattern, role) {
  if (pattern === role) return true;
  if (!pattern.includes('*')) return false;
  const rx = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return rx.test(role);
}

/**
 * Resolves a role to { provider, model }.
 *
 * Exact keys win over wildcards, and among wildcards the longest pattern wins,
 * so 'sverige-script' can be pinned without disturbing '*-script'. Ordering by
 * specificity rather than by position in the file means reordering config.json
 * can never silently change routing.
 */
export function resolveRole(models, role) {
  const rules = Object.entries(models.byRole ?? {});
  const exact = rules.find(([k]) => k === role);
  if (exact) return exact[1];
  const wild = rules
    .filter(([k]) => k.includes('*') && roleMatches(k, role))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return wild ? wild[1] : models.default;
}

/**
 * Builds the one callable the whole pipeline uses.
 *
 * Falls back to the default provider, loudly, when a role is routed somewhere
 * its key is missing. The alternative - throwing - would turn a missing
 * ANTHROPIC_API_KEY into no brief at all, and the brief is worth more than the
 * upgrade. It says so once per role rather than per call, so the log shows the
 * fact without burying the run.
 */
export function makeRouter(config, clients, env = process.env) {
  const models = config.models ?? { default: { provider: 'deepseek', model: 'deepseek-flash' } };
  const warned = new Set();
  const used = new Map();

  return async function route(messages, opts = {}) {
    const role = opts.role ?? 'deepseek';
    let { provider, model } = resolveRole(models, role);

    if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
      if (!warned.has(role)) {
        console.log(`  ${role}: routed to ${model} but ANTHROPIC_API_KEY is unset - using ${models.default.model}`);
        warned.add(role);
      }
      ({ provider, model } = models.default);
    }

    const client = clients[provider];
    if (!client) {
      if (!warned.has(role)) {
        console.log(`  ${role}: no client for provider "${provider}" - using ${models.default.model}`);
        warned.add(role);
      }
      ({ provider, model } = models.default);
    }

    used.set(role, model);

    try {
      return await clients[provider](messages, { ...opts, model });
    } catch (e) {
      // A provider that is reachable but unhappy - a rejected parameter, an
      // exhausted balance, a rate limit - falls back rather than failing.
      //
      // run.mjs catches per sphere, so without this an Anthropic problem would
      // cost every episode at once while the feed carried on: a brief with no
      // audio at all, from one bad request. The fallback costs a worse-written
      // episode instead, which is the right way round.
      //
      // It is loud on purpose. The error text is printed in full, and the
      // ledger records deepseek-flash as the model that actually ran, so a
      // fallback night is visible in two places rather than inferred from the
      // writing feeling flat.
      if (provider === models.default.provider) throw e;
      console.log(`  ${role}: ${model} failed, falling back to ${models.default.model} - ${e.message}`);
      return clients[models.default.provider](messages, { ...opts, model: models.default.model });
    }
  };
}
