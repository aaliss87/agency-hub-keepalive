// ═══════════════════════════════════════════════════
// BUILD AGENT
// Reads briefs with status='ready' from ah_briefs,
// calls Claude API to build the full product,
// deploys to Netlify, updates brief with live URL,
// notifies team via chat.
// ═══════════════════════════════════════════════════
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws }
});

const AGENT_NAME = 'builder';
const BOOKING_LINK = 'https://cal.com/zakia-azoud-sojkvt/free-discovery-call-schovera-studio';
const AGENCY_URL = 'https://schovera.netlify.app';

// ── Logging helpers ──
async function postChat(message, channel = 'agent-status') {
  await sb.from('ah_chat').insert({
    channel, partner: AGENT_NAME,
    email: 'builder@agency-hub.bot', message
  });
}

async function updateBriefLog(id, logLine, status) {
  const { data: brief } = await sb.from('ah_briefs').select('build_log').eq('id', id).single();
  const existing = brief?.build_log || '';
  const newLog = existing + (existing ? '\n' : '') + `[${new Date().toLocaleTimeString()}] ${logLine}`;
  const update = { build_log: newLog };
  if (status) update.status = status;
  await sb.from('ah_briefs').update(update).eq('id', id);
}

// ── Build the full product prompt from the brief ──
function buildPrompt(brief) {
  const buildItems = (brief.build_items || []).join(', ');
  const languages = brief.language || 'Arabic + English';
  const isArabic = languages.toLowerCase().includes('arabic');
  const isBilingual = languages.toLowerCase().includes('+') || languages.toLowerCase().includes('and');

  return `You are a world-class full-stack web developer and designer building a REAL, COMPLETE, PRODUCTION-READY product for a paying client.

CLIENT BRIEF:
- Business: ${brief.client_name}
- Location: ${brief.city || 'Dubai, UAE'}
- Primary goal: ${brief.goal}
- What to build: ${buildItems}
- Target audience: ${brief.audience}
- Language(s): ${languages}
- Budget: €${brief.budget}
- Deadline: ${brief.deadline}
${brief.brand_feel ? `- Brand feel: ${brief.brand_feel}` : ''}
${brief.colors ? `- Colour preferences: ${brief.colors}` : ''}
${brief.ref_sites ? `- Reference sites they liked: ${brief.ref_sites}` : ''}
${brief.has_logo ? `- Logo status: ${brief.has_logo}` : ''}
${brief.has_content ? `- Content status: ${brief.has_content}` : ''}
${brief.pages_needed ? `- Pages needed: ${brief.pages_needed}` : ''}
${brief.current_site ? `- Current website: ${brief.current_site} (replace this)` : ''}
${brief.competitors ? `- Do NOT look like: ${brief.competitors}` : ''}
${brief.call_notes ? `- Notes from discovery call: ${brief.call_notes}` : ''}

BUILD REQUIREMENTS:
1. Create a COMPLETE single HTML file with everything inline (CSS, JS, all content)
2. ${isArabic ? 'Primary language is Arabic (RTL). Use proper formal Gulf Arabic.' : 'Primary language is English.'}
   ${isBilingual ? 'Include BOTH Arabic (RTL) and English versions of all content.' : ''}
3. Mobile-first, fully responsive design
4. Premium, modern design appropriate for a ${brief.city || 'Dubai'} business
5. Real, specific content for ${brief.client_name} — NOT generic placeholder text
6. Include ALL of these sections based on what was requested (${buildItems}):

${(brief.build_items || []).includes('Website') ? `
WEBSITE SECTIONS TO INCLUDE:
- Navigation (sticky, with logo and CTAs)
- Hero section with compelling headline specific to their business
- Services/features section (6+ specific items for this business type)
- About/trust section
- Testimonials (realistic for this industry)
- Contact form (name, email, phone, message — functional with basic validation)
- Footer with all links
` : ''}

${(brief.build_items || []).includes('Booking system') ? `
BOOKING SYSTEM:
- Calendar view showing available slots
- Form: name, email, phone, preferred date/time, service type
- Confirmation message after booking
- Link to: ${BOOKING_LINK}
` : ''}

${(brief.build_items || []).includes('WhatsApp automation') ? `
WHATSAPP INTEGRATION:
- Floating WhatsApp button (bottom right)
- Pre-filled message when clicked: "مرحباً، أود الاستفسار عن خدماتكم / Hello, I'd like to inquire about your services"
- WhatsApp number: to be updated by client
` : ''}

${(brief.build_items || []).includes('Admin dashboard') ? `
ADMIN DASHBOARD SECTION:
- Login screen (demo: admin/admin123)
- Stats overview (leads, bookings, revenue — with realistic sample data)
- Recent activity feed
- Quick actions panel
` : ''}

${(brief.build_items || []).includes('Payment integration') ? `
PAYMENT SECTION:
- Pricing cards with clear tiers
- "Pay now" buttons (linked to placeholder — client will add Stripe/payment link)
- Invoice/receipt template
` : ''}

${(brief.build_items || []).includes('AI chatbot') ? `
AI CHATBOT WIDGET:
- Bottom-right chat bubble
- Auto-greeting after 3 seconds
- Pre-programmed FAQ responses specific to ${brief.client_name}
- "Book a call" CTA in chat
` : ''}

DESIGN RULES:
- Choose colours appropriate for this business type and the feel: "${brief.brand_feel || 'professional, premium, trustworthy'}"
- Google Fonts: Cairo for Arabic text, Inter or appropriate font for English
- Smooth animations (subtle, professional — no overdoing it)
- High contrast, accessible
- Loading fast — no heavy external dependencies except Google Fonts

IMPORTANT LINKS TO INCLUDE:
- Booking/contact CTA → ${BOOKING_LINK}
- Footer: "Built by Schovera Studio · ${AGENCY_URL}"

Return ONLY the complete HTML. Start with <!DOCTYPE html> and end with </html>.
No explanations. No markdown. No code blocks. Just the raw HTML file.
Make it look like it cost €${brief.budget} to build.`;
}

