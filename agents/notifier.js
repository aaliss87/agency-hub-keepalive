const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws }
});

const AGENT_NAME = 'notifier';
const STALE_DAYS = 3;
const RESPONSE_RATE_FLOOR = 25;

async function logRunStart() {
  const { data, error } = await sb.from('ah_agent_runs').insert({
    agent_name: AGENT_NAME, status: 'running', trigger_type: 'scheduled'
  }).select().single();
  if (error) throw error;
  return data.id;
}

async function logRunFinish(runId, status, summary, count, err) {
  await sb.from('ah_agent_runs').update({
    status, summary, result_count: count || 0,
    error: err || null, finished_at: new Date().toISOString()
  }).eq('id', runId);
}

async function postChat(message) {
  await sb.from('ah_chat').insert({
    channel: 'agent-status', partner: AGENT_NAME,
    email: 'notifier@agency-hub.bot', message
  });
}

function projectLeads(events) {
  const leads = {};
  events.forEach(ev => {
    const { lead_id, type, payload, created_at } = ev;
    if (!leads[lead_id]) leads[lead_id] = { id: lead_id, stageChanged: created_at };
    const L = leads[lead_id];
    if (type === 'LeadIdentified') {
      Object.assign(L, { name: payload.name, region: payload.region,
        stage: 'prospect', assignee: payload.assignee, createdAt: created_at });
    } else if (type === 'StageChanged') {
      L.stage = payload.stage; L.stageChanged = created_at;
    } else if (type === 'LeadDeleted') {
      L._deleted = true;
    }
  });
  const now = Date.now();
  return Object.values(leads).filter(L => !L._deleted).map(L => ({
    ...L, daysInStage: Math.floor((now - new Date(L.stageChanged).getTime()) / 86400000)
  }));
}

async function getRecentlyNotified() {
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  const { data } = await sb.from('ah_agent_runs')
    .select('summary').eq('agent_name', AGENT_NAME).gte('started_at', since);
  const ids = new Set();
  (data || []).forEach(r => {
    const matches = (r.summary || '').match(/lead:(\S+)/g) || [];
    matches.forEach(m => ids.add(m.replace('lead:', '')));
  });
  return ids;
}

async function run() {
  const runId = await logRunStart();
  let notified = 0;
  const tags = [];

  try {
    const { data: events } = await sb.from('ah_events').select('*').order('created_at', { ascending: true });
    const leads = projectLeads(events || []);
    const alreadyNotified = await getRecentlyNotified();

    // 1. Stale leads
    const stale = leads.filter(l => l.stage !== 'closed' && l.daysInStage >= STALE_DAYS && !alreadyNotified.has(l.id));
    for (const l of stale) {
      await postChat(`@${l.assignee || 'P3'} — "${l.name}" has been in ${l.stage} for ${l.daysInStage} days. Worth a follow-up or moving forward.`);
      notified++; tags.push(`lead:${l.id}`);
    }

    // 2. New leads added in last hour
    const recentNew = leads.filter(l => {
      const ageMin = (Date.now() - new Date(l.createdAt || l.stageChanged).getTime()) / 60000;
      return l.stage === 'prospect' && ageMin < 60 && !alreadyNotified.has(l.id);
    });
    if (recentNew.length > 0) {
      await postChat(`${recentNew.length} new lead${recentNew.length > 1 ? 's' : ''} added to the pipeline in the last hour. Check the Prospect column.`);
      notified++; recentNew.forEach(l => tags.push(`lead:${l.id}`));
    }

    // 3. Low response rates
    const { data: tracker } = await sb.from('ah_tracker').select('*');
    for (const t of (tracker || [])) {
      if (t.sent >= 10 && (t.replied / t.sent * 100) < RESPONSE_RATE_FLOOR) {
        await postChat(`@${t.assignee || 'P2'} — response rate for "${t.niche}" is ${Math.round(t.replied / t.sent * 100)}%, below the ${RESPONSE_RATE_FLOOR}% target. Consider refining the script.`);
        notified++;
      }
    }

    if (notified === 0) {
      await logRunFinish(runId, 'completed', 'Nothing needed attention', 0);
    } else {
      await logRunFinish(runId, 'completed', `Sent ${notified} notifications. ${tags.join(' ')}`, notified);
    }
  } catch (err) {
    await logRunFinish(runId, 'failed', null, 0, err.message);
    await postChat(`[ERROR] Notifier failed: ${err.message}`);
    process.exit(1);
  }
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
