/* LoveMi Evidence Mapper: standalone proposal; CommonJS, Node >=18.
 * Does NOT change the registration state machine. Only call during profile generation.
 */
'use strict';
const SCENES = ['expect_ta', 'love_style', 'p7'];
const SUBJECTS = ['自己', 'TA', '关系', '候选反馈'];
const KINDS = [
  'partner_preference', 'attraction', 'self_interaction',
  'relationship_expectation', 'relationship_experience',
  'daily_life', 'other'
];
const normalized = x => String(x ?? '').normalize('NFKC').replace(/[\p{P}\p{S}\p{Z}\p{C}\s]/gu, '').toLowerCase();
const uniq = arr => [...new Set(arr)];
const isNonempty = v => typeof v === 'string' && !!v.trim();
const isContentQuote = v => isNonempty(v) && normalized(v).length > 0;

// Reuse Q12 from the existing, short in-session dialog; no external fetch or new model call.
// Do not infer task identity from historic question wording.
function q12DialogText(st, options = {}) {
  if (options.includeQ12Raw === false) return null;
  const q12MaxChars = Math.max(1, Math.min(320, Number(options.q12MaxChars) || 320));
  const rows = Array.isArray(st.dialog) ? st.dialog : [];
  const valid = rows.filter(d => d && d.task_id === 'Q12' &&
    ['answered','partial'].includes(d.answer_status) && isNonempty(d.a));
  const last = valid.at(-1);
  if (!last) return null;
  // PII filtering is a defense in depth; production should reuse central PII filters.
  // Redact before truncation so a phone number straddling the limit cannot leak
  // as an incomplete number that no longer matches the PII filter.
  const raw = String(last.a)
    .replace(/(?:\+?86[-\s]?)?1[3-9]\d{9}/g, '【联系方式已省略】')
    .replace(/\b\d{7,}\b/g, '【联系方式已省略】')
    .replace(/(?:微信|vx|wx|QQ|qq|电话|手机)[号:：\s]*[A-Za-z0-9_-]{5,}/gi, '【联系方式已省略】')
    .slice(0, q12MaxChars);
  const content = raw.replace(/【联系方式已省略】/g, '').trim();
  if (!isContentQuote(content) || /^(?:没有|暂无|无|没了|不确定|都行)[。！!～~\s]*$/.test(content)) return null;
  return { raw, turn: last.turn, question: String(last.q || '').slice(0, 240) };
}

function buildMapperInput(state, options = {}) {
  const st = typeof state === 'string' ? JSON.parse(state) : state;
  const facts = (st.facts || []).filter(f => f.active && f.status === '已确认');
  const q12 = q12DialogText(st, options);
  const factInputs = facts.map(f => ({
      fact_id: `F${f.ver}`,
      field: f.field,
      sub: f.sub,
      subject: f.subject,
      value: f.value,
      quote: f.evidence,
      condition: f.condition || '',
      polarity: f.polarity || '肯定',
      strength: f.strength || '偏好',
      priority: f.priority || 'normal',
      turn: f.turn,
      task_id: f.src || '',
      question_text: f.source_question || '',
      raw_answer: f.src === 'Q12' && q12 && f.turn === q12.turn
        ? q12.raw : '',
    }));
  // When P1B did not extract a Q12 fact, the explicit answer can still be used
  // as a cited input to the profile-only Mapper. NEVER write it to matching facts.
  const hasQ12Fact = facts.some(f => f.src === 'Q12' &&
    (q12 && f.turn === q12.turn));
  if (q12 && !hasQ12Fact) {
    factInputs.push({ fact_id: `Q12_RAW_T${q12.turn}`, field: 'Q12', sub: 'raw',
      subject: '待判', value: q12.raw, quote: q12.raw,
      raw_answer: q12.raw, condition: '', polarity: '肯定',
      task_id: 'Q12', turn: q12.turn, question_text: q12.question,
      source_class: 'answered_unstructured_not_confirmed'
    });
  }
  return {
    version: 'evidence-v1',
    facts: factInputs,
    conflicts: (st.notes || []).filter(n => n.active).map(n => ({
      field: n.field, sub: n.sub, subject: n.subject,
      quote: n.evidence, note: n.note || '', turn: n.turn
    })),
    // The Q12 original is already held in the in-session dialog, never a new
    // persistent profile field. raw_answer in facts carries it to the Mapper.
    q12_raw_included: Boolean(q12)
  };
}

