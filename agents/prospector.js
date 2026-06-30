// ═══════════════════════════════════════════════════
// PROSPECTOR AGENT
// Searches for businesses matching the agency's targeting criteria,
// scores them, logs a LeadIdentified event, posts a status update.
// ═══════════════════════════════════════════════════
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const AGENT_NAME = 'prospector';
const MAX_CONSECUTIVE_FAILURES = 3;

// ── Targeting criteria from the blueprint ──
const REGIONS = ['North America', 'Europe', 'Middle East', 'Asia-Pacific', 'South America'];
const NICHE_MAP = {
  'North America': ['Roofers', 'HVAC contractors', 'Plumbers', 'Landscapers'],
  'Europe': ['Solar/HVAC', 'Boutique gyms', 'High-end landscaping'],
  'Middle East': ['Aesthetic clinics', 'Dental practices', 'Real estate boutiques'],
  'Asia-Pacific': ['B2B logistics', 'Wholesale', 'Cafes'],
  'South America': ['E-commerce enablers', 'Digital infoproduct creators', 'Tourism']
};

async function logRunStart(triggerType, triggeredBy) {
  const { data, error } = await sb.from('ah_agent_runs').insert({
    agent_name: AGENT_NAME,
    status: 'running',
    trigger_type: triggerType,
    triggered_by: triggeredBy || null
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
    email: 'prospector@agency-hub.bot', message
  });
}

async function getAgentState() {
  const { data } = await sb.from('ah_agent_state').select('*').eq('agent_name', AGENT_NAME).single();
  return data || { consecutive_failures: 0, is_paused: false };
}

async function updateAgentState(failures, paused, reason) {
  await sb.from('ah_agent_state').upsert({
    agent_name: AGENT_NAME,
    consecutive_failures: failures,
    is_paused: paused,
    last_run_at: new Date().toISOString(),
    paused_reason: reason || null
  });
}

// ── Lead scoring: matches the blueprint's "low-hanging fruit" criteria ──
function scoreLead(business) {
  let score = 0;
  const reasons = [];
  if (business.rating >= 4.0) { score += 30; reasons.push('4.0+ rating'); }
  if (business.reviewCount < 20) { score += 30; reasons.push('under 20 reviews'); }
  if (!business.hasWebsite) { score += 40; reasons.push('no website listed'); }
  else if (business.websiteQuality === 'poor') { score += 25; reasons.push('poor website quality'); }
  return { score, reasons };
}

// ── Placeholder search function ──
// Replace this with real Google Places API / web search calls once API keys are added.
// For now this is a stub that returns an empty array, which correctly triggers
// the 3-strikes pause logic if run repeatedly with no real search wired in.
async function searchBusinesses(region, niche) {
  // TODO: wire in real Google Places API call here
  // const results = await googlePlacesSearch(`${niche} ${region}`);
  return [];
}

async function run(triggerType = 'scheduled', triggeredBy = null, targetRegion = null, targetNiche = null) {
  const state = await getAgentState();
  if (state.is_paused) {
    console.log(`Prospector is paused: ${state.paused_reason}`);
    return;
  }

  const runId = await logRunStart(triggerType, triggeredBy);
  await postChatUpdate(`Starting prospect search${targetRegion ? ' for ' + targetRegion : ''}${targetNiche ? ' (' + targetNiche + ')' : ''}...`);

  try {
    const region = targetRegion || REGIONS[Math.floor(Math.random() * REGIONS.length)];
    const niches = targetNiche ? [targetNiche] : NICHE_MAP[region];
    const niche = niches[Math.floor(Math.random() * niches.length)];

    const results = await searchBusinesses(region, niche);

    if (results.length === 0) {
      const newFailures = state.consecutive_failures + 1;
      if (newFailures >= MAX_CONSECUTIVE_FAILURES) {
        await updateAgentState(newFailures, true, `No results found ${MAX_CONSECUTIVE_FAILURES} times in a row for ${region}/${niche}`);
        await postChatUpdate(
          `[STOPPED] Pausing auto-prospecting after ${MAX_CONSECUTIVE_FAILURES} empty searches in a row (last: ${niche} in ${region}). @P1 @P2 @P3 — search criteria may need adjusting, or the search integration needs attention.`
        );
      } else {
        await updateAgentState(newFailures, false, null);
        await postChatUpdate(`No matching businesses found for ${niche} in ${region}. (${newFailures}/${MAX_CONSECUTIVE_FAILURES} consecutive empty searches)`);
      }
      await logRunFinish(runId, 'completed', `No results for ${niche} in ${region}`, 0);
      return;
    }

    // Reset failure counter on success
    await updateAgentState(0, false, null);

    let loggedCount = 0;
    for (const business of results) {
      const { score, reasons } = scoreLead(business);
      if (score < 50) continue; // skip low-quality matches

      const leadId = `lead_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      await sb.from('ah_events').insert({
        lead_id: leadId,
        type: 'LeadIdentified',
        partner: AGENT_NAME,
        payload: {
          name: business.name,
          region,
          industry: niche,
          assignee: 'P2', // default to outreach lead; humans can reassign
          igUrl: business.instagramUrl || '',
          gmapUrl: business.mapsUrl || '',
          notes: `Auto-prospected. Match reasons: ${reasons.join(', ')}. Score: ${score}/100`
        }
      });
      loggedCount++;
    }

    await logRunFinish(runId, 'completed', `Found ${results.length}, logged ${loggedCount} qualifying leads`, loggedCount);
    await postChatUpdate(
      `Found ${results.length} ${niche} businesses in ${region}, logged ${loggedCount} that match our criteria (4.0+ rating, low reviews, or no website). Check the Pipeline tab — they're in Prospect stage.`
    );
  } catch (err) {
    const newFailures = state.consecutive_failures + 1;
    await updateAgentState(newFailures, newFailures >= MAX_CONSECUTIVE_FAILURES, err.message);
    await logRunFinish(runId, 'failed', null, 0, err.message);
    await postChatUpdate(`[ERROR] Search failed: ${err.message}. @P1 @P2 @P3 please check.`);
  }
}

module.exports = { run };

if (require.main === module) {
  const triggerType = process.env.TRIGGER_TYPE || 'scheduled';
  const triggeredBy = process.env.TRIGGERED_BY || null;
  const targetRegion = process.env.TARGET_REGION || null;
  const targetNiche = process.env.TARGET_NICHE || null;
  run(triggerType, triggeredBy, targetRegion, targetNiche)
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
