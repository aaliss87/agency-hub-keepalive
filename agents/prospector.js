const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws }
});

const AGENT_NAME = 'prospector';
const MAX_CONSECUTIVE_FAILURES = 3;

const REGIONS = ['North America','Europe','Middle East','Asia-Pacific','South America'];
const NICHE_MAP = {
  'North America': ['Roofers','HVAC contractors','Plumbers','Landscapers'],
  'Europe': ['Solar/HVAC','Boutique gyms','High-end landscaping'],
  'Middle East': ['Aesthetic clinics','Dental practices','Real estate boutiques'],
  'Asia-Pacific': ['B2B logistics','Wholesale','Cafes'],
  'South America': ['E-commerce enablers','Tourism businesses']
};

async function logRunStart(triggerType, triggeredBy) {
  const { data, error } = await sb.from('ah_agent_runs').insert({
    agent_name: AGENT_NAME, status: 'running',
    trigger_type: triggerType, triggered_by: triggeredBy || null
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

async function postChat(message) {
  await sb.from('ah_chat').insert({
    channel: 'agent-status', partner: AGENT_NAME,
    email: 'prospector@agency-hub.bot', message
  });
}

async function getState() {
  const { data } = await sb.from('ah_agent_state').select('*').eq('agent_name', AGENT_NAME).single();
  return data || { consecutive_failures: 0, is_paused: false };
}

async function updateState(failures, paused, reason) {
  await sb.from('ah_agent_state').upsert({
    agent_name: AGENT_NAME, consecutive_failures: failures,
    is_paused: paused, last_run_at: new Date().toISOString(),
    paused_reason: reason || null
  });
}

async function searchBusinesses(region, niche) {
  // Stub — wire in Google Places API key here when ready
  // Return empty array for now which correctly tests the flow
  return [];
}

function scoreLead(business) {
  let score = 0; const reasons = [];
  if (business.rating >= 4.0) { score += 30; reasons.push('4.0+ rating'); }
  if (business.reviewCount < 20) { score += 30; reasons.push('under 20 reviews'); }
  if (!business.hasWebsite) { score += 40; reasons.push('no website'); }
  return { score, reasons };
}

async function run() {
  const triggerType = process.env.TRIGGER_TYPE || 'scheduled';
  const triggeredBy = process.env.TRIGGERED_BY || null;
  const targetRegion = process.env.TARGET_REGION || null;
  const targetNiche = process.env.TARGET_NICHE || null;

  const state = await getState();
  if (state.is_paused) {
    console.log('Prospector is paused:', state.paused_reason);
    return;
  }

  const runId = await logRunStart(triggerType, triggeredBy);
  const region = targetRegion || REGIONS[Math.floor(Math.random() * REGIONS.length)];
  const niches = targetNiche ? [targetNiche] : NICHE_MAP[region];
  const niche = niches[Math.floor(Math.random() * niches.length)];

  await postChat(`Starting search: ${niche} in ${region}...`);

  try {
    const results = await searchBusinesses(region, niche);

    if (results.length === 0) {
      const f = state.consecutive_failures + 1;
      if (f >= MAX_CONSECUTIVE_FAILURES) {
        await updateState(f, true, `No results ${MAX_CONSECUTIVE_FAILURES}x for ${region}/${niche}`);
        await postChat(`[STOPPED] Paused after ${MAX_CONSECUTIVE_FAILURES} empty searches. @P1 @P2 @P3 — search integration needs attention. Note: search API not yet connected — this is expected until Google Places API key is added.`);
      } else {
        await updateState(f, false, null);
        await postChat(`No results for ${niche} in ${region}. (${f}/${MAX_CONSECUTIVE_FAILURES}) — Note: search API stub active until Google Places key is added.`);
      }
      await logRunFinish(runId, 'completed', `No results for ${niche} in ${region}`, 0);
      return;
    }

    await updateState(0, false, null);
    let logged = 0;
    for (const b of results) {
      const { score, reasons } = scoreLead(b);
      if (score < 50) continue;
      const leadId = `lead_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      await sb.from('ah_events').insert({
        lead_id: leadId, type: 'LeadIdentified', partner: AGENT_NAME,
        payload: { name: b.name, region, industry: niche, assignee: 'P2',
          igUrl: b.instagramUrl||'', gmapUrl: b.mapsUrl||'',
          notes: `Auto-prospected. Reasons: ${reasons.join(', ')}. Score: ${score}/100` }
      });
      logged++;
    }
    await logRunFinish(runId, 'completed', `Found ${results.length}, logged ${logged} qualifying leads`, logged);
    await postChat(`Found ${results.length} ${niche} businesses in ${region}, logged ${logged} qualifying leads in the Pipeline.`);
  } catch (err) {
    const f = state.consecutive_failures + 1;
    await updateState(f, f >= MAX_CONSECUTIVE_FAILURES, err.message);
    await logRunFinish(runId, 'failed', null, 0, err.message);
    await postChat(`[ERROR] Search failed: ${err.message}`);
    process.exit(1);
  }
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