// ── Deploy to Netlify ──
async function deployToNetlify(html, clientName) {
  const siteName = (clientName || 'client')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 35) + '-by-schovera-' + Math.random().toString(36).slice(2, 5);

  // Create site
  const createRes = await fetch('https://api.netlify.com/api/v1/sites', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: siteName })
  });
  if (!createRes.ok) throw new Error(`Netlify create failed: ${await createRes.text()}`);
  const site = await createRes.json();

  // Calculate SHA1
  const encoder = new TextEncoder();
  const data = encoder.encode(html);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const sha1 = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Create deploy
  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { '/index.html': sha1 } })
  });
  if (!deployRes.ok) throw new Error(`Netlify deploy failed: ${await deployRes.text()}`);
  const deploy = await deployRes.json();

  // Upload file
  const uploadRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files/index.html`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}`, 'Content-Type': 'application/octet-stream' },
    body: html
  });
  if (!uploadRes.ok) throw new Error(`Netlify upload failed: ${await uploadRes.text()}`);

  return site.ssl_url || site.url || `https://${siteName}.netlify.app`;
}

// ── Main ──
async function run() {
  // Get all ready briefs
  const { data: briefs, error } = await sb
    .from('ah_briefs')
    .select('*')
    .eq('status', 'ready')
    .order('created_at', { ascending: true });

  if (error) {
    await postChat(`[ERROR] Could not fetch briefs: ${error.message}`);
    process.exit(1);
  }

  if (!briefs || briefs.length === 0) {
    console.log('No ready briefs to build.');
    return;
  }

  await postChat(`Build Agent starting — ${briefs.length} brief${briefs.length > 1 ? 's' : ''} in queue.`);

  for (const brief of briefs) {
    await postChat(`Building for ${brief.client_name} (${brief.city}) — ${(brief.build_items || []).join(', ')}...`);
    await updateBriefLog(brief.id, `Build started for ${brief.client_name}`, 'building');

    try {
      // Generate with Claude
      await updateBriefLog(brief.id, 'Calling Claude API to generate product...');
      await postChat(`Calling Claude to build: ${brief.client_name}...`);

      const prompt = buildPrompt(brief);
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 12000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        throw new Error(`Claude API error ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      const html = data.content?.[0]?.text || '';

      if (!html.includes('<!DOCTYPE') && !html.includes('<html')) {
        throw new Error('Claude did not return valid HTML');
      }

      await updateBriefLog(brief.id, `Claude generated ${Math.round(html.length / 1024)}KB — deploying to Netlify...`);
      await postChat(`✓ Claude built ${Math.round(html.length / 1024)}KB for ${brief.client_name} — deploying...`);

      // Deploy to Netlify
      const liveUrl = await deployToNetlify(html, brief.client_name);

      // Update brief with URL and status
      await sb.from('ah_briefs').update({
        status: 'review',
        build_url: liveUrl,
        build_log: (brief.build_log || '') + `\n[${new Date().toLocaleTimeString()}] ✅ Live at: ${liveUrl}`
      }).eq('id', brief.id);

      // Notify team in agent-status
      await postChat(
        `✅ Build complete for ${brief.client_name}!\n` +
        `Live at: ${liveUrl}\n` +
        `@P3 (Arvi) — please review and approve in the Builds tab.`
      );

      // Also notify in client-fulfillment channel
      await postChat(
        `Build ready for review:\n` +
        `Client: ${brief.client_name} (${brief.city})\n` +
        `Built: ${(brief.build_items || []).join(', ')}\n` +
        `Budget: €${brief.budget} · Deadline: ${brief.deadline}\n` +
        `Preview: ${liveUrl}\n` +
        `@P3 approve → @P2 deliver to ${brief.client_email}`,
        'client-fulfillment'
      );

      // Small delay between builds
      await new Promise(r => setTimeout(r, 3000));

    } catch (err) {
      await updateBriefLog(brief.id, `ERROR: ${err.message}`, 'ready');
      await postChat(
        `[ERROR] Build failed for ${brief.client_name}: ${err.message}\n` +
        `Brief reset to ready — will retry next run. @P1 check if API keys are valid.`
      );
    }
  }

  await postChat(`Build Agent done. Check the Builds tab to review and approve.`);
}

run().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
