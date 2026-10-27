/* PROFILE_EVIDENCE_START (generated from src/profile_evidence.js) */
const ProfileEvidence = (() => { const module = {exports:{}};
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

return module.exports; })();
/* PROFILE_EVIDENCE_END */
/* BUSINESS_EVENTS_START (generated from src/business_events.js) */
const BusinessEvents = (() => { const module = {exports:{}};
'use strict';

// V2.2 business boundary. Pure event builders read only committed engine state;
// they do not call a model, infer facts, create a database or claim a save.
const clone = value => JSON.parse(JSON.stringify(value));
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const uniq = values => [...new Set(values)];
const revision = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const GROUPS = ['partner_preferences', 'self_life', 'relationship', 'candidate_feedback', 'self_extra', 'supplement'];
const SECTION_KEYS = ['expect_ta', 'daily', 'love_style'];
const activeFacts = state => (state.facts || []).filter(f => record(f) && f.active === true && f.status === '已确认');

function classification(fact) {
  if (fact.field === 'NEED' && fact.subject === 'TA') return 'partner_preferences';
  if (fact.field === 'CARD') return 'candidate_feedback';
  if (fact.field === 'SELF') return 'self_extra';
  if (fact.field === 'Q12') return 'supplement';
  if (['Q4', 'Q8', 'Q9', 'Q10', 'Q11'].includes(fact.field)) return 'relationship';
  if (['Q1', 'Q2', 'Q3', 'Q5', 'Q6', 'Q7'].includes(fact.field)) return 'self_life';
  throw Error('business_unknown_fact_classification');
}

function publicFact(fact, state, includeEvidence) {
  const result = {
    field: fact.field, sub: fact.sub, subject: fact.subject, value: clone(fact.value),
    polarity: fact.polarity || '肯定', condition: fact.condition || '',
    op: fact.op === 'correct' ? 'correct' : 'add', ver: fact.ver, active: true,
  };
  if (fact.field === 'NEED') {
    result.strength = fact.strength === '硬性' ? '硬性' : '偏好';
    result.priority = fact.priority === 'core' ? 'core' : 'normal';
  }
  if (includeEvidence) result.evidence = text(fact.evidence);
  if (fact.field === 'CARD') {
    // Resolve labels only against the actual recorded card set. Do not attach
    // today's displayed candidate to a historical feedback fact.
    result.card_set_id = text(fact.card_set_id);
    const ids = Array.isArray(fact.candidate_ids) ? fact.candidate_ids :
      fact.candidate_id !== undefined && fact.candidate_id !== null ? [fact.candidate_id] : [];
    result.candidate_ids = uniq(ids.filter(id => typeof id === 'string' || typeof id === 'number'));
    result.candidate_id = result.candidate_ids.length === 1 ? result.candidate_ids[0] : null;
    result.candidate_resolution = result.candidate_ids.length && result.card_set_id ? 'resolved' :
      fact.value === '都没感觉' ? 'none_selected' : 'unresolved';
  }
  return result;
}

function currentSnapshot(state, {includeEvidence = false} = {}) {
  const snapshot = Object.fromEntries(GROUPS.map(key => [key, []]));
  for (const fact of activeFacts(state)) snapshot[classification(fact)].push(publicFact(fact, state, includeEvidence));
  return snapshot;
}

function currentTagIds(state) {
  // Display-only fallback atmosphere tags are not business facts.
  return uniq(Object.values(state.tags || {}).filter(Array.isArray).flat().filter(t =>
    record(t) && (t.tag_id !== undefined || t.id !== undefined) && !t.fallback && t.source !== 'fallback'
  ).map(t => t.tag_id ?? t.id)).sort();
}

function identity(state, options) {
  const sessionId = text(options.sessionId || state.session_id).trim();
  if (!sessionId) throw Error('business_session_id_required');
  if (state.session_id && state.session_id !== sessionId) throw Error('business_session_id_conflict');
  return {session_id: sessionId, turn_id: text(options.turnId || state.turn_id) || `turn_${revision(state.turn)}`};
}

function factsSignature(state) {
  const facts = activeFacts(state).map(f => publicFact(f, state, false));
  return JSON.stringify({facts, tags: currentTagIds(state), need_tags: uniq(state.need_tags || []).sort()});
}

function prepareFactsUpdated(before, after, options = {}) {
  const state = clone(after), ids = identity(state, options);
  const prior = before.business_events || {}, meta = state.business_events || {};
  const signature = factsSignature(state);
  state.session_id = ids.session_id;
  state.facts_revision = Math.max(revision(before.facts_revision), revision(state.facts_revision));
  if (signature === factsSignature(before) || meta.last_facts_signature === signature) return {state, event: null};
  const oldFacts = new Map(activeFacts(before).map(f => [f.ver, f]));
  const newFacts = activeFacts(state), newVersions = new Set(newFacts.map(f => f.ver));
  const changes = newFacts.filter(f => !oldFacts.has(f.ver) ||
    JSON.stringify(publicFact(oldFacts.get(f.ver), before, false)) !== JSON.stringify(publicFact(f, state, false))
  ).map(f => ({...publicFact(f, state, !!options.includeEvidence), source_op: f.op === 'correct' ? 'correct' : 'add', op: 'upsert'}));
  const deactivated = [...oldFacts.keys()].filter(ver => !newVersions.has(ver));
  // A tag-only recomputation is also a useful replacement snapshot, not an
  // instruction to append tags. Versions advance once per committed change set.
  state.facts_revision += 1;
  state.business_events = {...prior, ...meta, last_facts_signature: signature};
  const idempotencyKey = JSON.stringify([ids.session_id, ids.turn_id, state.facts_revision]);
  const event = {
    type: 'onFactsUpdated', name: 'onFactsUpdated', idempotency_key: idempotencyKey,
    ...ids, task_id: text(options.taskId || after.current?.task), facts_revision: state.facts_revision,
    changes, deactivated_fact_versions: deactivated,
    current_facts: currentSnapshot(state, options),
    current_need_tag_ids: uniq(state.need_tags || []).sort(), current_tag_ids: currentTagIds(state),
  };
  state.business_events.last_facts_event_key = idempotencyKey;
  return {state, event};
}

function sectionState(profile, key) {
  const explicit = profile.section_state?.[key];
  if (['generated', 'no_evidence', 'generation_error'].includes(explicit)) return explicit;
  const source = profile.source?.[key];
  if (source === 'fixed_insufficient' || source === 'empty' || source === 'no_evidence') return 'no_evidence';
  if (source === 'fixed_generation_error' || source === 'generation_error') return 'generation_error';
  return text(profile[key]).trim() ? 'generated' : 'no_evidence';
}

function prepareProfileReady(input, options = {}) {
  const state = clone(input), ids = identity(state, options);
  if (state.stage !== 'PROFILE_READY' || !record(state.profile)) throw Error('business_profile_not_ready');
  state.session_id = ids.session_id;
  state.facts_revision = revision(state.facts_revision);
  const meta = state.business_events || {};
  // Repeated N32/refresh at the same facts revision is the same profile delivery,
  // even if a retried stochastic model happens to generate different prose.
  if (meta.last_profile_facts_revision === state.facts_revision && revision(state.profile_version)) return {state, event: null};
  const wb=state.profile_writeback;
  if(wb?.required && (wb.status!=='complete'||wb.facts_revision!==state.facts_revision))throw Error('business_writeback_not_ready');
  state.profile_version = revision(state.profile_version) + 1;
  const statuses = Object.fromEntries(SECTION_KEYS.map(key => [key, sectionState(state.profile, key)]));
  if(wb?.required && (Object.values(statuses).includes('generation_error') ||
    !SECTION_KEYS.some(key=>statuses[key]==='generated'&&text(state.profile[key]).trim()) ||
    (['daily','love_style'].some(key=>statuses[key]==='generated'&&text(state.profile[key]).trim()) && !text(state.profile_content?.story_text).trim())))
    throw Error('business_profile_generation_incomplete');
  const profile = Object.fromEntries(SECTION_KEYS.map(key => [key,
    statuses[key] === 'generated' ? text(state.profile[key]) : ''
  ]));
  const idempotencyKey = JSON.stringify([ids.session_id, state.profile_version]);
  const event = {
    type: 'onProfileReady', name: 'onProfileReady', idempotency_key: idempotencyKey,
    ...ids, profile_version: state.profile_version, facts_revision: state.facts_revision,
    flow_progress: Number.isFinite(state.progress) ? state.progress : 0,
    core_60: text(state.stage_card_60?.attitude), profile, section_state: statuses,
    empty_message: SECTION_KEYS.every(key => statuses[key] === 'no_evidence') ? text(state.profile.empty_message) : '',
    current_facts: currentSnapshot(state, options),
    current_tag_ids: currentTagIds(state), current_need_tag_ids: uniq(state.need_tags || []).sort(), status: 'ready',
  };
  if(wb?.required){
    event.profile_field_updates=clone(state.profile_field_updates || {});
    event.profile_content=clone(state.profile_content || {});
    event.write_modes={profile_field_updates:'patch',profile_content:'write_present_only'};
    if(Array.isArray(state.interest_ids_for_merge)){
      event.interest_ids=clone(state.interest_ids_for_merge);
      event.write_modes.interest_ids='merge';
    }
    event.writeback_version='1.4';
    event.writeback_diagnostics=clone(wb.diagnostics || []);
  }
  state.business_events = {...meta, last_profile_facts_revision: state.facts_revision, last_profile_event_key: idempotencyKey};
  return {state, event};
}

// Host injects its existing authenticated backend calls. No handler means no
// network, no accepted receipt, and no claim that the profile was saved.
function createDispatcher(handlers = {}) {
  const completed = new Map(), inFlight = new Map(), sessionQueues = new Map(), latest = new Map();
  async function deliver(event) {
    const key = event.idempotency_key;
    if (completed.has(key)) return {...completed.get(key), duplicate: true};
    if (inFlight.has(key)) return inFlight.get(key);
    const base = {type: event.type, idempotency_key: key, accepted: false};
    if (typeof handlers[event.type] !== 'function') return {...base, error_code: 'not_configured'};
    const work = (sessionQueues.get(event.session_id) || Promise.resolve()).then(async () => {
      try {
        const last = latest.get(event.session_id) || {facts: 0, profile: 0};
        if (event.facts_revision < last.facts || (event.type === 'onProfileReady' && event.profile_version < last.profile)) {
          return {...base, error_code: 'stale_version'};
        }
        const response = await handlers[event.type](clone(event));
        const versionKey = event.type === 'onProfileReady' ? 'profile_version' : 'facts_revision';
        const accepted = response?.accepted === true && response[versionKey] === event[versionKey] &&
          (event.type !== 'onProfileReady' || response.facts_revision === undefined || response.facts_revision === event.facts_revision);
        if (!accepted) return {...base, error_code: text(response?.error_code) || 'invalid_acknowledgement'};
        const receipt = {...base, accepted: true, [versionKey]: response[versionKey]};
        completed.set(key, receipt);
        latest.set(event.session_id, {facts: Math.max(last.facts, event.facts_revision),
          profile: event.type === 'onProfileReady' ? Math.max(last.profile, event.profile_version) : last.profile});
        return receipt;
      } catch (_) {
        return {...base, error_code: 'delivery_failed'};
      }
    });
    inFlight.set(key, work);
    sessionQueues.set(event.session_id, work);
    try { return await work; } finally {
      inFlight.delete(key);
      if (sessionQueues.get(event.session_id) === work) sessionQueues.delete(event.session_id);
    }
  }
  return {dispatch: async events => {
    const result = [];
    // Keep facts replacement before profile publication when both share a turn.
    for (const event of events || []) result.push(await deliver(event));
    return result;
  }};
}

module.exports = {prepareFactsUpdated, prepareProfileReady, currentSnapshot, currentTagIds, createDispatcher};

return module.exports; })();
/* BUSINESS_EVENTS_END */
/* PROFILE_CONTENT_START (generated from src/profile_content_composer.js) */
const ProfileContentComposer = (() => { const module = {exports:{}};
'use strict';
// One model output, two independent results. Original Q/A never comes from a model.
const allowedTasks = new Set(['LIFE','SUP1','SUP2','SUP3','SUP4']);
const text = value => typeof value === 'string' ? value : '';
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
function candidatesFromSession(records = []) {
  if (!Array.isArray(records)) return [];
  const counts = new Map();
  for (const row of records) if(row) counts.set(row.turn_id,(counts.get(row.turn_id)||0)+1);
  return records.filter(row => row && typeof row.turn_id === 'string' && row.turn_id && counts.get(row.turn_id)===1 &&
    allowedTasks.has(row.task_id) && ['answered','partial'].includes(row.answer_status) &&
    text(row.question).trim() && text(row.raw_answer).trim());
}
function resolveSelectedTopic(candidates, selectedId) {
  if (typeof selectedId !== 'string') return null;
  const row = candidatesFromSession(candidates).find(q => q.turn_id === selectedId);
  return row ? {turn_id:row.turn_id,question:row.question,answer:row.raw_answer} : null;
}
function prepareContentInput(state) {
  const p = state.profile || {};
  const source = key => !p.section_state?.[key] || p.section_state[key]==='generated' ? text(p[key]) : '';
  return {
    daily:source('daily'), love_style:source('love_style'),
    supporting_facts:(state.facts || []).filter(f => f?.active===true && f.status==='已确认' &&
      ['自己','关系'].includes(f.subject) && !['NEED','CARD'].includes(f.field) &&
      !(state.notes || []).some(n => n.active && n.field===f.field && n.sub===f.sub && n.subject===f.subject))
      .map(f => ({field:f.field,sub:f.sub,subject:f.subject,value:f.value,evidence:f.evidence,
        polarity:f.polarity || '肯定',condition:f.condition || '',ver:f.ver})),
    qa_candidates:candidatesFromSession(state.topic_candidates).map(q => ({...q})),
  };
}
const shouldCompose = input => !!(input.daily.trim() || input.love_style.trim() || input.qa_candidates.length);
function parseAndValidate(raw, input, options = {}) {
  let obj;
  try {obj = typeof raw==='string' ? JSON.parse(raw) : raw;} catch (_) {}
  const result = {story_text:'',selected_turn_id:null,diagnostics:[]};
  if (!isRecord(obj)) {result.diagnostics.push('invalid_json_object');return result;}
  if(Object.keys(obj).some(k => !['story_text','selected_turn_id'].includes(k))) result.diagnostics.push('unexpected_keys_ignored');
  const story = text(obj.story_text).trim();
  if(typeof obj.story_text !== 'string') result.diagnostics.push('invalid_story_type');
  else if(story && (!input.supporting_facts.length || !(input.daily.trim()||input.love_style.trim()))) result.diagnostics.push('story_without_evidence');
  else if([...story].length > (options.maxStoryChars || 160)) result.diagnostics.push('story_too_long');
  else if(story && options.isAllowed && !options.isAllowed(story)) result.diagnostics.push('story_blocked');
  else result.story_text=story;
  if(obj.selected_turn_id !== null && obj.selected_turn_id !== undefined) {
    if(typeof obj.selected_turn_id!=='string') result.diagnostics.push('invalid_topic_id_type');
    else if(resolveSelectedTopic(input.qa_candidates,obj.selected_turn_id)) result.selected_turn_id=obj.selected_turn_id;
    else result.diagnostics.push('unknown_topic_id');
  }
  return result;
}
function expectTaForWriteback(state) {
  const p=state.profile || {};
  if(p.section_state?.expect_ta && p.section_state.expect_ta!=='generated') return '';
  return text(p.expect_ta).replaceAll('你','我');
}
module.exports={candidatesFromSession,resolveSelectedTopic,prepareContentInput,shouldCompose,parseAndValidate,expectTaForWriteback};

return module.exports; })();
/* PROFILE_CONTENT_END */
/* PROFILE_MAPPER_START (generated from src/profile_mapper.js) */
const ProfileFieldMapper = (() => { const module = {exports:{}};
'use strict';
/* Registration-only mapping. Pure code, never writes a database or infers missing facts. */
const TARGET_SEPARATOR = '.';
const norm = x => String(x == null ? '' : x).trim();
const inRange = (x,min,max)=>Math.max(min,Math.min(max,x));
const isValidFact = f => !!f && f.active === true && f.status === '已确认' &&
  (f.polarity || '肯定') === '肯定' && !norm(f.condition) &&
  !!norm(f.field) && !!norm(f.sub) && typeof f.value === 'string' && !!norm(f.value);
const quoteOf = f => norm(f.evidence);
const order = f => Number.isFinite(Number(f.ver)) ? Number(f.ver) : Number(f.turn)||0;

function selectedFact(facts,field,sub,subject){
  const matches=facts.filter(f=>isValidFact(f)&&f.field===field&&f.sub===sub&&f.subject===subject);
  if(!matches.length)return {status:'missing'};
  const values=[...new Set(matches.map(f=>norm(f.value)))];
  if(values.length===1)return {status:'matched',fact:matches.sort((a,b)=>order(b)-order(a))[0]};
  // N09 should have invalidated a corrected value. Never silently last-write-wins otherwise.
  const corrected=matches.filter(f=>f.op==='correct').sort((a,b)=>order(b)-order(a));
  if(corrected.length && order(corrected[0])>Math.max(...matches.filter(f=>f!==corrected[0]).map(order)))
    return {status:'matched',fact:corrected[0]};
  return {status:'conflict',reason:`${field}.${sub} has multiple active values`,evidence:matches.map(f=>f.value)};
}
function evidence(f){return {fact_version:f.ver??null,field:`${f.field}.${f.sub}`,subject:f.subject,quote:quoteOf(f)};}
function canonicalInterest(raw,aliases){
  const q=norm(raw).toLowerCase();
  if(!q)return null;
  for(const row of aliases)if([row.name,...(row.aliases||[])].some(s=>norm(s).toLowerCase()===q))return row.id;
  return null;
}
function mapInterests(facts,taxonomy,interestAliases){
  if(!Array.isArray(facts)||!Array.isArray(taxonomy)||!taxonomy.length)throw Error('invalid_interest_taxonomy');
  const validIDs=new Set(taxonomy.map(t=>Number(t.id)));
  const data=interestAliases?.interest_aliases||interestAliases;
  if(validIDs.size!==taxonomy.length||[...validIDs].some(id=>!Number.isSafeInteger(id)||id<=0)||!Array.isArray(data)||!data.length)throw Error('invalid_interest_dictionary');
  const meanings=new Map();
  for(const row of data){
    if(!validIDs.has(row.id)||typeof row.name!=='string'||!Array.isArray(row.aliases))throw Error('invalid_interest_alias');
    for(const name of [row.name,...row.aliases]){
      if(typeof name!=='string'||!name.trim())throw Error('invalid_interest_alias');
      const key=norm(name).toLowerCase();
      if(meanings.has(key)&&meanings.get(key)!==row.id)throw Error('ambiguous_interest_alias');
      meanings.set(key,row.id);
    }
  }
  const ids=new Set(),unmapped=[],trace=[];
  for(const f of facts.filter(f=>isValidFact(f)&&f.subject==='自己'&&f.field==='Q1'&&f.sub==='items')){
    if(f.polarity==='否定')continue;
    const v=norm(f.value);
    // Try entire standardized phrase before splitting. This preserves aliases such as 奶茶和甜品.
    const whole=canonicalInterest(v,data);
    const tokens=whole?[v]:v.split(/[、，,；;\/]|(?:和)|(?:以及)/).map(x=>x.trim()).filter(Boolean);
    for(const token of tokens){const id=canonicalInterest(token,data);
      if(id!==null&&validIDs.has(Number(id))){ids.add(Number(id));trace.push({id:Number(id),source:evidence(f)});}
      else unmapped.push({word:token,source_fact_version:f.ver??null});
    }
  }
  return {ids:[...ids].sort((a,b)=>a-b),unmapped,trace};
}
function parseHeight(f,registeredHeight,bounds,tolerance){
  let s=norm(f.value).replace(/厘米|公分|ＣＭ|cm/gi,'').replace(/\s+/g,'');
  const [low,high]=bounds;
  if(/^(不限|无所谓|没要求|都可以)$/.test(s))return {min_cm:low,max_cm:high,kind:'unlimited',strength:f.strength||'偏好',tolerance_cm:0};
  let m=s.match(/^(?:比我|比本人|比自己)(高|矮)(\d{1,2})(?:左右|上下)?$/);
  if(m){
    if(!Number.isFinite(registeredHeight)||registeredHeight<low||registeredHeight>high)return {pending:'missing_registered_height',raw:f.value};
    const center=registeredHeight+(m[1]==='高'?1:-1)*Number(m[2]);
    if(center<low||center>high)return {pending:'out_of_bounds',raw:f.value};
    const delta=tolerance;
    return {min_cm:inRange(center-delta,low,high),max_cm:inRange(center+delta,low,high),kind:'relative_target',strength:f.strength||'偏好',tolerance_cm:delta,raw:f.value};
  }
  m=s.match(/^(\d{3})(?:-|~|～|至|到)(\d{3})$/);
  if(m){const min=Number(m[1]),max=Number(m[2]);if(min>max||min<low||max>high)return {pending:'invalid_range',raw:f.value};
    return {min_cm:min,max_cm:max,kind:'explicit_range',strength:f.strength||'偏好',tolerance_cm:0,raw:f.value};}
  m=s.match(/^(?:(?:至少|不低于|不得低于|不能低于)(\d{3})|(\d{3})(?:以上|起|及以上))$/);
  if(m){const x=Number(m[1]||m[2]);if(x<low||x>high)return {pending:'out_of_bounds',raw:f.value};return {min_cm:x,max_cm:high,kind:'min',strength:f.strength||'偏好',tolerance_cm:0,raw:f.value};}
  m=s.match(/^(?:(?:最多|不高于|不能高于)(\d{3})|(\d{3})(?:以下|以内|及以下))$/);
  if(m){const x=Number(m[1]||m[2]);if(x<low||x>high)return {pending:'out_of_bounds',raw:f.value};return {min_cm:low,max_cm:x,kind:'max',strength:f.strength||'偏好',tolerance_cm:0,raw:f.value};}
  m=s.match(/^(\d{3})(?:左右|上下)?$/);
  if(m){const x=Number(m[1]);if(x<low||x>high)return {pending:'out_of_bounds',raw:f.value};
    const delta=tolerance;
    return {min_cm:inRange(x-delta,low,high),max_cm:inRange(x+delta,low,high),kind:delta?'around':'exact',strength:f.strength||'偏好',tolerance_cm:delta,raw:f.value};}
  return {pending:'unparsed_height',raw:f.value};
}
function isSelfNamedAlcohol(f){
  const s=quoteOf(f).replace(/\s+/g,'');
  if(/[?？"“”「」]|以前|曾经|如果|可能|不|没|别/.test(s))return false;
  return /(?:^|[，。；;！!])(?:我|本人)(?:就是|是|算是|自认是|自称是)(?:个|一个|妥妥的)?酒蒙子/.test(s);
}
function mapPet(facts,q5_answers=[]){
  const own=facts.filter(f=>isValidFact(f)&&f.field==='Q5'&&f.subject==='自己');
  const has=selectedFact(own,'Q5','has_pet','自己');
  if(has.status==='matched'&&has.fact.value==='正在养')return {status:'matched',value:'已经养啦',source:evidence(has.fact)};
  if(has.status==='conflict')return has;
  // Explicit desire must be present in P1B evidence, not inferred from '喜欢动物' or '没有养'.
  // Old raw answers cannot undo a newer confirmed correction. Unknown/conflicting
  // intent stays unknown; a third person's plans never become the user's plans.
  const latestTurn=has.status==='matched'?Number(has.fact.turn)||0:0;
  const quotes=[...new Set([...own.filter(f=>(Number(f.turn)||0)>=latestTurn).map(quoteOf),...q5_answers.filter(q=>q&&typeof q.text==='string'&&
    (Number(q.turn)||0)>=latestTurn).map(q=>q.text)])].filter(Boolean);
  const safe=quotes.filter(q=>!/[?？"“”「」]|(?:如果|要是|可能|或许|以前|曾经|过去|原来|他|她|室友|朋友|父母|爸妈|别人|对方)/.test(q));
  const clauses=safe.flatMap(q=>q.split(/[，。；;！!]/)).map(q=>q.trim())
    .filter(q=>q&&!/(?:他|她|它|室友|朋友|父母|爸妈|别人|对方|帮|替|照顾|代养)/.test(q));
  // Bare '养' inherits the Q5 pet question, while an explicitly different object
  // (养花/养生 etc.) must never be accepted just because the verb matches.
  const petObject=/(?:想养|打算养|计划养|就养|再养)(?=$|宠物|小?猫|小?狗|一只|一条|几只|几条)/;
  const want=clauses.filter(q=>/(?:非常|特别|很|超级|一直|真的|一定).{0,3}想养|(?:打算|计划)养|等.{1,8}(?:就|再)养/.test(q)&&petObject.test(q)&&!/不|没|别/.test(q));
  const never=clauses.filter(q=>/^(?:我|本人)?(?:完全不想养|绝对不养|一点都不想养|绝不会养)(?:宠物|任何动物|动物)?(?:了|啦|啊|呢)?$/.test(q));
  const current=clauses.filter(q=>/^(?:我)?(?:现在|目前|正在)(?:正)?养(?:着|了|有)?(?:一只|一条|几只|几条)?(?:小?猫|小?狗|宠物)/.test(q));
  if(current.length&&has.status==='matched'&&has.fact.value==='没有养')return {status:'conflict',reason:'conflicting_current_pet'};
  if(current.length)return {status:'matched',value:'已经养啦',source:{quotes:current}};
  if(want.length&&clauses.some(q=>/不想养|不打算养|没打算养|不计划养/.test(q)))return {status:'conflict',reason:'conflicting_pet_desire'};
  if(want.length&&never.length)return {status:'conflict',reason:'conflicting_pet_desire'};
  if(want.length)return {status:'matched',value:'非常想养',source:{quotes:want}};
  if(never.length)return {status:'matched',value:'完全不想养',source:{quotes:never}};
  return {status:'unknown',reason:'no_explicit_pet_intention'};
}
function mapProfile({facts=[],registration={},config,taxonomy=[],interestAliases={interest_aliases:[]},q5_answers=[],notes=[]}){
  if(!config||!Array.isArray(config.targets))throw new Error('profile_mapping_config_missing');
  const conflicts=notes.filter(n=>n.active);
  facts=facts.filter(f=>!conflicts.some(n=>n.field===f.field&&n.sub===f.sub&&n.subject===f.subject));
  const updates={},sources={},skipped=[];
  const emit=(key,value,source)=>{updates[key]=value;sources[key]=source;};
  // Existing registered preference remains available, but is not written unless explicitly changed.
  for(const t of config.targets){
    const source=Array.isArray(t.from)?null:t.from;
    if(t.type==='special'&&t.target==='lifestyle.pet_attitude'){
      const p=conflicts.some(n=>n.field==='Q5')?{status:'conflict',reason:'unresolved_pet_conflict'}:mapPet(facts,q5_answers);
      if(p.status==='matched')emit(t.target,p.value,p.source);
      else skipped.push({target:t.target,status:p.status,reason:p.reason});continue;
    }
    const [field,sub]=source.split(TARGET_SEPARATOR);
    const sel=selectedFact(facts,field,sub,t.subject);
    if(sel.status!=='matched'){
      skipped.push({target:t.target,status:sel.status,reason:sel.reason||'no_valid_fact'});continue;
    }
    const f=sel.fact,raw=norm(f.value);
    if(t.type==='range'){
      const h=parseHeight(f,registration.height_cm==null?NaN:Number(registration.height_cm),t.bounds_cm,t.tolerance_cm);
      if(h.pending)skipped.push({target:t.target,status:'unmapped',reason:h.pending,raw:h.raw});
      else emit(t.target,h,evidence(f));continue;
    }
    if(t.type==='special'&&t.target==='lifestyle.drink'){
      if(raw==='经常'){
        if(isSelfNamedAlcohol(f))emit(t.target,'酒蒙子',evidence(f));
        else skipped.push({target:t.target,status:'unmapped',reason:'frequent_drinking_not_self_named_酒蒙子'});
      }else if(Object.prototype.hasOwnProperty.call(t.map,raw)&&t.map[raw]!==null)emit(t.target,t.map[raw],evidence(f));
      else skipped.push({target:t.target,status:'unmapped',reason:'unrecognized_drink'});
      continue;
    }
    if(t.map&&Object.prototype.hasOwnProperty.call(t.map,raw))emit(t.target,t.map[raw],evidence(f));
    else skipped.push({target:t.target,status:'unmapped',reason:'non_equivalent_or_illegal_value',raw});
  }
  let interest;
  try {interest={status:'mapped',...mapInterests(facts,taxonomy,interestAliases)};}
  catch (_) {interest={status:'error',reason:'interest_mapping_failed'};}
  // Include known existing interests for a useful snapshot. The host must still
  // apply an atomic union against its current database, not replace from this snapshot.
  if(interest.status==='mapped'){
    const existing=Array.isArray(registration.interest_ids)?registration.interest_ids:[];
    interest.ids=[...new Set([...existing.filter(id=>Number.isSafeInteger(id)&&id>0),...interest.ids])].sort((a,b)=>a-b);
  }
  return {updates,sources,skipped,interest,registration_unchanged:{seek:registration.seek??null,height_cm:registration.height_cm??null}};
}
module.exports={mapProfile,mapInterests,parseHeight,mapPet,isSelfNamedAlcohol,selectedFact};

return module.exports; })();
/* PROFILE_MAPPER_END */
/* ===== LoveMi Coze Demo 引擎：与 Coze 代码节点逐一对应（JS 版） ===== */
const clone = (o) => JSON.parse(JSON.stringify(o));
const S = (v) => JSON.stringify(v);
function parseLoose(txt) {
  if (txt && typeof txt === "object") return Array.isArray(txt) ? {} : txt;
  let s = String(txt || "")
    .trim()
    .replace(/^```(?:json)?/gm, "")
    .replace(/```$/gm, "")
    .trim();
  const m = s.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(m ? m[0] : s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}
const stripP = (s) =>
  String(s || "").replace(/^[\s。.!！~]+|[\s。.!！~]+$/g, "");
const PII =
  /(\d{7,})|((微信|vx|wx|QQ|qq|电话|手机)[号:：\s]*[A-Za-z0-9_-]{5,})/i;
const norm = (s) =>
  String(s || "").replace(/[\s，。,.!！?？、~～…"'“”‘’：:；;（）()]/g, "");
const qmarks = (t) => (t.match(/[？?]/g) || []).length;

const newTaskState = () => ({
  a: 0,
  f: 0,
  h: 0,
  done: 0,
  refused: 0,
  fu: 0,
  rep: 0,
  covered: 0,
});
function newState(cfg) {
  const tasks = {};
  for (const t in cfg.tasks) tasks[t] = newTaskState();
  return {
    v: 1,
    session_id: newSessionId(),
    facts_revision: 0,
    profile_version: 0,
    stage: "S60",
    turn: 0,
    current: null,
    plan: null,
    tasks,
    pending: [],
    used: { S60: { F: 0, R: 0, S: 0 }, S40: { F: 0, R: 0, S: 0 } },
    card_fu: 0,
    facts: [],
    fv: 0,
    tags: { 60: [], 100: [] },
    dialog: [],
    topic_candidates: [],
    q5_answers: [],
    history: [],
    cards: [],
    rec: {},
    notes: [],
    stat: {},
    progress: 0,
    saved: false,
    from_direct: false,
    _und: {},
    _new: [],
  };
}
const activeFacts = (st) =>
  st.facts.filter((f) => f.active && f.status === "已确认");
// 出卡前的信息完整度独立于标签命中、召回人数及整轮 answer_status。
const LIFESTYLE_SUBS = ["lifestyle", "interests", "smoke", "drink", "pet"];
const needTarget = (f) =>
  f.field === "NEED" && f.subject === "TA"
    ? f.sub === "height"
      ? "height"
      : LIFESTYLE_SUBS.includes(f.sub)
        ? "lifestyle"
        : null
    : null;
const unconditional = (f) =>
  (f.polarity || "肯定") === "肯定" && !String(f.condition || "").trim();
function needIntake(st) {
  const saved = st.need_intake || {},
    targets = ["height", "lifestyle"];
  const conflicts = new Set(
    (st.notes || [])
      .filter((n) => n.active && n.field === "NEED" && n.subject === "TA")
      .map((n) => n.sub),
  );
  const facts = activeFacts(st).filter(
    (f) =>
      f.field === "NEED" &&
      f.subject === "TA" &&
      String(f.value || "").trim() &&
      !conflicts.has(f.sub) &&
      (f.value !== "不限" || unconditional(f)),
  );
  const known = Object.fromEntries(
    targets.map((target) => [
      target,
      facts.some((f) => needTarget(f) === target),
    ]),
  );
  const missing = targets.filter((target) => !known[target]);
  return {
    ...saved,
    asked: [...new Set((saved.asked || []).filter((t) => targets.includes(t)))],
    responses: saved.responses || {},
    known,
    missing,
    ready: missing.length === 0,
  };
}
function needIntakeRoute(cfg, st, status) {
  const intake = needIntake(st);
  st.need_intake = intake;
  if (intake.ready || intake.completed || status === 'risk') return null;
  if (st.current?.qtype === 'NEED_CLARIFY' || intake.asked.length) {
    intake.completed = true;
    return null;
  }
  if (['refused','nothing_to_add','skipped'].includes(status)) {
    intake.completed = true;
    return null;
  }
  const targetsMissing = intake.missing;
  const dimensions = targetsMissing.map(t => t === 'height' ? '身高' : '生活方式').join('和');
  const candidateQuestion = cfg.need_intake.question_template
    ? cfg.need_intake.question_template.replace('{{缺失维度}}', dimensions)
    : targetsMissing.map(t => cfg.need_intake.questions[t]).join('');
  intake.asked = [...targetsMissing];
  st.plan = {action:'NEED_CLARIFY',task:'NEED',qtype:'NEED_CLARIFY',intake_targets:targetsMissing};
  return {state:S(st),action:'NEED_CLARIFY',route:'READY',candidate_q:candidateQuestion,q_task_spec:'',rel_facts_text:'',life_facts_text:'',debug:'一次联合补问：'+targetsMissing.join(',')};

}
function itemMet(st, item, subjects) {
  const [fid, sub] = item.split(".");
  const subjectMatches = (x) => !subjects || subjects.includes(x.subject);
  return (
    st.facts.some(
      (f) =>
        f.active &&
        f.status === "已确认" &&
        f.field === fid &&
        f.sub === sub &&
        subjectMatches(f) &&
        !(f.src === "NEED" && fid !== "NEED"),
    ) ||
    (st.notes || []).some(
      (n) => n.active && n.field === fid && n.sub === sub && subjectMatches(n),
    )
  );
}
function covered(cfg, st, tid) {
  const mi = cfg.tasks[tid].min_info;
  if (!mi) return false;
  const h = mi.items.map((i) => itemMet(st, i, mi.subjects?.[i]));
  return mi.mode === "all" ? h.every(Boolean) : h.some(Boolean);
}
function missing(cfg, st, tid) {
  const mi = cfg.tasks[tid].min_info || { items: [] };
  return mi.items.filter((i) => !itemMet(st, i, mi.subjects?.[i]));
}
function budgetLeft(cfg, st, stage) {
  if (!cfg.budget[stage]) return 0;
  const b = cfg.budget[stage],
    u = st.used[stage];
  return Math.max(0, Math.floor(b.N * b.r) - u.F - u.R - u.S);
}
function factsText(cfg, st, only, withEv) {
  const rows = [];
  for (const f of activeFacts(st)) {
    if (only && !only.includes(f.field)) continue;
    const cond = f.condition ? `（条件：${f.condition}）` : "";
    const hard = f.strength === "硬性" ? "（硬性）" : "";
    const detail = `${f.field}.${f.sub}｜${cfg.fields[f.field].name}｜对象:${f.subject}｜极性:${f.polarity || "肯定"}｜${f.value}${hard}${cond}`;
    rows.push(`- ${detail}` + (withEv ? `｜原话:${f.evidence}` : ""));
  }
  if (!only && !withEv) {
    const ref = Object.keys(st.tasks).filter((t) => st.tasks[t].refused);
    if (ref.length) rows.push("- 已拒答的题目：" + ref.join("、"));
  }
  return rows.join("\n") || "（暂无）";
}
function fieldDictText(cfg) {
  return Object.entries(cfg.fields)
    .map(
      ([fid, f]) =>
        `${fid} ${f.name}｜对象可取:${f.subjects.join("/")}｜` +
        Object.entries(f.subs)
          .map(
            ([s, d]) =>
              `${s}=` + (d.type === "enum" ? d.values.join("/") : "开放文本"),
          )
          .join("；"),
    )
    .join("\n");
}
function cardsText(st) {
  return (st.cards || [])
    .map(
      (c, i) =>
        `第${i + 1}位（编号 ${c.key}）｜${c.name}·${c.age}·${c.city}·${c.school}｜` +
        c.tags.join(" · "),
    )
    .join("\n");
}
function spec(cfg, st, tid, qtype, withEv) {
  const t = cfg.tasks[tid];
  return {
    task_id: tid,
    qtype,
    theme: t.theme,
    goal: t.goal,
    key_semantics: t.key_semantics,
    fallback: t.fallback,
    scenes: t.scenes || [],
    missing: missing(cfg, st, tid),
    avoid_texts: st.history.filter((h) => h.task === tid).map((h) => h.text),
    known_facts: factsText(cfg, st, null, withEv),
    recent_dialog: st.dialog.slice(-3),
  };
}
// 核心句：问题本身（换场景重问、反问后重问时原样使用）；烟酒只缺一项时只问缺的那项
// 补充问题：本阶段实际答过的题少于下限、额度还有、本阶段还没用过补充题时触发；优先补画像最空的那一块
function pickSupplement(cfg, st, stage) {
  const PC = (cfg.pace || {})[stage];
  if (!PC) return null;
  if (((st.asked || {})[stage] || 0) >= PC.min_answered) return null;
  if (budgetLeft(cfg, st, stage) <= 0) return null;
  if (
    ((st.sup_used || {})[stage] || 0) >= ((cfg.pace || {}).max_supplements || 1)
  )
    return null;
  const asked = new Set(st.history.map((h) => h.task));
  const facts = activeFacts(st);
  const cands = (cfg.supplements || []).filter(
    (id) => !asked.has(id) && !covered(cfg, st, id),
  );
  if (!cands.length) return null;
  const fill = (id) =>
    facts.filter((f) =>
      ((cfg.related_fields || {})[id] || []).includes(f.field),
    ).length;
  return cands
    .map((id, i) => ({ id, i, s: fill(id) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)[0].id;
}
function coreOf(cfg, st, tid) {
  const t = cfg.tasks[tid];
  const miss = missing(cfg, st, tid);
  if (t.core_by_missing && miss.length === 1 && t.core_by_missing[miss[0]])
    return t.core_by_missing[miss[0]];
  return t.core || t.fallback;
}
function leadSpec(cfg, st, tid) {
  const t = cfg.tasks[tid];
  const rf = (cfg.related_fields || {})[tid] || [];
  const facts =
    activeFacts(st)
      .filter((f) => rf.includes(f.field))
      .map((f) => `- ${cfg.fields[f.field].name}：${f.value}`)
      .join("\n") || "（无）";
  const last = st.dialog.slice(-1)[0];
  return {
    task_id: tid,
    qtype: "REPLACE",
    mode: "lead",
    theme: t.theme,
    core: coreOf(cfg, st, tid),
    related_facts: facts,
    last_turn: last ? `问：${last.q}｜答：${last.a}` : "（无）",
    avoid_texts: st.history.filter((h) => h.task === tid).map((h) => h.text),
  };
}
function qOk(cfg, text) {
  const t = String(text || "").trim();
  if ([...t].length < 4 || [...t].length > 40 || /[\r\n]/.test(t)) return false;
  if (qmarks(t) > 1) return false;
  if (
    [...cfg.blocked.compliance, ...cfg.blocked.no_ask].some((w) =>
      t.includes(w),
    )
  )
    return false;
  return true;
}
function progressOf(cfg, st) {
  let p = 0;
  for (const [tid, w] of Object.entries(cfg.weights)) {
    const ts = st.tasks[tid];
    if (cfg.tasks[tid]?.kind === 'main' && ts?.a) p += w;
  }
  return Math.round(p * 10) / 10;
}
function firstOpenTask(cfg, st, stage) {
  for (const tid of cfg.order[stage]) {
    const t = cfg.tasks[tid],
      ts = st.tasks[tid];
    if (t.kind !== "main" || ts.a) continue;
    if (covered(cfg, st, tid) || ts.refused) {
      ts.a = 1;
      ts.done = 1;
      continue;
    }
    return tid;
  }
  return null;
}

/* ---------- N02 前置拦截（写死规则） ---------- */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F\u200D]/gu;
const PUNCT =
  /[\s.,!?~～…。，！？、；;：:"'“”‘’（）()\-—_*#@&%^+=<>\/\\|\[\]{}]/g;
const KEYROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
function prefilter(cfg, ui, task) {
  const t = String(ui || "").trim();
  const noP = t.replace(PUNCT, "");
  if (!noP) return "empty";
  const core = noP.replace(EMOJI, "");
  if (!core) return task === "NEED" ? "emoji" : "";
  if ([...core].length >= 3 && new Set([...core]).size === 1) return "repeat";
  if (new RegExp("^\\d{" + cfg.prefilter.digits_min + ",}$").test(core))
    return "digits";
  const low = core.toLowerCase();
  if (/^[a-z]{4,}$/.test(low)) {
    let row = false;
    for (let i = 0; i + 4 <= low.length; i++)
      if (KEYROWS.some((r) => r.includes(low.slice(i, i + 4)))) row = true;
    if (row || /[bcdfghjklmnpqrstvwxz]{5,}/.test(low)) return "gibberish";
  }
  return "";
}
const inputLimit = (cfg, task) =>
  cfg.max_input_chars[task] ?? cfg.max_input_chars.default;

// 仅用于等待开场回应的上下文；先排除提问、否定和犹豫，再识别自然的同意表达。
const INTRO_ACCEPT =
  "那就开始啦～想到什么都可以和我说，说得越具体，我就越懂你～";
const INTRO_ACCEPT_PREFIXES = [
  "那我们",
  "我们",
  "那就",
  "已经",
  "现在",
  "完全",
  "当然",
  "没事",
  "嗯",
  "恩",
  "哦",
  "噢",
  "那",
  "我",
  "都",
];
const INTRO_ACCEPT_WORDS = new Set([
  "准备好",
  "准备好了",
  "准备好的",
  "好",
  "好了",
  "好的",
  "好哒",
  "好滴",
  "好嘞",
  "可以",
  "可以了",
  "可以的",
  "行",
  "行了",
  "行的",
  "没问题",
  "没有问题",
  "没毛病",
  "同意",
  "愿意",
  "开始",
  "开始了",
  "开聊",
  "聊",
  "聊起来",
  "来",
  "你问",
  "你开始问",
  "ok",
  "okk",
  "okay",
  "yes",
  "yep",
  "sure",
  "ready",
  "letsgo",
  "goahead",
]);
function introAcceptClause(t) {
  if (/^[嗯恩]+$/.test(t)) return true;
  let start = 0,
    end = t.length;
  // 最长前缀优先，每步只移动游标；重复语气词不会触发正则回溯。
  while (start < end) {
    const prefix = INTRO_ACCEPT_PREFIXES.find((p) => t.startsWith(p, start));
    if (!prefix) break;
    start += prefix.length;
  }
  while (end > start && "呀啊呢哦喔哟啦吧嗯恩".includes(t[end - 1])) end--;
  return INTRO_ACCEPT_WORDS.has(t.slice(start, end));
}
function buildTaskLookup(cfg, st) {
  return [...new Set([...cfg.order.S60, ...cfg.order.S40])]
    .filter((id) => cfg.tasks[id]?.kind === "main")
    .map((id) => ({
      task_id: id,
      stage: cfg.tasks[id].stage,
      theme: cfg.tasks[id].theme,
      goal: cfg.tasks[id].goal,
      asked: st.history.some((h) => h.task === id),
    }));
}
function introClass(ui) {
  const t = String(ui || "")
    .normalize("NFKC")
    .toLowerCase()
    .trim();
  if (/[？?]|吗|什么|多久|怎么|几个|几分钟/.test(t)) return "question";
  if (
    /还没|没好|没准备|等等|等一下|等会|稍等|晚点|待会|以后再|紧张|不知道|没想好|害羞|不太会|不行|不可以|不能|不想|暂时不|先不|别开始|没空|不方便|别问|没时间|not\s+(?:yet|ready|now)|\b(?:no|nope)\b/.test(
      t,
    )
  )
    return "hesitate";
  const clauses = t
    .replace(EMOJI, "")
    .split(/[，,。.!！;；～~\n]/)
    .map((s) => s.replace(/\s+/g, "").replace(/[“”‘’"']/g, ""));
  return clauses.some(introAcceptClause) ? "accept" : "other";
}

/* ---------- N02 ---------- */
function N02(cfg, stateJson, ui) {
  ui = String(ui || "").trim();
  let st = null;
  try {
    st = stateJson ? JSON.parse(stateJson) : null;
    if (!st || st.v !== 1) st = null;
  } catch (e) {
    st = null;
  }
  if (st) {
    st.tasks = st.tasks || {};
    for (const tid in cfg.tasks)
      if (!st.tasks[tid]) st.tasks[tid] = newTaskState();
  }
  let branch = "STATIC",
    reply = "",
    qSpec = "",
    forcedUnd = "",
    contQ = "";
  if (st) {
    st._care = false;
    st._und = {};
  }
  if (!st || ui === "重新开始" || ui === "/reset") {
    st = newState(cfg);
    st.stage = "INTRO";
    st.current = null;
    reply = cfg.intro.hello + "\n\n" + cfg.intro.guide;
  } else if (ui === "退出" && ["S60", "S40", "AWAIT_60"].includes(st.stage)) {
    st.stage = "EXITED";
    st.current = null;
    reply =
      "好，我们先聊到这里。对话会保留，不会生成中途画像。（回复「重新开始」可重新测试）";
  } else if (["EXITED", "DONE"].includes(st.stage))
    reply = "这次注册已经结束啦。回复「重新开始」可以重新测试。";
  else if (st.stage === "AWAIT_60") {
    const generateProfile = [
      cfg.buttons.p60[1],
      "生成画像",
      "直接完成",
      "完成",
    ].includes(ui);
    if (!generateProfile) {
      st.stage = "S40";
      const nxt = firstOpenTask(cfg, st, "S40");
      st.progress = Math.max(60, progressOf(cfg, st));
      if (nxt) {
        const sup =
          (cfg.pace || {}).S40?.trigger === "before:" + nxt
            ? pickSupplement(cfg, st, "S40")
            : null;
        if (sup) {
          st.used.S40.S += 1;
          st.sup_used = st.sup_used || {};
          st.sup_used.S40 = (st.sup_used.S40 || 0) + 1;
          st.plan = { action: "SUPPLEMENT", task: sup, qtype: "SUPPLEMENT" };
        } else st.plan = { action: "ASK_NEXT", task: nxt, qtype: "MAIN" };
        branch = "CONTINUE_40";
        const target = sup || nxt;
        contQ = cfg.tasks[target].script || cfg.tasks[target].fallback;
      } else {
        branch = "PROFILE";
        st.stage = "PROFILE_GEN";
      }
    } else {
      branch = "PROFILE";
      st.stage = "PROFILE_GEN";
      st.from_direct = true;
    }
  } else if (st.stage === "PROFILE_FAILED") {
    if(ui === '继续补充'){
      delete st.profile_generation; delete st.profile_writeback;
      st.stage='S40'; st.tasks.Q12=newTaskState();
      st.plan={action:'ASK_NEXT',task:'Q12',qtype:'MAIN'};
      branch='CONTINUE_40';contQ=cfg.tasks.Q12.script;
    }else if(ui === '重试生成画像'){
      st.stage='PROFILE_GEN';branch='PROFILE';
    }else reply='可以点击重试生成画像，或继续补充一点信息。';
  } else if (st.stage === "PROFILE_READY") {
    if (ui.includes("保存")) {
      st.saved = true;
      reply = "画像已保存。（Demo 未写入真实数据）";
    } else if (ui.includes("首页") || ui.includes("匹配")) {
      st.stage = "DONE";
      reply = "（Demo）回到首页。真实环境以首页实际到达为准。";
    } else
      reply = `回复「${cfg.buttons.p100[0]}」或「${cfg.buttons.p100[1]}」。`;
  } else if (st.stage === "INTRO") {
    // 开场回应按语义选择承接；确认后直接进入需求题，不调用模型。
    const IA = cfg.intro_ack || {},
      cls = introClass(ui);
    const ackL = IA[cls] || (cls === "accept" ? [INTRO_ACCEPT] : []);
    const ack = ackL.length
      ? ackL[(st.turn || 0) % ackL.length]
      : cls === "accept"
        ? INTRO_ACCEPT
        : "";
    const parts = String(cfg.tasks.NEED.script || "").split(/\n\s*\n/);
    if (cls === "accept") {
      const first = parts[0].trim();
      if (first === ack) parts.shift();
      else {
        const opening = ack.match(/^[^～。！？!?]+[～。！？!?]/)?.[0];
        if (opening && first.startsWith(opening))
          parts[0] = first.slice(opening.length).trimStart();
      }
    }
    const q = [ack, ...parts].filter(Boolean).join("\n\n");
    st.intro_class = cls;
    st.stage = "S60";
    st.current = {
      task: "NEED",
      qtype: "MAIN",
      text: cfg.tasks.NEED.core,
      qid: "q1",
    };
    st.history.push({ task: "NEED", qtype: "MAIN", text: cfg.tasks.NEED.core });
    reply = q;
  } else if (["S60", "S40"].includes(st.stage) && st.current) {
    st.turn += 1;
    const kind = prefilter(cfg, ui, st.current.task);
    if (kind) {
      branch = "PREFILTER";
      forcedUnd = S({
        answer_status: "unclear",
        facts: [],
        refused_targets: [],
        conflicts: [],
        followup: { worth: false },
        card_followup: { needed: false },
        ack_worthy: false,
        next_question_draft: "",
        prefilter: kind,
      });
    } else branch = "ANSWER";
  } else reply = "状态异常，回复「重新开始」重新测试。";
  const cur = st.current || {},
    curTask = cur.task;
  const inCard = curTask === "CARD_L1" || cur.qtype === "CARD_FOLLOWUP";
  const curSpec = curTask ? spec(cfg, st, curTask, cur.qtype) : {};
  curSpec.task_lookup = buildTaskLookup(cfg, st);
  if (inCard) {
    curSpec.parent_task_id = "CARD_L1";
    curSpec.goal = cfg.tasks.CARD_L1.goal;
    curSpec.followup_goal =
      "从用户明确表达的吸引点了解相处中的具体表现或期待；不转为调查用户爱好的细节、技巧或心理。";
    curSpec.asked_followups = st.history
      .filter((h) => h.qtype === "CARD_FOLLOWUP")
      .map((h) => h.text);
  }
  if (curTask === "NEED" && cfg.need_intake?.enabled) {
    curSpec.need_intake = needIntake(st);
    curSpec.intake_targets = cur.intake_target
      ? [cur.intake_target]
      : cur.intake_targets || [];
  }
  let hint = "{}";
  if (branch === "ANSWER" || branch === "PREFILTER") {
    const tmp = clone(st);
    if (curTask && cur.qtype === "MAIN") tmp.tasks[curTask].a = 1;
    for (const tid of cfg.order[st.stage]) {
      const t = cfg.tasks[tid];
      if (
        t.kind === "main" &&
        !tmp.tasks[tid].a &&
        !covered(cfg, tmp, tid) &&
        tid !== curTask
      ) {
        hint = S(spec(cfg, st, tid, "MAIN"));
        break;
      }
    }
  }
  const SR = cfg.stage_rules || {};
  const stageRules =
    curTask === "NEED"
      ? SR.NEED
      : inCard
        ? SR.CARD
        : (cfg.tasks[curTask] || {}).kind === "supplement"
          ? SR.SUP
          : SR.default;
  const slim = (s) => {
    try {
      const o = JSON.parse(s);
      if (!o || !o.task_id) return s;
      const {
        known_facts,
        recent_dialog,
        avoid_texts,
        fallback,
        scenes,
        ...rest
      } = o;
      return S(rest);
    } catch (e) {
      return s;
    }
  };
  return {
    branch,
    state: S(st),
    cont_q: contQ,
    reply_static: reply,
    user_text: ui.slice(0, inputLimit(cfg, curTask)),
    forced_und: forcedUnd,
    stage_rules: stageRules || "",
    cur_task_slim: slim(S(curSpec)),
    next_hint_slim: slim(hint),
    tag_catalog:
      cfg.tag_catalog_in_prompt && curTask === "NEED"
        ? Object.entries(cfg.tag_lib)
            .map(([k, v]) => `${k}｜${v.text}｜${v.cat}`)
            .join("\n")
        : "（未启用）",
    cur_q: cur.text || "",
    cur_task: S(curSpec),
    field_dict: fieldDictText(cfg),
    facts_text: factsText(cfg, st),
    recent_dialog: S(st.dialog.slice(-2)),
    stage: st.stage,
    budget_left: String(budgetLeft(cfg, st, st.stage)),
    cards_text: inCard ? cardsText(st) : "（当前不在人物卡阶段）",
    next_hint: hint,
    q_task_spec: qSpec,
  };
}
/* ---------- N38 ---------- */
function N38(raw) {
  raw = String(raw || "");
  const d = parseLoose(raw);
  let ok =
    !!d &&
    [
      "answered",
      "partial",
      "unclear",
      "refused",
      "nothing_to_add",
      "off_topic",
      "asks_back",
      "risk",
    ].includes(d.answer_status);
  const record = x => x && typeof x === 'object' && !Array.isArray(x);
  for (const key of ['facts','conflicts','need_responses']) {
    if (d[key] !== undefined && (!Array.isArray(d[key]) || !d[key].every(record))) ok = false;
  }
  for (const key of ['refused_targets','need_tag_ids']) {
    if (d[key] !== undefined && (!Array.isArray(d[key]) || !d[key].every(v => typeof v === 'string'))) ok = false;
  }
  for (const key of ['ack','reply_text','feedback_close','next_question_draft','turn_signal','card_level'])
    if (d[key] !== undefined && typeof d[key] !== 'string') ok = false;
  if (d.reference_task !== undefined && d.reference_task !== null && typeof d.reference_task !== 'string') ok=false;
  if (d.ack_worthy !== undefined && typeof d.ack_worthy !== 'boolean') ok=false;
  if (d.prefilter !== undefined && typeof d.prefilter !== 'string') ok=false;
  if (d.turn_signal !== undefined && !['normal','user_question','flow_feedback'].includes(d.turn_signal)) ok=false;
  if (d.card_level !== undefined && !['none','L1','L2','L3'].includes(d.card_level)) ok=false;
  for (const key of ['followup','card_followup','card_interest'])
    if (d[key] !== undefined && !record(d[key])) ok = false;
  for (const [key,flag] of [['followup','worth'],['card_followup','needed']]) {
    if (d[key]?.[flag] !== undefined && typeof d[key][flag] !== 'boolean') ok = false;
    if (d[key]?.question !== undefined && typeof d[key].question !== 'string') ok = false;
    if (d[key]?.[flag] === true && !d[key].question?.trim()) ok=false;
  }
  if (record(d.card_interest)) {
    const c=d.card_interest;
    if(c.target!==undefined&&c.target!==null&&typeof c.target!=='string')ok=false;
    if(c.sentiment!==undefined&&!['positive','neutral','negative','unclear'].includes(c.sentiment))ok=false;
    if(c.intensity!==undefined&&!['strong','normal','unclear'].includes(c.intensity))ok=false;
  }
  for (const f of Array.isArray(d.facts) ? d.facts : []) {
    if (!record(f) || !['field','sub','subject','value','evidence'].every(k => typeof f[k] === 'string')) {ok=false;continue;}
    for (const k of ['condition','polarity','strength','priority','op']) if(f[k] !== undefined && typeof f[k] !== 'string') ok=false;
    if(f.op !== undefined && !['add','correct'].includes(f.op)) ok=false;
    if(f.polarity !== undefined && !['肯定','否定'].includes(f.polarity)) ok=false;
    if(f.strength !== undefined && !['硬性','偏好'].includes(f.strength))ok=false;
    if(f.priority !== undefined && !['core','normal'].includes(f.priority))ok=false;
  }
  for (const f of Array.isArray(d.conflicts) ? d.conflicts : [])
    if(!record(f)||!['field','sub','subject','evidence'].every(k=>typeof f[k]==='string')||(f.note!==undefined&&typeof f.note!=='string'))ok=false;
  for (const f of Array.isArray(d.need_responses) ? d.need_responses : [])
    if(!record(f)||!['target','status','evidence'].every(k=>typeof f[k]==='string'))ok=false;
  return {
    ok,
    reason: ok
      ? "ok"
      : raw
        ? "非 JSON 或缺少 answer_status"
        : "空输出（超时或报错）",
  };
}
/* ---------- N05 ---------- */
function N05(und) {
  // 主备模型与 N09 共享 N38 的结构校验标准。
  return { parse_ok: N38(und).ok };
}
/* ---------- N09 ---------- */
function N09(cfg, stateStr, ui, undTxt) {
  const st = JSON.parse(stateStr),
    und = N38(undTxt).ok ? parseLoose(undTxt) : {},
    fields = cfg.fields;
  st.notes = st.notes || [];
  const statusOk = [
    "answered",
    "partial",
    "unclear",
    "refused",
    "nothing_to_add",
    "off_topic",
    "asks_back",
    "risk",
  ];
  const cands = [...(und.facts || [])].sort((a,b) =>
    Number(b.field==='NEED'&&b.sub==='lifestyle'&&b.value==='不限'&&unconditional(b)) -
    Number(a.field==='NEED'&&a.sub==='lifestyle'&&a.value==='不限'&&unconditional(a)));
  const written = [],
    rejected = [],
    nui = norm(ui);
  for (const f of cands) {
    const { field: fid, sub, subject: subj, value: val } = f,
      ev = f.evidence || "";
    let reason = "";
    if (!fields[fid]) reason = "字段不存在";
    else if (!fields[fid].subs[sub]) reason = "子项不存在";
    else if (!fields[fid].subjects.includes(subj)) reason = "对象不合法";
    else if (fields[fid].subs[sub].subjects && !fields[fid].subs[sub].subjects.includes(subj)) reason = "子项对象不合法";
    else if (!ev || norm(ev).length < 1 || !nui.includes(norm(ev)))
      reason = "证据不是用户原话";
    else if (PII.test(String(val)) || PII.test(ev))
      reason = "含联系方式等隐私信息";
    else if (
      cfg.blocked.compliance.some(
        (w) => String(val).includes(w) || ev.includes(w),
      )
    )
      reason = "命中合规屏蔽词";
    else {
      const d = fields[fid].subs[sub];
      if (d.type === "enum" && !d.values.includes(val)) reason = "枚举值不合法";
      else if (d.type === "open" && (!val || String(val).length > (fid === 'Q12' ? 320 : 40)))
        reason = "开放值为空或过长";
    }
    if (reason) {
      rejected.push({ fact: `${fid}.${sub}=${val}`, reason });
      continue;
    }
    // 明确撤销一个维度的限制时，同范围旧偏好失效；不拿“未提及”代替撤销。
    if (fid === "NEED" && subj === "TA") {
      const cancelHeight =
        sub === "height" && val === "不限" && unconditional(f);
      const cancelLifestyle =
        sub === "lifestyle" && val === "不限" && unconditional(f);
      st.facts.forEach((x) => {
        if (!x.active || x.field !== "NEED" || x.subject !== "TA") return;
        if (
          (cancelHeight && x.sub === "height") ||
          (cancelLifestyle && LIFESTYLE_SUBS.includes(x.sub)) ||
          (sub === "height" &&
            val !== "不限" &&
            unconditional(f) &&
            x.sub === "height" &&
            x.value === "不限") ||
          (LIFESTYLE_SUBS.includes(sub) &&
            val !== "不限" &&
            unconditional(f) &&
            x.sub === "lifestyle" &&
            x.value === "不限")
        ) {
          x.active = false;
          x.superseded_turn = st.turn;
        }
      });
      if (cancelLifestyle)
        st.notes.forEach((x) => {
          if (
            x.active &&
            x.field === "NEED" &&
            x.subject === "TA" &&
            LIFESTYLE_SUBS.includes(x.sub)
          )
            x.active = false;
        });
    }
    st.notes.forEach((x) => {
      if (x.active && x.field === fid && x.sub === sub && x.subject === subj)
        x.active = false;
    }); // 有了明确的新值，矛盾附注失效
    const same = st.facts.filter(
      (x) =>
        x.active &&
        x.status === "已确认" &&
        x.field === fid &&
        x.sub === sub &&
        x.subject === subj &&
        (fid !== 'CARD' || x.card_set_id === st.card_set_id),
    );
    const isEnum =
      fields[fid].subs[sub].type === "enum" && !fields[fid].subs[sub].multi;
    const identical = same.some(x => x.value === val && (x.polarity||'肯定') === (f.polarity||'肯定') &&
      (x.condition||'') === (f.condition||'') && (x.strength||'偏好') === (f.strength||'偏好') && (x.priority||'normal') === (f.priority||'normal'));
    if (identical && f.op !== "correct") continue;
    if (isEnum || f.op === "correct" || same.some(x => x.value===val))
      same.filter(x => isEnum || f.op === 'correct' || x.value === val).forEach((x) => {
        x.active = false;
        x.superseded_turn = st.turn;
      });
    st.fv += 1;
    const rec = {
      field: fid,
      sub,
      subject: subj,
      value: val,
      polarity: f.polarity || "肯定",
      condition: f.condition || "",
      strength: ["硬性", "偏好"].includes(f.strength) ? f.strength : "偏好",
      ...(fid === 'NEED' ? {priority:f.priority==='core'?'core':'normal'} : {}),
      ...(fid === 'CARD' ? {card_set_id:st.card_set_id||'',candidate_ids:(st.cards||[]).filter(c=>
        String(val).split(/[、,，\s]+/).includes(c.key)||c.name&&(String(val).includes(c.name)||ev.includes(c.name))).map(c=>c.id)} : {}),
      source_question: String(st.current?.text || "").slice(0, 300),
      source_qtype: String(st.current?.qtype || ""),
      source_parent_task: String(st.current?.parent_task_id || ""),
      evidence: ev,
      src: (st.current || {}).task || "",
      status: "已确认",
      active: true,
      turn: st.turn,
      ver: st.fv,
      op: f.op || "add",
    };
    st.facts.push(rec);
    written.push(rec);
  }
  for (const feedback of written.filter(f => f.field==='CARD'&&f.sub==='l2'&&!f.candidate_ids.length)) {
    // A single explicitly selected candidate is an unambiguous parent for its
    // attraction feedback. Multiple selections stay unresolved rather than guessed.
    let choices=written.filter(f=>f.field==='CARD'&&f.sub==='l1'&&f.candidate_ids.length);
    if (!choices.length && st.current?.qtype==='CARD_FOLLOWUP') {
      const named=(st.cards||[]).filter(c=>c.name&&String(st.current.text).includes(c.name));
      if(named.length===1) feedback.candidate_ids=[named[0].id];
      else choices=activeFacts(st).filter(f=>f.field==='CARD'&&f.sub==='l1'&&f.card_set_id===st.card_set_id);
    }
    const ids=[...new Set(choices.flatMap(f=>f.candidate_ids||[]))];
    if(!feedback.candidate_ids.length&&ids.length===1)feedback.candidate_ids=ids;
  }
  for (const cf of und.conflicts || []) {
    const { field: fid, sub, subject: subj } = cf,
      ev = cf.evidence || "";
    if (
      fields[fid] &&
      fields[fid].subs[sub] &&
      fields[fid].subjects.includes(subj) &&
      ev &&
      nui.includes(norm(ev))
    ) {
      st.notes.push({
        field: fid,
        sub,
        subject: subj,
        note: String(cf.note || "").slice(0, 60),
        evidence: ev,
        turn: st.turn,
        active: true,
      });
      written.push({ field: fid, sub, status: "矛盾附注", evidence: ev });
    } else
      rejected.push({
        fact: `${fid}.${sub}（矛盾）`,
        reason: "字段或证据不合法",
      });
  }
  // 模型未提取最后一题时，保留明确的开放补充；反问、拒答和被拒事实不兜底。
  const a = statusOk.includes(und.answer_status)
    ? und.answer_status
    : "unclear";
  st._und = {
    answer_status: a,
    refused_targets: (und.refused_targets || []).filter((t) => cfg.tasks[t]),
    card_level: und.card_level || "none",
    followup: und.followup || {},
    card_followup: und.card_followup || {},
    ack: String(und.ack || ""),
    next_question_draft: und.next_question_draft || "",
    parse_ok: Object.keys(und).length > 0,
    prefilter: und.prefilter || "",
    turn_signal: ["normal", "user_question", "flow_feedback"].includes(
      und.turn_signal,
    )
      ? und.turn_signal
      : "normal",
    reference_task:
      und.turn_signal === "flow_feedback" &&
      typeof und.reference_task === "string" &&
      cfg.tasks[und.reference_task]?.kind === "main"
        ? und.reference_task
        : null,
    reply_text: ["user_question", "flow_feedback"].includes(und.turn_signal)
      ? String(und.reply_text || "")
          .replace(/[\r\n]+/g, " ")
          .trim()
      : "",
    feedback_close:
      und.turn_signal === "flow_feedback"
        ? String(und.feedback_close || "")
            .replace(/[\r\n]+/g, " ")
            .trim()
        : "",
  };
  if (cfg.need_intake?.enabled) {
    const intake = needIntake(st);
    st.need_intake = intake;
    st._und.need_responses = [];
    for (const response of Array.isArray(und.need_responses)
      ? und.need_responses
      : []) {
      if (
        !["height", "lifestyle"].includes(response.target) ||
        !["refused", "unclear"].includes(response.status) ||
        !response.evidence ||
        !norm(response.evidence) ||
        !nui.includes(norm(response.evidence))
      )
        continue;
      if (intake.missing.includes(response.target)) {
        const accepted = {
          target: response.target,
          status: response.status,
          evidence: response.evidence,
          turn: st.turn,
        };
        intake.responses[response.target] = accepted;
        st._und.need_responses.push(accepted);
      }
    }
    for (const target of ["height", "lifestyle"])
      if (intake.known[target]) delete intake.responses[target];
  }
  st._new = written;
  return {
    state: S(st),
    written: S(written),
    rejected: S(rejected),
    debug: `写入${written.length}条 拒绝${rejected.length}条 answer_status=${a}`,
  };
}
/* ---------- N10 ---------- */
function N10(cfg, stateStr) {
  const st = JSON.parse(stateStr);
  const ck = new Set(
    (st.notes || []).filter((n) => n.active).map((n) => n.field + "." + n.sub),
  );
  const facts = activeFacts(st).filter((f) => !ck.has(f.field + "." + f.sub));
  st.need_tags = Object.entries(cfg.tag_lib||{}).filter(([id,t]) => facts.some(f =>
    f.field==='NEED'&&f.subject==='TA'&&(f.polarity||'肯定')==='肯定'&&f.value!=='不限'&&
    (String(f.value)===t.text || (t.kw||[]).some(k=>String(f.value).includes(k))))).map(([id])=>id).sort();
  const out = {};
  for (const scene of ["60", "100"]) {
    const hits = [];
    for (const t of cfg.tag_dict) {
      if (!t.scenes.includes(scene)) continue;
      for (const f of facts) {
        if (
          f.field !== t.field ||
          f.sub !== t.sub ||
          !t.subject.includes(f.subject)
        )
          continue;
        const v = String(f.value);
        const ok =
          (t.in || []).includes(v) ||
          (t.contains || []).some((k) => v.includes(k));
        if (ok && (f.polarity || "肯定") !== "否定") {
          hits.push({
            tag_id: t.id,
            text: t.text,
            cat: t.cat || "",
            source: `${f.field}.${f.sub}`,
            evidence_ver: f.ver,
            group: t.group,
            p: t.p,
          });
          break;
        }
      }
    }
    const seen = new Set(),
      chosen = [];
    hits
      .sort((a, b) => a.p - b.p)
      .forEach((h) => {
        if (seen.has(h.group)) return;
        seen.add(h.group);
        chosen.push({
          tag_id: h.tag_id,
          text: h.text,
          cat: h.cat,
          source: h.source,
          evidence_ver: h.evidence_ver,
        });
      });
    out[scene] = chosen.slice(0, cfg.tag_max[scene]);
  }
  st.tags = {
    60: out["60"],
    100: out["100"],
    mapping_version: "demo-1",
    fv: st.fv || 0,
  };
  return {
    state: S(st),
    tags_60: S(out["60"]),
    tags_100: S(out["100"]),
    debug: `60%标签${out["60"].length} 100%标签${out["100"].length}`,
  };
}
/* ---------- N11 ---------- */
function N11(cfg, stateStr, ui, hintStr) {
  const st = JSON.parse(stateStr);
  let hint = {};
  try {
    hint = JSON.parse(hintStr || "{}");
  } catch (e) {}
  const und = st._und || {},
    stage = st.stage,
    cur = st.current,
    tid = cur.task,
    qtype = cur.qtype,
    T = st.tasks,
    lim = cfg.limits;
  let status = und.answer_status || "unclear";
  const isUserQuestion =
    und.turn_signal === "user_question" && status !== "risk";

  const isFlowFeedback =
    und.turn_signal === "flow_feedback" && status !== "risk";

  const suppressExtra = isUserQuestion || isFlowFeedback;

  // 纯反问或流程反馈，不作为需要重问的跑题回答
  if (suppressExtra && ["asks_back", "off_topic"].includes(status)) {
    status = "skipped";
  }
  st.stat = st.stat || {};
  st.stat[status] = (st.stat[status] || 0) + 1;
  if (tid === "NEED") st.need_status = status;
  st.dialog = [
    ...st.dialog,
    { q: cur.text, a: String(ui).slice(0, inputLimit(cfg, tid)), task_id: tid, turn: st.turn, answer_status: status },
  ].slice(-8);
  const hold = (text, why) => {
    st.plan = { action: "HOLD", task: tid, qtype };
    return {
      state: S(st),
      action: "HOLD",
      route: "READY",
      candidate_q: text,
      q_task_spec: "",
      need_ack: false,
      ack_anchor: "",
      rel_facts_text: "",
      debug: `动作=HOLD（${why}）原题保留`,
    };
  };
  if (status === "risk") {
    st._care = true;
    status = "skipped";
  } // 口头关怀一句，主流程照常推进
  if (und.parse_ok === false) {
    cur.fail = (cur.fail||0)+1;
    return hold("刚刚出了点小问题，可以再试一次吗？", "模型失败，不结算");
  }
  // Complete original Q/A lives beyond the 8-turn dialogue window. Reuse the
  // existing privacy/compliance boundaries; never sanitize by editing raw text.
  const rawAnswer=String(ui), turnId=st.turn_id || `turn_${st.turn}`;
  if(['answered','partial'].includes(status) && !PII.test(rawAnswer) &&
    !cfg.blocked.compliance.some(w=>rawAnswer.includes(w))){
    if(['LIFE','SUP1','SUP2','SUP3','SUP4'].includes(tid)){
      st.topic_candidates ||= [];
      if(!st.topic_candidates.some(q=>q.turn_id===turnId))st.topic_candidates.push({
        turn_id:turnId,task_id:tid,qtype,question:String(cur.text||''),raw_answer:rawAnswer,
        answer_status:status,turn:st.turn,
      });
    }
    if(tid==='Q5'){
      st.q5_answers ||= [];
      if(!st.q5_answers.some(q=>q.turn_id===turnId))st.q5_answers.push({turn_id:turnId,text:rawAnswer,turn:st.turn});
    }
  }
  if (status === "asks_back" && !suppressExtra && !(cfg.no_reask_tasks||[]).includes(tid)) {
    if (!cur.hold) {
      const prefix = cfg.asks_back_template.replace(
        "{about}",
        cfg.tasks[tid].about || "想法",
      );
      st.plan = {
        action: "REASK",
        task: tid,
        qtype,
        hold: 1,
        prefix,
        ...(cur.intake_target ? { intake_target: cur.intake_target } : {}),
        ...(cur.intake_targets ? { intake_targets: cur.intake_targets } : {}),
      };
      if (qtype === "MAIN" || qtype === "REPLACE")
        return {
          state: S(st),
          action: "REASK",
          route: "READY",
          candidate_q: coreOf(cfg, st, tid),
          q_task_spec: "",
          rel_facts_text: "",
          debug: `动作=REASK 目标=${tid}（核心句原样）`,
        };
      return {
        state: S(st),
        action: "REASK",
        route: "READY",
        candidate_q: cur.text,
        q_task_spec: "",
        need_ack: false,
        ack_anchor: "",
        rel_facts_text: "",
        debug: `动作=REASK（追问原句重发）目标=${tid}`,
      };
    }
    status = "skipped";
  }

  if (tid === "NEED" && cfg.need_intake?.enabled) {
    const intakeRoute = needIntakeRoute(
      cfg,
      st,
      und.answer_status === "risk" ? "risk" : status,
    );
    if (intakeRoute) return intakeRoute;
  }

  for (const t in T)
    if (cfg.tasks[t]?.kind === "main")
      T[t].covered = covered(cfg, st, t) ? 1 : 0;
  const refused = new Set(und.refused_targets || []);
  if (status === "refused" && ["MAIN", "REPLACE", "FOLLOW_UP"].includes(qtype))
    refused.add(tid);
  refused.forEach((r) => (T[r].refused = 1));
  const target = isFlowFeedback ? und.reference_task : null,
    task = target && cfg.tasks[target],
    targetState = target && T[target];
  const canBackfill = !!(
    task &&
    targetState &&
    target !== tid &&
    target !== "CARD_L1" &&
    task.stage === stage &&
    task.kind === "main" &&
    targetState.a === 1 &&
    st.history.some((h) => h.task === target) &&
    !targetState.covered &&
    !targetState.refused &&
    !(cfg.no_replace_tasks || []).includes(target) &&
    targetState.rep < lim.replace_per_task &&
    budgetLeft(cfg, st, stage) > 0
  );
  // 纯反馈回补后，未回答的当前主问题仍由题序找回；混合回答则正常结算。
  const deferCurrent = canBackfill && status === "skipped";
  st.asked = st.asked || {};
  if (!deferCurrent) st.asked[stage] = (st.asked[stage] || 0) + 1;
  if (!deferCurrent && ["MAIN", "REPLACE", "NEED_CLARIFY"].includes(qtype)) {
    T[tid].a = 1;
    st.pending = st.pending.filter((x) => x.task !== tid);
    if (
      !suppressExtra &&
      !(cfg.no_replace_tasks || []).includes(tid) &&
      !T[tid].covered &&
      !T[tid].refused &&
      T[tid].rep < lim.replace_per_task &&
      ["unclear", "partial", "off_topic"].includes(status)
    )
      st.pending.push({ task: tid, since: 0 });
  } else if (!deferCurrent && qtype === "FOLLOW_UP") T[tid].h = 1;
  else if (!deferCurrent && qtype === "CARD_FOLLOWUP") T[tid].done = 1;
  st.pending = st.pending.filter(
    (x) => T[x.task] && !(cfg.no_replace_tasks||[]).includes(x.task) && !T[x.task].covered && !T[x.task].refused,
  );
  if (canBackfill) {
    targetState.rep += 1;
    st.used[stage].R += 1;
    st.pending = st.pending.filter((x) => x.task !== target);
    st.plan = { action: "FEEDBACK_ASK", task: target, qtype: "REPLACE" };
    st.progress = progressOf(cfg, st);
    return {
      state: S(st),
      action: "FEEDBACK_ASK",
      route: "QGEN",
      candidate_q: "",
      q_task_spec: S(leadSpec(cfg, st, target)),
      rel_facts_text: "",
      life_facts_text: "",
      debug: `反馈回补 ${target}，消耗 R=1`,
    };
  }
  let action = null,
    pTask = null,
    pQ = null,
    cand = "";
  const inCard = tid === "CARD_L1" || qtype === "CARD_FOLLOWUP";
  if (inCard) {
    const cf = und.card_followup || {};
    // 代码兜底：说出了对 TA 的要求（L3）→ 不追；追问后说不清 / 跑题 / 拒答 → 停；追问② 和追问① 问的是同一件事 → 停
    const l3 =
      und.card_level === "L3" ||
      (st._new || []).some((f) => f.field === "NEED");
    const stopSt = [
      "refused",
      "skipped",
      ...(qtype === "CARD_FOLLOWUP" ? ["unclear", "off_topic"] : []),
    ];
    const prevFu = st.history
      .filter((h) => h.qtype === "CARD_FOLLOWUP")
      .map((h) => h.text);
    const sim = (a, b) => {
      const A = new Set(norm(a)),
        B = new Set(norm(b));
      const inter = [...A].filter((x) => B.has(x)).length;
      return inter / Math.max(1, Math.min(A.size, B.size));
    };
    const dup = !!cf.question && prevFu.some((t) => sim(t, cf.question) >= 0.7);
    st.card_guard = l3
      ? "L3"
      : stopSt.includes(status)
        ? "停止：" + status
        : dup
          ? "和上一次追问重复"
          : "";
    for (const j of ["CARD_F1", "CARD_F2"]) {
      if (T[j].done) continue;
      const can =
        !suppressExtra &&
        cf.needed &&
        !l3 &&
        !dup &&
        st.card_fu < lim.card_followup &&
        budgetLeft(cfg, st, stage) > 0 &&
        !T.CARD_L1.refused &&
        !stopSt.includes(status) &&
        qOk(cfg, cf.question);
      if (can) {
        action = "FOLLOW_UP";
        pTask = j;
        pQ = "CARD_FOLLOWUP";
        cand = cf.question.trim();
        st.card_fu += 1;
        st.used[stage].F += 1;
      } else ["CARD_F1", "CARD_F2"].forEach((jj) => (T[jj].done = 1));
      break;
    }
    T.CARD_L1.done = T.CARD_L1.a ? 1 : 0;
  } else if (tid === 'Q7' && qtype === 'MAIN' && !suppressExtra && ['answered','partial'].includes(status) && !T[tid].refused && missing(cfg,st,tid).length===1 && T[tid].fu===0) {
    const sub=missing(cfg,st,tid)[0].split('.')[1];
    action='FOLLOW_UP';pTask=tid;pQ='FOLLOW_UP';cand=cfg.q7_followup?.[sub] || (sub==='smoke'?'你平常会抽烟吗？':'你平常喝酒吗？');
    T[tid].fu=1;T[tid].f=1; // fixed missing-field clarification, separate from dynamic F budget
  } else if (qtype === "MAIN") {
    const fu = und.followup || {};
    if (
      !suppressExtra &&
      !(cfg.no_followup_tasks || []).includes(tid) &&
      T[tid].covered &&
      !T[tid].refused &&
      ["answered", "partial"].includes(status) &&
      fu.worth &&
      T[tid].fu < lim.followup_per_task &&
      budgetLeft(cfg, st, stage) > 0 &&
      qOk(cfg, fu.question)
    ) {
      action = "FOLLOW_UP";
      pTask = tid;
      pQ = "FOLLOW_UP";
      cand = fu.question.trim();
      T[tid].fu += 1;
      T[tid].f = 1;
      st.used[stage].F += 1;
    }
  }
  if (
    action === null &&
    cfg.tasks[tid].kind === "main" &&
    cfg.tasks[tid].stage === stage
  )
    T[tid].done = T[tid].a && (!T[tid].f || T[tid].h) ? 1 : T[tid].done;
  if (action === null && !suppressExtra) {
    const rep = st.pending.find((x) => x.since >= 1);
    if (rep && budgetLeft(cfg, st, stage) > 0) {
      action = "REPLACE_LATER";
      pTask = rep.task;
      pQ = "REPLACE";
      T[rep.task].rep += 1;
      st.used[stage].R += 1;
      st.pending = st.pending.filter((x) => x !== rep);
      st.pending.forEach((x) => (x.since += 1));
    }
  }
  if (action === null) {
    let nxt = null;
    for (const t of cfg.order[stage]) {
      const ts = T[t];
      if (cfg.tasks[t].kind !== "main" || ts.a) continue;
      if (ts.covered || ts.refused) {
        ts.a = 1;
        ts.done = 1;
        continue;
      }
      nxt = t;
      break;
    }
    const PC = (cfg.pace || {})[stage] || {};
    const atTrigger =
      PC.trigger === "end"
        ? !nxt
        : PC.trigger && PC.trigger === "before:" + nxt;
    const sup =
      !suppressExtra && atTrigger ? pickSupplement(cfg, st, stage) : null;
    if (sup) {
      action = "SUPPLEMENT";
      pTask = sup;
      pQ = "SUPPLEMENT";
      st.used[stage].S += 1;
      st.sup_used = st.sup_used || {};
      st.sup_used[stage] = (st.sup_used[stage] || 0) + 1;
      st.pending.forEach((x) => (x.since += 1));
    } else if (nxt) {
      action = "ASK_NEXT";
      pTask = nxt;
      pQ = "MAIN";
      st.pending.forEach((x) => (x.since += 1));
    } else {
      st.pending = [];
      action = stage === "S60" ? "SHOW_60" : "GENERATE_PROFILE";
    }
  }
  st.progress = progressOf(cfg, st);
  let qs = "",
    route = "READY";
  if (action === "SHOW_60") {
    st.plan = { action };
    route = "SHOW_60";
    st.stage = "AWAIT_60";
    st.current = null;
    st.progress = progressOf(cfg, st);
  } else if (action === "GENERATE_PROFILE") {
    st.plan = { action };
    route = "GENERATE_PROFILE";
    st.stage = "PROFILE_GEN";
    st.current = null;
  } else if (action === "ASK_NEXT" && pTask === "CARD_L1") {
    route = "CARDS";
    st.plan = { action, task: pTask, qtype: pQ };
  } else {
    st.plan = { action, task: pTask, qtype: pQ };
    if (action === "ASK_NEXT" || action === "SUPPLEMENT")
      cand = cfg.tasks[pTask].script || cfg.tasks[pTask].fallback; // V1：主问题、补充问题都用脚本原文
    else if (action === "REPLACE_LATER") {
      route = "QGEN";
      qs = S(leadSpec(cfg, st, pTask));
    } // 换场景重问：只让模型写引子
    if (!cand && !qs) {
      route = "QGEN";
      qs = S(leadSpec(cfg, st, pTask));
    }
  }
  const nw = st._new || [];
  const anchor = nw
    .map((f) => `${cfg.fields[f.field].name}：${f.evidence}`)
    .join("；");
  const left = ["S60", "S40"].includes(stage) ? budgetLeft(cfg, st, stage) : 0;
  return {
    state: S(st),
    action,
    route,
    candidate_q: cand,
    q_task_spec: qs,
    rel_facts_text: factsText(
      cfg,
      st,
      ["NEED", "Q3", "Q4", "Q8", "Q9", "Q10", "Q11", "CARD", "SELF"],
      true,
    ),
    life_facts_text: factsText(
      cfg,
      st,
      ["Q1", "Q2", "Q3", "Q5", "Q6", "Q7", "SELF"],
      true,
    ),
    debug: `动作=${action} 目标=${pTask} 进度=${st.progress}% 剩余额度=${left} 待替换=[${st.pending.map((x) => x.task)}]`,
  };
}
/* ---------- N15 / N18 ---------- */
function N15(cfg, llmOut, specStr, isFinal) {
  const sp = parseLoose(specStr);
  if (sp.mode === "lead") {
    const lead = String(parseLoose(llmOut).lead || "").trim();
    let reason = "";
    if (lead.length < 4 || lead.length > 22) reason = "引子长度不合规";
    else if (/[？?]/.test(lead)) reason = "引子里提问了";
    else if (!/[～。]$/.test(lead)) reason = "引子结尾不合规";
    else if (/[。！!～~\r\n]/.test(lead.slice(0, -1)))
      reason = "引子不是一句陈述";
    else if (
      [...cfg.blocked.compliance, ...cfg.blocked.no_ask].some((w) =>
        lead.includes(w),
      )
    )
      reason = "含屏蔽词";
    if (!reason)
      return {
        pass: true,
        q_text: lead + sp.core,
        used_fallback: false,
        reason: "ok",
      };
    if (isFinal)
      return { pass: true, q_text: sp.core, used_fallback: true, reason };
    return { pass: false, q_text: "", used_fallback: false, reason };
  }
  const q = String(parseLoose(llmOut).question || "").trim();
  let reason = "";
  if (q.length < 4 || q.length > 80) reason = "长度不合规";
  else if (qmarks(q) > 2) reason = "一次问了多个问题";
  else if (
    [...cfg.blocked.compliance, ...cfg.blocked.no_ask].some((w) =>
      q.includes(w),
    )
  )
    reason = "含屏蔽词";
  else if ((sp.avoid_texts || []).includes(q)) reason = "与已问过的问法重复";
  if (!reason)
    return { pass: true, q_text: q, used_fallback: false, reason: "ok" };
  if (isFinal)
    return {
      pass: true,
      q_text: sp.fallback || "",
      used_fallback: true,
      reason,
    };
  return { pass: false, q_text: q, used_fallback: false, reason };
}
/* ---------- N23 ---------- */
// 口头关怀：只是一句温暖的承接，放在下一条回复最前面
function careLine(cfg, st) {
  if (!st._care) return "";
  st._care = false;
  const L = cfg.care_ack || [];
  return L.length ? L[(st.turn || 0) % L.length] : "";
}
const replyParagraph = (text) =>
  String(text || "")
    .replace(/\s*[\r\n]+\s*/g, "")
    .trim();
function replyQuestion(cfg, plan, text) {
  text = String(text || "").trim();
  const task = cfg.tasks[plan.task] || {};
  const scripted =
    ["ASK_NEXT", "SUPPLEMENT"].includes(plan.action) &&
    [task.script, task.fallback].some(
      (script) => typeof script === "string" && script.trim() === text,
    );
  return scripted
    ? text
        .split(/\r?\n\s*\r?\n/)
        .map(replyParagraph)
        .filter(Boolean)
        .join("\n\n")
    : replyParagraph(text);
}
function selectAck(cfg, st) {
  const care = careLine(cfg, st);
  if (care) return { text: replyParagraph(care), care: true };
  const und = st._und || {};
  if (!und.answer_status || und.parse_ok === false)
    return { text: "", care: false };

  // Restore 10.22: use the model's valid conversational ACK first.
  const ack = replyParagraph(und.ack);
  const valid =
    ack &&
    [...ack].length <= 25 &&
    !/[？?]/.test(ack) &&
    !(cfg.blocked?.compliance || []).some(w => ack.includes(w));
  if (valid) return { text: ack, care: false };

  // Existing lazy ACK is only a fallback for unclear/off-topic/refused turns.
  if (
    ['unclear', 'off_topic', 'refused'].includes(und.answer_status) &&
    und.turn_signal === 'normal' &&
    (cfg.lazy_ack || []).length
  ) {
    const list = cfg.lazy_ack;
    const fallback = list[(st.turn || 0) % list.length];
    return {
      text: replyParagraph(
        fallback.replace('{about}', cfg.tasks[st.current?.task]?.about || '这个')
      ),
      care: false
    };
  }
  // No mechanical ACK when the model has no usable one.
  return { text: "", care: false };
}
function buildTurnReply(cfg, st) {
  // careLine 会消费状态，只选择一次，并将 care 标志传给输出节点。
  const selected = selectAck(cfg, st);
  if (selected.care) return selected;
  const und = st._und || {};
  if (und.parse_ok === false) return selected;
  if (["user_question", "flow_feedback"].includes(und.turn_signal)) {
    const candidates =
      und.turn_signal === "flow_feedback"
        ? [und.reply_text,und.feedback_close]
        : [und.reply_text];
    for (const candidate of candidates) {
      const text = String(candidate || "")
        .replace(/[\r\n]+/g, " ")
        .trim();
      if (
        text &&
        [...text].length <= 120 &&
        !/[？?]/.test(text) &&
        !cfg.blocked.compliance.some((w) => text.includes(w))
      ) {
        return { text, care: false };
      }
    }
  }
  return selected;
}
function N23(cfg, stateStr, q) {
  const st = JSON.parse(stateStr);
  q = replyQuestion(cfg, st.plan || {}, q);
  const selected = buildTurnReply(cfg, st),
    ack = selected.text;
  if (selected.care) {
    const pl = st.plan || {};
    if (
      pl.action === "ASK_NEXT" &&
      cfg.tasks[pl.task] &&
      cfg.tasks[pl.task].core
    )
      q = replyParagraph(cfg.tasks[pl.task].core);
  } // 关怀之后去掉脚本里欢快的过渡句，只问问题本身
  const plan = st.plan || {},
    n = st.history.length + 1;
  if (plan.action === "HOLD") {
    st._new = [];
    return {
      reply: q + `\n\n— 画像进度 ${Math.floor((st.progress || 0) + 0.5)}%`,
      new_state: S(st),
    };
  }
  st.current = { task: plan.task, qtype: plan.qtype, text: q, qid: "q" + n };
  if (plan.intake_target) st.current.intake_target = plan.intake_target;
  if (plan.intake_targets) st.current.intake_targets = plan.intake_targets;
  st.history.push({ ...st.current });
  st._new = [];
  if (plan.action === "REASK") {
    st.current.hold = plan.hold || 1;
    q = replyParagraph(plan.prefix) + q;
  }
  // 已确认的烟酒单项模板自带承接，避免再拼一条模型 ack。
  const fixedQ7 = plan.task === 'Q7' && plan.qtype === 'FOLLOW_UP' &&
    Object.values(cfg.q7_followup || {}).includes(q);
  // Q4 的完整固定脚本自带“生活里的你有点轮廓啦～”过渡句。
  // 仅此情形抑制模型 ack；Q4 普通追问仍使用自然 ack。
  // REL script contains the exact approved S60-to-relationship transition.
  // Only remove the extra ACK when the full REL script is used.
  // Q7 scripted smoke/drink follow-ups retain their existing suppression.
  const transitionTask = cfg.tasks[plan.task];
  const relScriptedTransition =
    plan.task === 'REL' &&
    ['ASK_NEXT', 'SUPPLEMENT'].includes(plan.action) &&
    typeof transitionTask?.script === 'string' &&
    q === replyQuestion(cfg, plan, transitionTask.script);
  const prefixAck =
    (fixedQ7 || relScriptedTransition) && !selected.care ? '' : ack;
  let reply = replyParagraph(prefixAck) + q;
  reply += `\n\n— 画像进度 ${Math.floor((st.progress || 0) + 0.5)}%`;
  return { reply, new_state: S(st) };
}
/* ---------- N25 ---------- */
const NEED = {
  情感慰藉: "被理解、被陪着",
  灵魂共鸣: "能聊到一起的共鸣",
  现实助力: "生活里彼此搭把手",
  感官吸引: "心动的感觉",
};
// 是否拿到过用户自己的有效信息（人物卡选择、最后一题原话不算）
const hasInfo = (st) =>
  activeFacts(st).some((f) => !["CARD", "Q12"].includes(f.field));
// 兜底信号组：按“没说的方式”选文案和兜底标签
function fbGroup(st) {
  const s = st.stat || {},
    ref = s.refused || 0,
    unc = (s.unclear || 0) + (s.off_topic || 0);
  if (ref >= 2 && ref >= unc) return "boundary";
  if (unc >= 2) return "chill";
  if (
    activeFacts(st).some(
      (f) => f.field === "CARD" && f.sub === "l1" && f.value === "都没感觉",
    )
  )
    return "picky";
  if (st.need_status === "nothing_to_add") return "feel";
  return "default";
}
function fbText(cfg, st, slot) {
  const g = fbGroup(st),
    G = cfg.fallback_groups;
  const arr = (G[g] && G[g][slot]) || G.default[slot] || [""];
  return arr[(st.turn || 0) % arr.length];
}
// 画像标签只展示已确认事实映射；缺少标签时留空，不把拒答方式写成人格。
function withFallbackTags(cfg, st, real, min) {
  return (real || []).filter(t => t.kind !== "兜底" && !cfg.tag_text?.[t.tag_id])
    .map(t => ({ ...t, kind: "事实" }));
}
// 60% 标签：只用已确认事实映射出的标签，优先“情感 + 生活态度”各至少一个，共 3～4 个
function pick60Tags(cfg, st) {
  const all = (st.tags || {})["60"] || [],
    R = cfg.p60_card;
  const emo = all.filter((t) => t.cat === "社交情感"),
    life = all.filter((t) => t.cat !== "社交情感");
  const out = [];
  if (emo[0]) out.push(emo[0]);
  if (life[0]) out.push(life[0]);
  for (const t of all) {
    if (out.length >= R.tags_max) break;
    if (!out.includes(t)) out.push(t);
  }
  return withFallbackTags(cfg, st, out.slice(0, R.tags_max), R.tags_min);
}
// 60% 主文案的事实模板（模型生成不出来时用）：关系一句 + 生活一句
function p60Template(st) {
  const f = activeFacts(st),
    get = (fid, sub, subj) =>
      f.find(
        (x) =>
          x.field === fid &&
          (!sub || x.sub === sub) &&
          (!subj || x.subject === subj),
      );
  const need = get("Q11"),
    pace = get("Q4", "pace", "自己"),
    exp = get("Q8", "expectation");
  let rel = "";
  if (need) rel = `在关系里你更看重${NEED[need.value] || need.value}`;
  else if (pace && ["非常慢热", "偏慢热"].includes(pace.value))
    rel = "你在感情里偏慢热，愿意让关系慢慢升温";
  else if (exp) rel = `你希望两个人${String(exp.value).replace(/^希望/, "")}`;
  const it = get("Q1", "items"),
    sl = get("Q2", "sleep");
  let life = "";
  if (it) life = `日子里也爱${it.value}`;
  else if (sl)
    life =
      { 偏晚睡: "日子里是个夜猫子", 偏早睡: "日子里作息偏早" }[sl.value] || "";
  return rel && life
    ? `${rel}，${life}。`
    : rel
      ? rel + "。"
      : life
        ? "你" + life.replace(/^日子里/, "平时") + "。"
        : "";
}
function stageInsightText(text) {
  return String(text || "")
    .replace(/。|\.(?=\s|$)/g, "")
    .trim();
}
function N25(cfg, stateStr, llmOut) {
  const st = JSON.parse(stateStr);
  const out = parseLoose(llmOut);
  let line = typeof out.attitude === "string" ? out.attitude.trim() : "",
    status = "ok";
  const R = cfg.p60_card;
  if (
    !hasInfo(st) ||
    line.length < R.insight_min ||
    line.length > R.insight_max ||
    [...cfg.blocked.compliance, ...cfg.blocked.no_label].some((w) =>
      line.includes(w),
    ) ||
    out.insufficient !== false
  ) {
    status = !hasInfo(st) || out.insufficient === true ? "no_evidence" : "generation_error";
    line = "";
  }
  line = stageInsightText(line);
  const tags = pick60Tags(cfg, st);
  const care = careLine(cfg, st);
  const parts = care
    ? [care, "", "【LoveMi 眼中的你】"]
    : ["【LoveMi 眼中的你】"];
  const feedback = line ? "" : String(cfg.profile_empty60 || "");
  if (line || feedback) parts.push(line || feedback);
  if (tags.length) parts.push(tags.map((t) => "#" + t.text).join("  "));
  parts.push(
    "",
    `「${cfg.buttons.p60[0]}」　「${cfg.buttons.p60[1]}」`,
    `— 画像进度 ${Math.floor(st.progress + 0.5)}%`,
  );
  st.stage_card_60 = {
    attitude: line,
    stage_feedback: feedback,
    tags,
    content_status: status,
    fallback_group: "",
  };
  return { reply: parts.join("\n"), new_state: S(st), content_status: status };
}
/* ---------- N29 ---------- */
function rowsOf(cfg, facts, notes, only) {
  const out = [];
  for (const f of facts) {
    if (!only.includes(f.field)) continue;
    const nm = cfg.fields[f.field].name;
    const cond = f.condition ? `（条件：${f.condition}）` : "";
    const hard = f.strength === "硬性" ? "（硬性）" : "";
    out.push(
      `- ${f.field}.${f.sub}｜${nm}｜对象:${f.subject}｜极性:${f.polarity || "肯定"}｜${f.value}${hard}${cond}｜原话:${f.evidence}`,
    );
  }
  for (const n of notes) {
    if (!only.includes(n.field)) continue;
    out.push(
      `- ${n.field}.${n.sub}｜${cfg.fields[n.field].name}｜对象:${n.subject}｜（前后矛盾，需要综合判断）｜原话:${n.evidence}` +
        (n.note ? `｜说明:${n.note}` : ""),
    );
  }
  return out.join("\n") || "（暂无）";
}
function profileSupplement(st) {
  const input = ProfileEvidence.buildMapperInput(st, {includeQ12Raw:true,q12MaxChars:320});
  return [...new Set(input.facts.map(f => f.raw_answer || (f.field==='Q12'&&f.sub==='supplement' ? f.quote || f.value : '')).filter(v =>
    typeof v === 'string' && v.trim() && !/^(?:没有|暂无|无|没了|不确定|都行)[。！!～~\s]*$/.test(v.trim()) &&
    v.replace(/【联系方式已省略】/g, '').replace(/[\p{P}\p{S}\p{Z}\p{C}\s]/gu, '').length
  ))].join('\n');
}
function N29(cfg, stateStr) {
  const st = JSON.parse(stateStr);
  const facts = activeFacts(st),
    notes = (st.notes || []).filter((n) => n.active);
  const c60 = st.stage_card_60 || {};
  const supplement = profileSupplement(st);
  const withSupplement = text => supplement
    ? `${text}\n\n未分类的有效开放补充（仅用于原话实际支持的板块，不支持的板块留空；不转为匹配条件）：\n${supplement}`
    : text;
  return {
    rel_facts: withSupplement(rowsOf(cfg, facts, notes, [
      "NEED",
      "Q4",
      "Q8",
      "Q9",
      "Q10",
      "Q11",
      "CARD",
      "SELF",
      "Q12",
    ])),
    life_facts: withSupplement(rowsOf(cfg, facts, notes, [
      "Q1",
      "Q2",
      "Q3",
      "Q5",
      "Q6",
      "Q7",
      "SELF",
      "Q12",
    ])),
    p60_insight:
      c60.content_status === "ok" && c60.attitude ? c60.attitude : "无",
    state: S(st),
  };
}
/* ---------- N32 ---------- */
function phrase(f) {
  const k = f.field + "." + f.sub,
    v = f.value;
  if (f.field === "NEED")
    return ["traits", "interests", "other"].includes(f.sub)
      ? f.strength !== "硬性"
        ? `希望对方${v}`
        : `很在意对方${v}`
      : f.strength === "硬性"
        ? `在意对方${v}`
        : `希望对方${v}`;
  const T = {
    "Q1.items": `喜欢${v}`,
    "Q2.sleep":
      { 偏早睡: "作息偏早", 偏晚睡: "习惯晚睡", 不固定: "作息不太固定" }[v] ||
      "",
    "Q2.pace":
      { 比较忙碌: "平时比较忙", 相对轻松: "日子过得比较轻松" }[v] || "",
    "Q3.social":
      {
        明显偏独处: "更享受独处",
        比较偏独处: "更享受独处",
        比较偏社交: "喜欢热闹",
        明显偏社交: "喜欢热闹",
      }[v] || "",
    "Q5.has_pet": { 正在养: "养着宠物" }[v] || "",
    "Q5.animal_like": { 喜欢: "喜欢小动物" }[v] || "",
    "Q6.style": `消费上偏${v}`,
    "Q6.condition": v,
    "Q7.smoke": { 不吸: "不抽烟" }[v] || "",
    "Q7.drink": { 不喝: "不喝酒", 偶尔: "偶尔喝点酒" }[v] || "",
    "Q4.pace": f.subject === "自己" ? `在感情里${v}` : `希望对方${v}`,
    "Q11.need": `在关系里更看重${NEED[v] || v}`,
    "Q9.strategy": `忙起来会${v}`,
    "Q9.balance": `事业和感情之间${v}`,
    "Q10.openness": `聊到过去的感情时倾向${v}`,
    "Q8.expectation": `希望${v}`,
  };
  return T[k] || "";
}
function tpl(st, fields) {
  const parts = [];
  for (const f of st.facts.filter(
    (f) => f.active && f.status === "已确认" && fields.includes(f.field),
  )) {
    const x = phrase(f);
    if (x && !parts.includes(x)) parts.push(x);
  }
  return parts.length ? "你" + parts.join("，") + "。" : "";
}
function N32(cfg, stateStr, outRel, outLife) {
  const st = JSON.parse(stateStr);
  const rel = parseLoose(outRel),
    life = parseLoose(outLife);
  const banned = [...cfg.blocked.compliance, ...cfg.blocked.no_label];
  const src = {}, section_state = {};
  const pe = st.profile_evidence_runtime;
  const peOn = cfg.profile_evidence?.enabled && pe?.status === 'ok';
  const facts = activeFacts(st).filter(f => String(f.value || '').trim() &&
    !/^(?:没有|暂无|无|没了|不确定|都行|都没感觉)$/.test(String(f.value).trim()));
  // A raw Q12 answer is profile-only evidence; the writer must allocate it by
  // actual meaning. It never creates three facts or matching conditions here.
  const hasSupplement = !!profileSupplement(st);
  const evidence = {
    expect_ta: facts.some(f => f.field === 'NEED' && f.subject === 'TA' ||
      ['Q4','Q8','Q11'].includes(f.field) && ['TA','关系'].includes(f.subject) ||
      f.field === 'CARD' && f.sub === 'l2'),
    daily: facts.some(f => ['Q1','Q2','Q3','Q5','Q6','Q7','SELF'].includes(f.field) && f.subject === '自己'),
    love_style: facts.some(f => ['Q4','Q8','Q9','Q10','Q11'].includes(f.field) && ['自己','关系'].includes(f.subject)),
  };
  const empty = (key, reason) => { src[key] = reason; section_state[key] = reason; return ''; };
  const pick = (key, value, mx) => {
    if (peOn ? pe.levels[key] === 'insufficient' : !evidence[key] && !hasSupplement)
      return empty(key, 'no_evidence');
    if (typeof value !== 'string') return empty(key, 'generation_error');
    const text = value.trim().replace(/\s*[\r\n]+\s*/g, ' ');
    if (!text) return empty(key, 'no_evidence');
    if (text.length > mx || banned.some(w => text.includes(w))) return empty(key, 'generation_error');
    src[key] = 'model'; section_state[key] = 'generated';
    return text;
  };
  const expect = pick('expect_ta', rel.expect_ta, 90),
    daily = pick('daily', life.daily, 110),
    love = pick('love_style', rel.love_style, 100);
  const tags = withFallbackTags(cfg, st, (st.tags || {})["100"] || []);
  const tagLine = tags.length ? tags.map((t) => "#" + t.text).join("  ") : "";
  const care = careLine(cfg, st);
  const emptyMessage = Object.values(section_state).every(value => value === 'no_evidence')
    ? String(cfg.profile_empty_message || '').trim() : '';
  const lines = [
    ...(care ? [care, ""] : []),
    "【我的画像】",
    "",
  ];
  if (emptyMessage) lines.push(emptyMessage, '');
  for (const [title,text] of [['我对 TA 的期待',expect],['兴趣日常',daily],['我的相处方式',love]])
    if (text) lines.push(title, text, '');
  if (tagLine) lines.push(tagLine, '');
  lines.push(`「${cfg.buttons.p100[0]}」　「${cfg.buttons.p100[1]}」`);
  st.stage = "PROFILE_READY";
  const fb = Object.entries(src)
    .filter(([k, v]) => v !== "model")
    .map(([k]) => k);
  st.profile = {
    expect_ta: expect,
    daily,
    love_style: love,
    tags,
    source: src,
    section_state,
    empty_message: emptyMessage,
    fallback_group: "",
    content_status: fb.length === 3 ? (Object.values(section_state).includes('generation_error') ? 'generation_error' : 'no_evidence') : fb.length ? "partial" : "ok",
  };
  return { reply: lines.join("\n"), new_state: S(st), fallback_sections: fb };
}

/* ---------- N36 召回 + 硬筛 + 排序 + 出卡 ---------- */
// A ready event is created only after portrait and required story generation succeed.
// Generation retries and delivery retries are deliberately separate operations.
async function completeProfileWriteback(cfg, input, registration, compose) {
  const st=JSON.parse(JSON.stringify(input));
  if(!cfg.profile_writeback?.enabled)return st;
  if(st.profile_writeback?.status==='complete' && st.profile_writeback.facts_revision===st.facts_revision)return st;
  st.profile_writeback={required:true,status:'pending',version:'1.4',facts_revision:st.facts_revision||0};
  const diagnostics=[];
  const fail=reason=>{
    st.stage='PROFILE_FAILED';
    st.profile_writeback={...st.profile_writeback,status:'failed',reason,diagnostics};
    return st;
  };
  const profile=st.profile || {}, keys=['expect_ta','daily','love_style'];
  if(st.profile_generation?.pending_nodes?.length || keys.some(k=>profile.section_state?.[k]==='generation_error'))return fail('portrait_generation_failed');
  if(!keys.some(k=>typeof profile[k]==='string'&&profile[k].trim()&&
    (!profile.section_state?.[k]||profile.section_state[k]==='generated')))return fail('no_evidence');
  st.profile_field_updates={};st.profile_content={};
  delete st.interest_ids_for_replace;
  delete st.interest_ids_for_merge;
  st.write_modes={profile_field_updates:'patch',profile_content:'write_present_only'};
  try{
    const bundle=cfg.profile_mapping || {};
    const mapped=ProfileFieldMapper.mapProfile({facts:st.facts,notes:st.notes,q5_answers:st.q5_answers,
      registration:registration || {},config:bundle.config,taxonomy:bundle.taxonomy,interestAliases:bundle.interestAliases});
    st.profile_field_updates=mapped.updates;
    st.profile_mapping_diagnostics={skipped:mapped.skipped,interest_status:mapped.interest.status,
      interest_unmapped:mapped.interest.unmapped || []};
    if(mapped.interest.status==='mapped'){
      st.interest_ids_for_merge=mapped.interest.ids;st.write_modes.interest_ids='merge';
    }else diagnostics.push('interest_mapping_failed');
  }catch(_){diagnostics.push('profile_mapping_failed');}
  const ideal=ProfileContentComposer.expectTaForWriteback(st);
  if(ideal.trim())st.profile_content.ideal_partner_description=ideal;
  const contentInput=ProfileContentComposer.prepareContentInput(st);
  const supplement=profileSupplement(st);
  if(supplement)contentInput.supporting_facts.push({field:'Q12',sub:'supplement',subject:'未分类',value:supplement,evidence:supplement});
  contentInput.qa_candidates=contentInput.qa_candidates.filter(q=>![q.question,q.raw_answer].some(t=>
    PII.test(t)||cfg.blocked.compliance.some(w=>t.includes(w))));
  if(ProfileContentComposer.shouldCompose(contentInput)){
    let raw='';
    try{raw=await compose(contentInput);}catch(_){diagnostics.push('composer_failed');}
    const validated=ProfileContentComposer.parseAndValidate(raw,contentInput,{
      maxStoryChars:cfg.profile_writeback.composer_max_chars,
      isAllowed:t=>!PII.test(t)&&![...cfg.blocked.compliance,...cfg.blocked.no_label].some(w=>t.includes(w)),
    });
    diagnostics.push(...validated.diagnostics);
    if(validated.diagnostics.some(d=>d!=='unexpected_keys_ignored') || diagnostics.includes('composer_failed') ||
      ((contentInput.daily.trim()||contentInput.love_style.trim()) && !validated.story_text))return fail('composer_generation_failed');
    if(validated.story_text)st.profile_content.story_text=validated.story_text;
    const topic=ProfileContentComposer.resolveSelectedTopic(st.topic_candidates,validated.selected_turn_id);
    if(topic)st.profile_content.topic=topic;
  }
  st.profile_writeback={...st.profile_writeback,status:'complete',diagnostics};
  st.stage='PROFILE_READY';
  return st;
}
const EDU = { 本科: 1, 硕士: 2, 博士: 3 };
const loadLibrary = (cfg) => cfg.pool; // 口子 1：真实环境查库（候选人 + 预先跑好的标签）
const tagObj = (cfg, tid) => {
  const t = cfg.tag_lib[tid];
  return { id: tid, text: t.text, cat: t.cat, kw: t.kw || [] };
};
function displayTags(c, cfg) {
  const d = cfg.display;
  const tags = c.tags.filter((t) => cfg.tag_lib[t]).map((t) => tagObj(cfg, t));
  // 先按默认配额（教育1 + 基础1 + 兴趣2 + 社交1）取；不足 4 条时再放宽到最大配额补齐
  const take = (quota) => {
    const out = [],
      used = {};
    for (const cat of d.cat_order)
      for (const t of tags)
        if (t.cat === cat && (used[cat] || 0) < (quota[cat] ?? 0)) {
          out.push(t);
          used[cat] = (used[cat] || 0) + 1;
        }
    return out;
  };
  let ordered = take(d.cat_quota);
  if (ordered.length < d.min_tags && d.cat_quota_max) {
    const more = take(d.cat_quota_max).filter((t) => !ordered.includes(t));
    for (const t of more) {
      if (ordered.length >= d.min_tags) break;
      ordered.push(t);
    }
    ordered = d.cat_order.flatMap((cat) =>
      ordered.filter((t) => t.cat === cat),
    );
  }
  const rows = [],
    picked = [];
  for (const t of ordered) {
    if (picked.length >= d.max_tags) break;
    if (
      rows.length &&
      rows[rows.length - 1].reduce((a, x) => a + x.length, 0) + t.text.length <=
        d.row_chars
    ) {
      rows[rows.length - 1].push(t.text);
      picked.push(t);
    } else if (rows.length < d.max_rows && t.text.length <= d.row_chars) {
      rows.push([t.text]);
      picked.push(t);
    }
  }
  return [picked, rows];
}
function baseOk(c, me, gap, same) {
  if (c.gender !== me.seek || Math.abs(c.age - me.age) > gap) return false;
  return same === "city" ? c.city === me.city : c.province === me.province;
}
function ageRange(t, me) {
  t = String(t);
  let m = t.match(/(\d{2})\s*[-到至~～]\s*(\d{2})/);
  if (m) return [+m[1], +m[2]];
  m = t.match(/(\d{2})\s*(岁)?\s*(以上|往上|及以上)/);
  if (m) return [+m[1], 200];
  m = t.match(/(\d{2})\s*(岁)?\s*(以下|以内|往下)/);
  if (m) return [0, +m[1]];
  if (t.includes("比我大")) return [me + 1, 200];
  if (t.includes("比我小")) return [0, me - 1];
  if (t.includes("同龄") || t.includes("差不多大")) return [me - 1, me + 1];
  return null;
}
function hardCheck(c, f, me) {
  const sub = f.sub,
    v = f.value;
  if (sub === "smoke")
    return v === "不吸烟"
      ? [true, c.smoke === "不吸", "吸烟"]
      : [false, true, ""];
  if (sub === "drink") {
    if (v === "不喝酒") return [true, c.drink === "不喝", "喝酒"];
    if (v === "少喝")
      return [true, ["不喝", "偶尔"].includes(c.drink), "经常喝酒"];
    return [false, true, ""];
  }
  if (sub === "city")
    return v === "同城"
      ? [true, c.city === me.city, "不同城"]
      : [false, true, ""];
  if (sub === "edu") {
    const need = { 本科及以上: 1, 硕士及以上: 2 }[v];
    return need
      ? [true, (EDU[c.edu] || 0) >= need, "学历不符"]
      : [false, true, ""];
  }
  if (sub === "pet")
    return v === "不养宠物"
      ? [true, c.pet === "没有养", "养宠物"]
      : [false, true, ""];
  if (sub === "age") {
    const r = ageRange(v, me.age);
    return r
      ? [true, r[0] <= c.age && c.age <= r[1], "年龄不符"]
      : [false, true, ""];
  }
  if (sub === "height") {
    const m = String(v).match(/(1\d{2})/);
    return m ? [true, c.height >= +m[1], "身高不符"] : [false, true, ""];
  }
  return [false, true, ""];
}
function softHit(c, f, cfg, me) {
  const sub = f.sub,
    v = String(f.value);
  if (["traits", "interests", "other"].includes(sub)) {
    const words = v.split(/[、，,;；/\s]+/).filter(Boolean);
    const tags = c.tags
      .filter((t) => cfg.tag_lib[t])
      .map((t) => tagObj(cfg, t));
    return words.some((w) =>
      tags.some(
        (t) =>
          w.includes(t.text) ||
          t.text.includes(w) ||
          t.kw.includes(w) ||
          t.kw.some((k) => w.includes(k)),
      ),
    );
  }
  if (sub === "pet" && v === "喜欢宠物") return c.pet === "正在养";
  const [can, passed] = hardCheck(c, f, me);
  return can && passed;
}
// 差异点：按标签类目逐类比较——每一类里“对方没有的标签数”（两边取大），各类相加
function tdiff(a, b) {
  const cats = [...new Set([...a, ...b].map((t) => t.cat))];
  return cats.reduce((s, c) => {
    const A = a.filter((t) => t.cat === c).map((t) => t.id),
      B = b.filter((t) => t.cat === c).map((t) => t.id);
    return (
      s +
      Math.max(
        A.filter((x) => !B.includes(x)).length,
        B.filter((x) => !A.includes(x)).length,
      )
    );
  }, 0);
}
function* combos(n, k, start = 0, acc = []) {
  if (acc.length === k) {
    yield acc.slice();
    return;
  }
  for (let i = start; i < n; i++) {
    acc.push(i);
    yield* combos(n, k, i + 1, acc);
    acc.pop();
  }
}
function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    if (Array.isArray(x)) {
      for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return x[j] - y[j];
      continue;
    }
    if (x !== y) return x - y;
  }
  return 0;
}
function N36(cfg, stateStr) {
  const st = JSON.parse(stateStr);
  const me = cfg.user_profile,
    rc = cfg.recall;
  const needTags = new Set(st.need_tags || []);
  const needs = st.facts.filter(
    (f) => f.active && f.status === "已确认" && f.field === "NEED",
  );
  const mode = needs.length || needTags.size ? "need" : "home";
  const lib = loadLibrary(cfg);
  const hard = [],
    soft = [],
    down = [];
  needs.forEach((f) => {
    if (f.strength === "硬性")
      (hardCheck(lib[0], f, me)[0] ? hard : down).push(f);
    else soft.push(f);
  });
  soft.push(...down);
  const disp = {};
  lib.forEach((c) => (disp[c.id] = displayTags(c, cfg)));
  const levels = [
    { name: "固定规则", age_gap: rc.age_gap, same: rc.same },
    ...rc.expand_steps,
  ];
  let eligible = [],
    usedLevels = [],
    dropped = [];
  for (let li = 0; li < levels.length; li++) {
    const lv = levels[li];
    usedLevels = levels.slice(1, li + 1);
    eligible = [];
    dropped = [];
    for (const c of lib) {
      if (!baseOk(c, me, lv.age_gap, lv.same)) continue;
      if (disp[c.id][0].length < rc.min_tags) {
        dropped.push({ name: c.name, reasons: ["可展示标签不足 4 个"] });
        continue;
      }
      const bad = hard
        .filter((f) => !hardCheck(c, f, me)[1])
        .map((f) => hardCheck(c, f, me)[2]);
      if (bad.length) {
        dropped.push({ name: c.name, reasons: bad });
        continue;
      }
      eligible.push(c);
    }
    if (eligible.length >= rc.recommend_count) break;
  }
  const scored = eligible.map((c, i) => {
    const hits = [
      ...soft
        .filter((f) => softHit(c, f, cfg, me))
        .map((f) => `${f.sub}=${f.value}`),
      ...c.tags
        .filter((t) => needTags.has(t))
        .map((t) => "标签:" + cfg.tag_lib[t].text),
    ];
    return { c, hits, score: hits.length, ntags: c.tags.length, i };
  });
  const ranked = [...scored].sort(
    (a, b) => b.score - a.score || b.ntags - a.ntags || a.i - b.i,
  );
  const dvc = cfg.diversity,
    texts = (x) => disp[x.c.id][0],
    okp = (a, b) => {
      const d = tdiff(texts(a), texts(b));
      return dvc.min <= d && d <= dvc.max;
    };
  const cand = ranked.slice(0, 10),
    n = Math.min(rc.recommend_count, cand.length);
  let top = null;
  for (const cb of combos(cand.length, n)) {
    let good = true;
    for (let i = 0; i < cb.length && good; i++)
      for (let j = i + 1; j < cb.length; j++)
        if (!okp(cand[cb[i]], cand[cb[j]])) {
          good = false;
          break;
        }
    if (good) {
      top = cb.map((i) => cand[i]);
      break;
    }
  }
  const filled = !top;
  if (!top) top = ranked.slice(0, n);
  const pairs = [];
  for (let i = 0; i < top.length; i++)
    for (let j = i + 1; j < top.length; j++)
      pairs.push(tdiff(texts(top[i]), texts(top[j])));
  const cards = top.map((x, idx) => {
    const c = x.c,
      [tags, rows] = disp[c.id];
    const items =
      mode === "need"
        ? [...hard.map((f) => `${f.sub}=${f.value}（硬性）`), ...x.hits]
        : [];
    return {
      key: "ABC"[idx],
      id: c.id,
      name: c.name,
      age: c.age,
      city: c.city,
      school: c.school,
      tags: tags.map((t) => t.text),
      tag_ids: tags.map((t) => t.id),
      rows,
      score: x.score,
      source: mode,
      filter_hit: { count: items.length, items },
    };
  });
  st.cards = cards;
  st.card_set_id = `${st.session_id||'session'}:cards:${st.turn}:${cards.map(c=>c.id).join('-')}`;
  st.rec = {
    mode,
    hard: hard.map((f) => `${f.sub}=${f.value}`),
    soft: soft.map((f) => `${f.sub}=${f.value}`),
    downgraded: down.map((f) => `${f.sub}=${f.value}`),
    expanded: usedLevels.map((l) => l.name),
    dropped,
    ranked: ranked.map((x) => ({
      name: x.c.name,
      score: x.score,
      ntags: x.ntags,
    })),
    pair_diffs: pairs,
    diversity_ok: !filled && pairs.every((d) => dvc.min <= d && d <= dvc.max),
  };
  const T = cfg.rec_text;
  const cnt = cards.length;
  let body;
  if (cnt === 0) {
    ["CARD_L1", "CARD_F1", "CARD_F2"].forEach((t) => {
      st.tasks[t].a = 1;
      st.tasks[t].done = 1;
    });
    const q = cfg.tasks.LIFE.script || cfg.tasks.LIFE.fallback;
    st.current = {
      task: "LIFE",
      qtype: "MAIN",
      text: q,
      qid: "q" + (st.history.length + 1),
    };
    st.history.push({ task: "LIFE", qtype: "MAIN", text: q });
    body = [mode === "need" && hard.length ? T.none_found : T.none_home, "", q];
  } else {
    const word = { 2: "两个人", 3: "三个人" }[cnt];
    const q =
      cnt > 1 ? T.card_question.replace("{word}", word) : T.card_question_one;
    const gender = me.seek === "女" ? "女生" : "男生";
    st.current = {
      task: "CARD_L1",
      qtype: "MAIN",
      text: q,
      qid: "q" + (st.history.length + 1),
    };
    st.history.push({ task: "CARD_L1", qtype: "MAIN", text: q });
    body = [];
    body.push(
      (cnt === 1
        ? mode === "need"
          ? T.need_lead_one
          : T.home_lead_one
        : mode === "need"
          ? T.need_lead
          : T.home_lead
      )
        .replace("{n}", cnt)
        .replace("{gender}", gender),
      "",
      "【Demo 模拟人物，仅用于测试】",
    );
    cards.forEach((c) => {
      const hit =
        mode === "need" && c.filter_hit.count
          ? `　满足 ${c.filter_hit.count} 个筛选条件`
          : "";
      body.push(`${c.name} · ${c.age} · ${c.city} · ${c.school}${hit}`);
      c.rows.forEach((r) =>
        body.push("    " + r.map((x) => "#" + x).join("  ")),
      );
    });
    body.push("", q);
  }
  st.progress = progressOf(cfg, st);
  st._new = [];
  const ack = buildTurnReply(cfg, st).text;
  if (cnt === 0) body = [ack + replyParagraph(body.join(""))];
  else if (ack) body[0] = ack + body[0];
  return {
    reply: body.join("\n") + `\n\n— 画像进度 ${Math.floor(st.progress + 0.5)}%`,
    new_state: S(st),
    mode,
  };
}

const p1Vars = (r2) => ({
  user_input: r2.user_text,
  stage: r2.stage,
  budget_left: r2.budget_left,
  cur_q: r2.cur_q,
  cur_task: r2.cur_task,
  next_hint: r2.next_hint,
  cur_task_slim: r2.cur_task_slim,
  next_hint_slim: r2.next_hint_slim,
  stage_rules: r2.stage_rules,
  cards_text: r2.cards_text,
  field_dict: r2.field_dict,
  facts_text: r2.facts_text,
  recent_dialog: r2.recent_dialog,
  tag_catalog: r2.tag_catalog,
});
const renderUserPrompt = (prompts, pid, vars) =>
  prompts[pid].user.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? "");
const renderSys = (prompts, pid, vars) =>
  prompts[pid].sys.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? "");
/* ---------- 编排：按 Coze 连线执行一轮 ---------- */
async function executeTurn(ctx, ui) {
  const { cfg, prompts, llm, trace } = ctx;
  const T0 = performance.now();
  const step = (id, name, type, input, output, ms, note) =>
    trace.push({
      id,
      name,
      type,
      input,
      output,
      ms: Math.round(ms || 0),
      note,
    });
  const code = (id, name, fn, input) => {
    const t = performance.now();
    const out = fn();
    step(id, name, "code", input, out, performance.now() - t);
    return out;
  };
  const sel = (id, name, res) =>
    step(id, name, "if", null, { 结果: res }, 0, res);
  const agg = (id, name, obj) => step(id, name, "agg", null, obj, 0);
  const TIER = {
    P1B: "fast",
    PE: "fast",
    PC: "fast",
    P3: "fast",
    P5: "strong",
    P6: "deep_low",
    P7: "strong",
  };
  const P1ID = "P1B";
  const model = async (id, name, pid, vars, redactTrace = ['PE','PC'].includes(pid)) => {
    const t = performance.now();
    const sys = renderSys(prompts, pid, vars);
    const user = prompts[pid].user.replace(
      /\{\{(\w+)\}\}/g,
      (m, k) => vars[k] ?? "",
    );
    const limit = (cfg.timeouts || {})[pid];
    let out,
      err = null,
      timedOut = false;
    try {
      if (pid === 'PE' || pid === 'PC') {
        const ac = new AbortController(); let timer;
        try {
          out = await Promise.race([llm(id,pid,sys,user,TIER[pid],ac.signal), new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;ac.abort();reject(new Error('timeout'));},limit || 4000);})]);
        } finally {clearTimeout(timer);}
      } else if (ctx.enforceTimeout && limit) {
        const ac = new AbortController();
        const timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, limit);
        try {
          out = await llm(id, pid, sys, user, TIER[pid], ac.signal);
        } finally {
          clearTimeout(timer);
        }
      } else out = await llm(id, pid, sys, user, TIER[pid]);
    } catch (e) {
      err = timedOut ? { code: "timeout" } : e;
      out = "";
    }
    const ms = performance.now() - t;
    const over = limit && ms > limit;
    step(
      id,
      name,
      "model",
      {
        prompt: pid,
        档位: TIER[pid],
        生产超时: limit ? limit + "ms" : "—",
        变量: redactTrace ? {redacted:true} : vars,
        用户提示词: redactTrace ? "[redacted]" : user,
      },
      redactTrace ? {status:err ? "failed" : "returned",redacted:true} : err ? { error: err.code || String(err.message || err) } : { output: out },
      ms,
      err
        ? err.code === "timeout"
          ? "超时（按生产超时中止）"
          : "调用失败"
        : over
          ? `超过生产超时 ${limit}ms`
          : "",
    );
    return out;
  };
  step("N01", "开始", "start", null, { USER_INPUT: ui });
  const r2 = code("N02", "装载与入口路由", () => N02(cfg, ctx.stateJson, ui), {
    state_json: "(用户变量)",
    user_input: ui,
  });
  const entryState = JSON.parse(r2.state);
  if (!ctx.stateJson || !parseLoose(ctx.stateJson).session_id) entryState.session_id = ctx.sessionId;
  entryState.session_id ||= newSessionId();
  entryState.turn_id = ctx.turnId;
  r2.state = S(entryState);
  sel("N03", "入口分支", r2.branch === "STATIC" ? "其他" : r2.branch);
  if (r2.branch === "PREFILTER")
    trace[trace.length - 1].note =
      "PREFILTER（" + JSON.parse(r2.forced_und).prefilter + "）";
  let reply, newState;
  const events = [];
  const finish = (id, r, s) => {
    agg("N33", "本轮输出", { 来源: id });
    reply = r;
    newState = s;
  };
  const prepareStageReply = (stateStr) => {
    const st = JSON.parse(stateStr),
      selected = buildTurnReply(cfg, st);
    if (selected.text) {
      step("N23a", "输出：本轮承接", "out", null, { text: selected.text });
      ctx.onBubble?.(selected.text);
    }
    st._new = [];
    return { state: S(st), reply: selected.text };
  };
  const profile = async (stateStr, direct) => {
    step("N26", "输出：阶段消息", "out", null, { text: cfg.profile_bubble });
    ctx.onBubble && ctx.onBubble(cfg.profile_bubble);
    agg("N28", "画像输入", { 来源: direct ? "N02" : "N11" });
    // Retry only failed generation nodes at the same input, retaining successful prose.
    const cleanState = JSON.parse(stateStr); delete cleanState.profile_evidence_runtime;
    const r29 = code("N29", "整理画像输入", () => N29(cfg, S(cleanState)), {});
    const fingerprint=S([r29.rel_facts,r29.life_facts,r29.p60_insight,profileSupplement(cleanState)]);
    const previous=cleanState.profile_generation;
    const cached=previous?.fingerprint===fingerprint && previous.facts_revision===cleanState.facts_revision ? previous : null;
    let vars = r29, stateForN32 = r29.state, evidenceOK = false;
    if(cached){
      vars={...r29,...cached.vars};evidenceOK=cached.evidence_ok;
      const restored=JSON.parse(r29.state);
      if(cached.evidence_runtime)restored.profile_evidence_runtime=cached.evidence_runtime;
      stateForN32=S(restored);
    }else if (cfg.profile_evidence?.enabled) {
      try {
        if (!['expect_ta','love_style','daily'].every(k => typeof cfg.profile_evidence.empty_copy?.[k] === 'string' && cfg.profile_evidence.empty_copy[k].trim())) throw new Error('missing_fixed_copy');
        const input = ProfileEvidence.buildMapperInput(r29.state, {includeQ12Raw:cfg.profile_evidence.include_q12_raw !== false,q12MaxChars:320});
        const raw = await model('N29PE','画像证据整理','PE',{evidence_input:JSON.stringify(input)});
        const mapped = ProfileEvidence.validateMapper(input,raw);
        const levels = ProfileEvidence.classifyEvidence(mapped);
        vars = {...r29,...ProfileEvidence.makeProfileInputs(r29.state,mapped,levels,{p60_insight:r29.p60_insight})};
        const state = JSON.parse(r29.state);
        state.profile_evidence_runtime = {status:'ok',levels:vars.evidence_levels};
        stateForN32 = S(state); evidenceOK = true;
        step('N29G','证据校验','code',null,{status:'ok',levels:vars.evidence_levels},0);
      } catch (_) {
        vars = r29; stateForN32 = r29.state;
        step('N29G','证据校验','code',null,{status:'fallback'},0);
      }
    }
    const [o30, o31] = await Promise.all([
      cached?.outputs?.P6 ?? model("N30", "② 关系画像·100%（期待 / 相处）", "P6", {
        rel_facts: vars.rel_facts,
        life_facts: vars.life_facts,
        p60_insight: vars.p60_insight,
      }, evidenceOK),
      cached?.outputs?.P7 ?? model("N31", "③ 生活画像·100%（兴趣日常）", "P7", {
        life_facts: evidenceOK ? vars.p7_life_facts : r29.life_facts,
      }, evidenceOK),
    ]);
    const r32 = code(
      "N32",
      "组装 100% 画像",
      () => N32(cfg, stateForN32, o30, o31),
      { out_rel: o30, out_life: o31 },
    );
    const assembled=JSON.parse(r32.new_state);
    const validOutput=(raw,keys)=>{
      let obj;try{obj=JSON.parse(raw);}catch(_){return false;}
      return obj&&typeof obj==='object'&&!Array.isArray(obj)&&keys.every(k=>typeof obj[k]==='string'&&assembled.profile.section_state[k]!=='generation_error');
    };
    const outputs={};
    if(validOutput(o30,['expect_ta','love_style']))outputs.P6=o30;
    if(validOutput(o31,['daily']))outputs.P7=o31;
    assembled.profile_generation={fingerprint,facts_revision:assembled.facts_revision,
      vars:{rel_facts:vars.rel_facts,life_facts:vars.life_facts,p60_insight:vars.p60_insight,p7_life_facts:vars.p7_life_facts},
      evidence_ok:evidenceOK,evidence_runtime:assembled.profile_evidence_runtime,
      outputs,pending_nodes:['P6','P7'].filter(pid=>!(pid in outputs))};
    const completed=await completeProfileWriteback(cfg,assembled,ctx.registrationProfile,
      input=>model('N32PC','最终资料：故事压缩与话题选择','PC',{content_input:S(input)}));
    if(completed.stage==='PROFILE_FAILED'){
      const message=completed.profile_writeback.reason==='no_evidence'
        ? '现在的信息还不足以生成画像，可以再补充一点你的想法。'
        : '画像还没有生成完成，已保留你的回答，可以点击重试。';
      finish('N32RETRY',message,S(completed));return;
    }
    delete completed.profile_generation;
    const ready = BusinessEvents.prepareProfileReady(completed);
    if (ready.event) events.push(ready.event);
    r32.new_state = S(ready.state);
    finish("N32", r32.reply, r32.new_state);
  };
  if (r2.branch === "STATIC") {
    finish("N02", r2.reply_static, r2.state);
  } else if (r2.branch === "COLLECT") {
    await profile(r2.state, false);
  } else if (r2.branch === "PROFILE") {
    await profile(r2.state, true);
  } else {
    let st,
      qspec,
      cand = "",
      handled = false;
    if (r2.branch === "ANSWER" || r2.branch === "PREFILTER") {
      let und;
      if (r2.branch === "PREFILTER") {
        und = r2.forced_und;
        agg("N37", "理解结果", { 来源: "N02 前置拦截（未调用模型）" });
      } else {
        const vars = p1Vars(r2);
        const o4 = await model(
          "N04",
          "⑤ 回答理解（主模型）" + (P1ID === "P1B" ? "· B 版" : ""),
          P1ID,
          vars,
        );
        const r38 = code("N38", "主模型输出检查", () => N38(o4), {});
        sel("N39", "主模型可用？", r38.ok ? "是" : "否：" + r38.reason);
        if (r38.ok) {
          und = o4;
          agg("N37", "理解结果", { 来源: "N04" });
        } else {
          und = await model("N04B", "⑤ 回答理解（备用模型）", P1ID, vars);
          if (!N38(und).ok) und = '{}';
          agg("N37", "理解结果", { 来源: "N04B" });
        }
      }
      const r5 = code("N05", "解析理解结果", () => N05(und), {});
      const r9 = code(
        "N09",
        "校验 & 写入事实",
        () => N09(cfg, r2.state, ui, und),
        {},
      );
      const r10 = code("N10", "标签映射", () => N10(cfg, r9.state), {});
      if (JSON.parse(r9.state)._und.parse_ok) {
        const committed = BusinessEvents.prepareFactsUpdated(JSON.parse(r2.state), JSON.parse(r10.state), {taskId:JSON.parse(r2.state).current?.task});
        r10.state = S(committed.state);
        if (committed.event) events.push(committed.event);
      }
      const r11 = code(
        "N11",
        "任务路由与进度",
        () => N11(cfg, r10.state, ui, r2.next_hint),
        { next_hint: r2.next_hint },
      );
      sel("N12", "下一步", r11.route);
      if (r11.route === "CARDS") {
        const r36 = code(
          "N36",
          "召回 + 硬筛 + 排序 + 出卡",
          () => N36(cfg, r11.state),
          {},
        );
        finish("N36", r36.reply, r36.new_state);
        handled = true;
      } else if (r11.route === "SHOW_60") {
        const prepared = prepareStageReply(r11.state);
        step("N24a", "输出：60% 阶段消息", "out", null, {
          text: cfg.p60_bubble,
        });
        ctx.onBubble?.(cfg.p60_bubble);
        const o = await model("N24", "② 60% 核心洞察", "P5", {
          rel_facts: r11.rel_facts_text,
          life_facts: r11.life_facts_text,
        });
        const r25 = code(
          "N25",
          "组装 60% 阶段卡",
          () => N25(cfg, prepared.state, o),
          { llm_out: o },
        );
        const stagedReply =
          !ctx.onBubble && prepared.reply
            ? prepared.reply + "\n\n" + r25.reply
            : r25.reply;
        finish("N25", stagedReply, r25.new_state);
        handled = true;
      } else if (r11.route === "GENERATE_PROFILE") {
        const prepared = prepareStageReply(r11.state);
        await profile(prepared.state, false);
        if (!ctx.onBubble && prepared.reply)
          reply = prepared.reply + "\n\n" + reply;
        handled = true;
      }
      st = r11.state;
      qspec = r11.q_task_spec;
      cand = r11.candidate_q;
    } else {
      st = r2.state;
      qspec = "";
      cand = r2.cont_q;
    }
    if (!handled) {
      let q = cand;
      if (qspec) {
        agg("N13", "问法输入", {
          来源: r2.branch !== "CONTINUE_40" ? "N11" : "N02",
        });
        const o14 = await model(
          "N14",
          "⑤ 重问引子（主模型）",
          "P3",
          JSON.parse(qspec),
        );
        const c1 = code(
          "N15",
          "问法合规校验①",
          () => N15(cfg, o14, qspec, false),
          { llm_out: o14 },
        );
        sel("N16", "合规？", c1.pass ? "是" : "否：" + c1.reason);
        if (c1.pass) q = c1.q_text;
        else {
          const o17 = await model(
            "N17",
            "⑤ 重问引子（备用模型）",
            "P3",
            JSON.parse(qspec),
          );
          const c2 = code(
            "N18",
            "问法合规校验②（兜底）",
            () => N15(cfg, o17, qspec, true),
            { llm_out: o17 },
          );
          q = c2.q_text;
        }
      }
      agg("N19", "最终问句", {
        q_text: q,
        来源: qspec ? "问法生成" : "N11 追问/复用草稿",
      });
      const r23 = code(
        "N23",
        "组装回复 & 提交（含承接）",
        () => N23(cfg, st, q),
        { q_text: q },
      );
      finish("N23", r23.reply, r23.new_state);
    }
  }
  step("N34", "变量赋值", "assign", null, { state_json: "← N33.new_state" });
  step("N35", "结束", "end", null, { reply });
  ctx.ms = Math.round(performance.now() - T0);
  return { reply, newState, events };
}

// A request id identifies one submitted turn, never merely the user's words.
// Persist a bounded receipt so a refresh/retry cannot settle the same answer twice.
function newSessionId() {
  return typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() :
    `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
const turnRequests = new Map();
const contextSessions = new WeakMap();
async function runTurn(ctx, ui) {
  const prior = parseLoose(ctx.stateJson);
  const sessionId = prior.session_id || ctx.sessionId || contextSessions.get(ctx) || newSessionId();
  contextSessions.set(ctx, sessionId);
  const turnId = ctx.turnId || newSessionId();
  const key = JSON.stringify([sessionId, turnId]), input = String(ui || '');
  const old = (prior.turn_receipts || []).find(r => r.turn_id === turnId);
  if (old) {
    if (old.input !== input) throw Error('turn_id_input_conflict');
    const last = prior.last_turn_result;
    return {reply:last?.turn_id === turnId ? last.reply : '', newState:ctx.stateJson,
      events:last?.turn_id === turnId ? last.events || [] : [], duplicate:true};
  }
  if (turnRequests.has(key)) {
    const request = turnRequests.get(key);
    if (request.input !== input) throw Error('turn_id_input_conflict');
    const result = await request.promise;
    if ((prior.turn || 0) > (parseLoose(result.newState).turn || 0))
      return {reply:'',newState:ctx.stateJson,events:[],duplicate:true};
    return {...result,duplicate:true};
  }
  const execution = {...ctx, sessionId, turnId, trace:ctx.trace || []};
  const promise = executeTurn(execution, ui).then(result => {
    const state = JSON.parse(result.newState);
    state.turn_receipts = [...(state.turn_receipts || []),{turn_id:turnId,input}].slice(-16);
    state.last_turn_result = {turn_id:turnId,reply:result.reply,events:result.events};
    result.newState = S(state);
    ctx.ms = execution.ms;
    return result;
  });
  turnRequests.set(key, {input,promise});
  try { return await promise; }
  catch (error) { turnRequests.delete(key); throw error; }
  finally { if (turnRequests.size > 128) turnRequests.delete(turnRequests.keys().next().value); }
}
if (typeof window !== 'undefined') window.LoveMiEngine = {...window.LoveMiEngine, BusinessEvents, ProfileFieldMapper, ProfileContentComposer};