function validateMapper(input, raw) {
  const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!o || !Array.isArray(o.atoms) || !o.routes || !Array.isArray(o.links))
    throw new Error('mapper_schema_invalid');
  const original = new Map(input.facts.map(f => [f.fact_id, f]));
  if (o.atoms.length > Math.max(8, input.facts.length * 4 + 8))
    throw new Error('mapper_too_many_atoms');
  const atoms = new Map();
  for (const a of o.atoms) {
    if (!a || !isNonempty(a.id) || atoms.has(a.id) ||
        !SUBJECTS.includes(a.subject) || !KINDS.includes(a.kind) ||
        !Array.isArray(a.source_fact_ids) || !a.source_fact_ids.length ||
        !isContentQuote(a.quote) || !isNonempty(a.meaning) || a.meaning.length > 160) throw new Error('mapper_atom_invalid');
    const sources = a.source_fact_ids.map(id => original.get(id));
    if (sources.some(s => !s)) throw new Error('mapper_unknown_source');
    // Grounding is exact; normalization is used only for content checks/deduplication.
    const supportedSources = sources.filter(s => [s.raw_answer, s.quote]
      .some(v => isNonempty(v) && v.includes(a.quote)));
    if (!supportedSources.length)
      throw new Error('mapper_quote_not_grounded');
    if (!['explicit', 'derived_from_source'].includes(a.basis))
      throw new Error('mapper_basis_invalid');
    if (!supportedSources.some(s => s.field === 'Q12' || s.subject === a.subject))
      throw new Error('mapper_subject_conflict');
    atoms.set(a.id, { ...a, source_fact_ids: uniq(a.source_fact_ids), source_facts: sources.map(s => ({subject:s.subject, value:s.value, polarity:s.polarity, condition:s.condition, strength:s.strength, quote:s.quote})) });
  }
  const routes = {};
  for (const scene of SCENES) {
    const route = o.routes[scene];
    if (!route || !Array.isArray(route.primary) || !Array.isArray(route.secondary))
      throw new Error('mapper_route_missing_' + scene);
    for (const id of [...route.primary, ...route.secondary])
      if (!atoms.has(id)) throw new Error('mapper_route_unknown_atom');
    const primary = uniq(route.primary);
    const secondary = uniq(route.secondary).filter(id => !primary.includes(id));
    routes[scene] = { primary, secondary };
  }
  const links = o.links.map(l => {
    if (!l || !Array.isArray(l.ids) || uniq(l.ids).length < 2 ||
        !l.ids.every(id => atoms.has(id)) ||
        !['explicit', 'candidate'].includes(l.basis))
      throw new Error('mapper_link_invalid');
    return { ids: uniq(l.ids), relation: String(l.relation || '').slice(0, 40), basis: l.basis };
  });
  return { atoms: [...atoms.values()], routes, links, version: 'evidence-v1' };
}

