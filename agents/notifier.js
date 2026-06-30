// ═══════════════════════════════════════════════════
// NOTIFIER AGENT
// Watches the pipeline for things humans need to act on:
// new leads, stale leads, and low response rates.
// Posts to #agent-status AND tags the right partner.
// Runs on a schedule (checks state each time, not truly realtime
// since this is a scheduled script, not a long-running listener).
// ═══════════════════════════════════════════════════
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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

async function logRunFinish(runId, status, summary, resultCount, errorMsg) {
  await sb.from('ah_agent_runs').update({
    status, summary, result_count: resultCount || 0,
    error: errorMsg || null, finished_at: new Date().toISOString()
  }).eq('id', runId);
}

async function postChatUpdate(message, channel = 'agent-status') {
  await sb.from('ah_chat').insert({
    channel, partner: AGENT_NAME,
    email: 'notifier@agency-hub.bot', message
  });
}

// Reconstruct current lead state from the event log (same projection logic as the app)
async function getLeads() {
  const { data: events, error } = await sb.from('ah_events').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  const leads = {};
  events.forEach(ev => {
    const { lead_id, type, payload, created_at } = ev;
    if (!leads[lead_id]) leads[lead_id] = { id: lead_id, stageChanged: created_at };
    const L = leads[lead_id];
    if (type === 'LeadIdentified') {
      Object.assign(L, { name: payload.name, region: payload.region, stage: 'prospect', assignee: payload.assignee, createdAt: created_at });
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

// Already-notified tracking: avoid spamming the same stale lead every run.
// Uses ah_agent_runs.summary as a lightweight dedup log (checks last 24h of notifier runs).
async function getRecentlyNotifiedLeadIds() {
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
  let notifiedCount = 0;
  const notifiedLeadTags = [];

  try {
    const leads = await getLeads();
    const alreadyNotified = await getRecentlyNotifiedLeadIds();

    // 1. Stale leads (>3 days in non-closed stage)
    const stale = leads.filter(l => l.stage !== 'closed' && l.daysInStage >= STALE_DAYS && !alreadyNotified.has(l.id));
    for (const l of stale) {
      const partnerTag = `@${l.assignee || 'P3'}`;
      await postChatUpdate(
        `${partnerTag} — "${l.name}" has been sitting in ${l.stage} for ${l.daysInStage} days. Might be worth a follow-up or moving it forward.`
      );
      notifiedCount++;
      notifiedLeadTags.push(`lead:${l.id}`);
    }

    // 2. New leads from agents (so humans notice prospector's work even if they miss #agent-status scroll)
    const recentNew = leads.filter(l => {
      const ageMin = (Date.now() - new Date(l.createdAt || l.stageChanged).getTime()) / 60000;
      return l.stage === 'prospect' && ageMin < 60 && !alreadyNotified.has(l.id);
    });
    if (recentNew.length > 0) {
      await postChatUpdate(
        `${recentNew.length} new lead${recentNew.length > 1 ? 's' : ''} added to the pipeline in the last hour. Check the Prospect column when you get a chance.`
      );
      notifiedCount++;
      recentNew.forEach(l => notifiedLeadTags.push(`lead:${l.id}`));
    }

    // 3. Response rate check
    const { data: tracker } = await sb.from('ah_tracker').select('*');
    const lowRate = (tracker || []).filter(t => t.sent >= 10 && (t.replied / t.sent * 100) < RESPONSE_RATE_FLOOR);
    for (const t of lowRate) {
      await postChatUpdate(
        `@${t.assignee || 'P2'} — response rate for "${t.niche}" is at ${Math.round(t.replied / t.sent * 100)}%, below the ${RESPONSE_RATE_FLOOR}% target. The blueprint suggests refining the script for this niche.`
      );
      notifiedCount++;
    }

    if (notifiedCount === 0) {
      await logRunFinish(runId, 'completed', 'Nothing needed attention', 0);
      // Intentionally NOT posting "all clear" every run — would create noise.
      // Silence in #agent-status when there's nothing to report is correct behavior.
    } else {
      await logRunFinish(runId, 'completed', `Sent ${notifiedCount} notifications. ${notifiedLeadTags.join(' ')}`, notifiedCount);
    }
  } catch (err) {
    await logRunFinish(runId, 'failed', null, 0, err.message);
    await postChatUpdate(`[ERROR] Notifier check failed: ${err.message}. @P1 @P2 @P3 please check.`);
  }
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
