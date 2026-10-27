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
