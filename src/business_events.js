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