const PRIMARY_KINDS = {
  expect_ta: new Set(['partner_preference', 'attraction', 'relationship_expectation']),
  love_style: new Set(['self_interaction', 'relationship_expectation', 'relationship_experience']),
  p7: new Set(['daily_life'])
};
const PRIMARY_SUBJECTS = {
  expect_ta: new Set(['TA', '候选反馈', '关系']),
  love_style: new Set(['自己', '关系']),
  p7: new Set(['自己'])
};
// Conservative, provisional detail check: duplicated/contained quotes or meanings
// cannot turn one observation into two anchors, even with different IDs/kinds.
function distinctDetails(a, b) {
  const separate = (x, y) => x && y && !x.includes(y) && !y.includes(x);
  const x = normalized(a.quote), y = normalized(b.quote);
  if (!separate(x, y) || !separate(normalized(a.meaning), normalized(b.meaning))) return false;
  // Overlapping extracts from a short statement are not additional detail.
  for (let n = Math.max(2, Math.ceil(Math.min(x.length, y.length) / 2)); n < Math.min(x.length, y.length); n++)
    if (x.endsWith(y.slice(0, n)) || y.endsWith(x.slice(0, n))) return false;
  return true;
}
function classifyEvidence(mapper) {
  const idx = new Map(mapper.atoms.map(a => [a.id, a]));
  const result = {};
  for (const scene of SCENES) {
    const r = mapper.routes[scene];
    // In the first release, only explicit evidence can count as a primary anchor.
    const primary = r.primary.filter(id => {
      const a = idx.get(id);
      return a && a.basis === 'explicit' && PRIMARY_KINDS[scene].has(a.kind) &&
        PRIMARY_SUBJECTS[scene].has(a.subject);
    });
    const secondary = r.secondary.filter(id => idx.has(id));
    if (!primary.length) {
      result[scene] = { level: 'insufficient', primary: [], secondary, reason: 'no_valid_primary_anchor' };
      continue;
    }
    let level, reason;
    if (scene === 'expect_ta') {
      // One meaningful, explicit partner preference is a valid writing anchor.
      // Candidate appearance/photo feedback alone permits a local impression only.
      const hasPreference = primary.some(id => idx.get(id).kind === 'partner_preference');
      const hasRelationExpectation = primary.some(id => idx.get(id).kind === 'relationship_expectation');
      const attractionOnly = primary.every(id => idx.get(id).kind === 'attraction');
      level = hasPreference || hasRelationExpectation ? 'sufficient' : 'limited';
      reason = hasPreference ? 'explicit_partner_preference' :
        hasRelationExpectation ? 'explicit_relationship_expectation' :
          attractionOnly ? 'attraction_only_local_impression' : 'local_evidence_only';
    } else {
      // For other scenes, these are provisional heuristics, not calibrated scores.
      const multipleDetails = primary.some((id, i) => primary.slice(i + 1)
        .some(other => distinctDetails(idx.get(id), idx.get(other))));
      const relevant = new Set([...primary, ...secondary]);
      const explicitLink = mapper.links.some(l =>
        l.basis === 'explicit' && isContentQuote(l.relation) &&
        l.ids.some(id => primary.includes(id) && l.ids.some(other =>
          other !== id && relevant.has(other) && idx.get(other).basis === 'explicit' &&
          distinctDetails(idx.get(id), idx.get(other)))));
      level = multipleDetails || explicitLink ? 'sufficient' : 'limited';
      reason = multipleDetails ? 'distinct_complementary_details' : explicitLink ? 'explicit_supporting_link' : 'single_anchor_no_support';
    }
    result[scene] = {
      level, primary, secondary,
      reason
    };
  }
  return result;
}

function formatAtoms(mapper, ids) {
  const idx = new Map(mapper.atoms.map(a => [a.id, a]));
  return ids.map(id => idx.get(id)).filter(Boolean).map(a => ({
    id: a.id, meaning: String(a.meaning || '').slice(0, 160),
    subject: a.subject, kind: a.kind,
    quote: a.quote, source_fact_ids: a.source_fact_ids,
    time_scope: a.time_scope || 'unknown',
    condition: a.condition || '', source_facts: a.source_facts || []
  }));
}
function makeProfileInputs(state, mapper, levels, options = {}) {
  const st = typeof state === 'string' ? JSON.parse(state) : state;
  const e = {
    status: 'ok', version: 'evidence-v1',
    expect_ta: { ...levels.expect_ta,
      primary_facts: formatAtoms(mapper, levels.expect_ta.primary),
      secondary_facts: formatAtoms(mapper, levels.expect_ta.secondary) },
    love_style: { ...levels.love_style,
      primary_facts: formatAtoms(mapper, levels.love_style.primary),
      secondary_facts: formatAtoms(mapper, levels.love_style.secondary) },
    relations: mapper.links.filter(l =>
      [...levels.expect_ta.primary, ...levels.love_style.primary].some(id => l.ids.includes(id)))
  };
  const c60 = st.stage_card_60 || {};
  const p7 = levels.p7;
  return {
    rel_facts: JSON.stringify(e),
    life_facts: JSON.stringify({
      role: 'relationship_background_only',
      facts: formatAtoms(mapper, uniq([
        ...levels.expect_ta.secondary, ...levels.love_style.secondary
      ]).filter(id => mapper.atoms.find(a => a.id === id)?.kind === 'daily_life'))
    }),
    p7_life_facts: JSON.stringify({
      level: p7.level,
      primary: formatAtoms(mapper, p7.primary),
      secondary: formatAtoms(mapper, p7.secondary)
    }),
    // Keep the current N29 contract until C06 is explicitly confirmed.
    p60_insight: options.p60_insight !== undefined ? options.p60_insight :
      (c60.content_status === 'ok' && isNonempty(c60.attitude) ? c60.attitude : '无'),
    evidence_levels: {
      expect_ta: levels.expect_ta.level,
      love_style: levels.love_style.level,
      daily: levels.p7.level
    }
  };
}
module.exports = { buildMapperInput, validateMapper, classifyEvidence, makeProfileInputs };
