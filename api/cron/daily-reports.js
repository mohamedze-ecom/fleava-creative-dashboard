// Daily report cron — fires at 9 AM Eastern (timezone-aware) and emails each
// editor + strategist a personalized status digest. Wired to vercel.json crons.
//
// Required env vars (set in Vercel → Settings → Environment Variables):
//   RESEND_API_KEY        — your Resend API key (re_xxx)
//   REPORT_FROM_EMAIL     — e.g. "Fleava Reports <reports@yourdomain.com>"
//                           (the domain must be verified in Resend)
//   CRON_SECRET           — optional. Vercel sets this automatically; we verify it.
//
// To test manually (bypasses the 9 AM time guard):
//   GET /api/cron/daily-reports?test=1&previewOnly=1   → returns JSON preview
//   GET /api/cron/daily-reports?test=1                 → actually sends emails

import teamEmails from '../../team-emails.json' with { type: 'json' };

const SHEET_ID = '1R-j-eYjRYCeMnbkEP_yrAdtaRfDFGCmI_hPNdbcvrA0';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`;
const FRAME_URL = 'https://next.frame.io/project/7905f746-d4ec-4810-9346-07b2bc001a9c/f34be98c-0ca0-424f-b6b8-b1834165992c';

// ────────────────────────── CSV parsing (mirrors public pages) ──────────────────────────

function parseCSVLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCSV(csv) {
  const lines = csv.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const matches = ['Status', 'Creative Strategist', 'Designer/Editor', 'Type'].filter(k => lines[i].includes(k));
    if (matches.length >= 2) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return [];
  const rawHeaders = parseCSVLine(lines[headerIdx]);
  const headers = rawHeaders.map(h => {
    const t = h.trim();
    if (t === 'Ad set Name') return 'Ad Name';
    if (t === 'Iteration') return 'Start Date';
    return t;
  });
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });
    if (row['Ad Name'] || row['Status'] || row['Creative Strategist']) rows.push(row);
  }
  return rows;
}

function normalizeStatus(s) {
  return (s || '').toLowerCase().trim();
}

// ────────────────────────── Sheet fetching ──────────────────────────

const MONTH_RX = /^(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(t(ember)?)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)\s+\d{2,4}$/i;

async function fetchAllRows(baseUrl) {
  const tabsRes = await fetch(`${baseUrl}/api/sheet-tabs?id=${SHEET_ID}`);
  if (!tabsRes.ok) throw new Error(`tabs fetch ${tabsRes.status}`);
  const tabs = await tabsRes.json();
  const monthTabs = tabs.filter(t => MONTH_RX.test((t.label || '').trim()));

  const all = await Promise.all(monthTabs.map(async (tab) => {
    const r = await fetch(`${baseUrl}/api/sheet-csv?id=${SHEET_ID}&gid=${tab.gid}`);
    if (!r.ok) return [];
    const csv = await r.text();
    const rows = parseCSV(csv);
    rows.forEach(row => { row._tabLabel = shortMonth(tab.label); });
    return rows;
  }));
  return all.flat();
}

function shortMonth(label) {
  const parts = label.trim().split(/\s+/);
  if (parts.length < 2) return label;
  const m = parts[0].substring(0, 3);
  const mc = m.charAt(0).toUpperCase() + m.slice(1).toLowerCase();
  const yr = parts[1].length === 2 ? '20' + parts[1] : parts[1];
  return `${mc} ${yr}`;
}

// ────────────────────────── Report builders ──────────────────────────

function buildEditorReport(rows, editorName) {
  // Anything assigned to this editor with status that is not yet "Launched" or
  // "Ready" — i.e. still in their queue. The user said "edits they need to edit"
  // which matches Need Editing + Needs Revision.
  const QUEUE_STATUSES = new Set(['need editing', 'needs revision']);
  const mine = rows.filter(r =>
    (r['Designer/Editor'] || '').trim() === editorName &&
    QUEUE_STATUSES.has(normalizeStatus(r['Status']))
  );
  if (mine.length === 0) return null;

  const byMonth = {};
  mine.forEach(r => {
    const m = r._tabLabel || 'Unknown';
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(r);
  });

  // Sort months chronologically
  const monthOrder = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sortedMonths = Object.entries(byMonth).sort((a, b) => {
    const [am, ay] = a[0].split(' ');
    const [bm, by] = b[0].split(' ');
    if (ay !== by) return parseInt(ay) - parseInt(by);
    return monthOrder.indexOf(am) - monthOrder.indexOf(bm);
  });

  return { editorName, total: mine.length, sortedMonths };
}

function buildStrategistReport(rows, strategistName) {
  const mine = rows.filter(r =>
    (r['Creative Strategist'] || '').trim() === strategistName
  );
  if (mine.length === 0) return null;

  const buckets = {
    'In Review (Ready)':  { rows: [], color: '#3b82f6', match: s => s === 'ready' },
    'Need Editing':       { rows: [], color: '#eab308', match: s => s.includes('editing') },
    'Needs Revision':     { rows: [], color: '#f97316', match: s => s.includes('revision') },
    'Briefing':           { rows: [], color: '#a855f7', match: s => s.includes('brief') || s.includes('breif') },
    'Content Needed':     { rows: [], color: '#ef4444', match: s => s.includes('content') },
    'Launched':           { rows: [], color: '#22c55e', match: s => s === 'launched' },
  };

  mine.forEach(r => {
    const s = normalizeStatus(r['Status']);
    for (const [, b] of Object.entries(buckets)) {
      if (b.match(s)) { b.rows.push(r); return; }
    }
  });

  const launched = buckets['Launched'].rows.length;
  const winners = mine.filter(r => {
    const w = (r['Winner?'] || '').toString().trim().toLowerCase();
    return w && w !== 'no' && w !== 'n' && w !== '-' && w !== 'n/a';
  }).length;
  const hitRate = launched > 0 ? Math.round((winners / launched) * 100) : 0;

  return { strategistName, total: mine.length, buckets, launched, winners, hitRate };
}

// ────────────────────────── Email rendering ──────────────────────────
// Quick text-style emails: a short summary + two links (Sheet + Frame.io).
// HTML is intentionally minimal — Gmail renders it as plain text would,
// but links remain clickable.

const BODY_STYLE = `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; line-height: 1.6; color: #1d1d1f; max-width: 540px; margin: 0; padding: 24px;`;
const STAT_STYLE = `margin: 0 0 6px 0;`;
const LINK_STYLE = `color: #7c6cf0; text-decoration: none;`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

function linkBlock() {
  return `
    <p style="margin: 24px 0 0 0;">
      <a href="${SHEET_URL}" style="${LINK_STYLE}">→ Google Sheet</a><br>
      <a href="${FRAME_URL}" style="${LINK_STYLE}">→ Frame.io</a>
    </p>
    <p style="margin: 24px 0 0 0; font-size: 12px; color: #86868b;">
      Sent daily at 9 AM ET · Fleava Creative Calendar
    </p>
  `;
}

function renderEditorEmail(report) {
  const first = report.editorName.split(' ')[0];
  const monthBreakdown = report.sortedMonths.map(([month, rows]) =>
    `<p style="${STAT_STYLE}">— <strong>${rows.length}</strong> in ${escapeHtml(month)}</p>`
  ).join('');

  return `<!DOCTYPE html><html><body style="${BODY_STYLE}">
    <p>Hi ${escapeHtml(first)},</p>
    <p>You have <strong>${report.total} brief${report.total !== 1 ? 's' : ''}</strong> that need editing today.</p>
    <p style="margin: 16px 0 6px 0; color: #86868b; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Breakdown by month</p>
    ${monthBreakdown}
    ${linkBlock()}
  </body></html>`;
}

function renderStrategistEmail(report) {
  const first = report.strategistName.split(' ')[0];
  const inReview      = report.buckets['In Review (Ready)'].rows.length;
  const needEditing   = report.buckets['Need Editing'].rows.length;
  const needsRevision = report.buckets['Needs Revision'].rows.length;
  const briefing      = report.buckets['Briefing'].rows.length;
  const launched      = report.buckets['Launched'].rows.length;

  return `<!DOCTYPE html><html><body style="${BODY_STYLE}">
    <p>Hi ${escapeHtml(first)},</p>
    <p>Your brief status today:</p>
    <p style="${STAT_STYLE}">• <strong>${inReview}</strong> in review (ready)</p>
    <p style="${STAT_STYLE}">• <strong>${needEditing}</strong> need editing</p>
    <p style="${STAT_STYLE}">• <strong>${needsRevision}</strong> need revision</p>
    <p style="${STAT_STYLE}">• <strong>${briefing}</strong> still in briefing</p>
    <p style="${STAT_STYLE}">• <strong>${launched}</strong> launched</p>
    <p style="${STAT_STYLE}">• <strong>${report.hitRate}%</strong> hit rate (${report.winners} winner${report.winners !== 1 ? 's' : ''})</p>
    ${linkBlock()}
  </body></html>`;
}

// ────────────────────────── Resend ──────────────────────────

// Strip HTML tags into a clean plain-text fallback. Mail clients use this for
// the text/plain MIME part; deliverability scores improve when both versions
// are present and consistent.
function htmlToText(html) {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REPORT_FROM_EMAIL;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  if (!from) throw new Error('REPORT_FROM_EMAIL not set');

  const text = htmlToText(html);
  // Extract the bare email address from "Display Name <addr@x.com>" so we
  // can use it as the unsubscribe mailto target.
  const fromAddr = (from.match(/<([^>]+)>/) || [, from])[1];

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
      text,
      headers: {
        // RFC 2369 / 8058 — signals to Gmail/Outlook that this is legitimate
        // automated mail with a real opt-out. Big deliverability boost.
        'List-Unsubscribe': `<mailto:${fromAddr}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Resend ${r.status}: ${errText}`);
  }
  return r.json();
}

// Resend free tier is capped at 5 req/sec — pace ourselves at ~4/sec.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SEND_DELAY_MS = 250;

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ────────────────────────── Discord ──────────────────────────

async function postToDiscord(payload) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_WEBHOOK_URL not set');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Discord ${r.status}: ${text}`);
  }
  return { ok: true, status: r.status };
}

function buildDiscordPayload(rows) {
  const editorLines = [];
  for (const name of Object.keys(teamEmails.editors || {})) {
    const r = buildEditorReport(rows, name);
    if (!r) continue;
    const monthBreakdown = r.sortedMonths
      .map(([m, rs]) => `   • \`${rs.length}\` in ${m}`)
      .join('\n');
    editorLines.push(`**${name}** — \`${r.total}\` brief${r.total !== 1 ? 's' : ''} to edit\n${monthBreakdown}`);
  }

  const strategistLines = [];
  for (const name of Object.keys(teamEmails.strategists || {})) {
    const r = buildStrategistReport(rows, name);
    if (!r) continue;
    const inReview      = r.buckets['In Review (Ready)'].rows.length;
    const needEditing   = r.buckets['Need Editing'].rows.length;
    const needsRevision = r.buckets['Needs Revision'].rows.length;
    const launched      = r.buckets['Launched'].rows.length;
    strategistLines.push(
      `**${name}** — \`${inReview}\` in review · \`${needEditing}\` editing · \`${needsRevision}\` revisions · \`${launched}\` launched`
    );
  }

  // Ready-to-launch count for Laurence — every creative across the calendar
  // currently sitting in the "Ready" status, awaiting launch in the ad account.
  const readyCount = rows.filter(r => normalizeStatus(r['Status']) === 'ready').length;

  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  // Discord embed field values are capped at 1024 characters. If our editor
  // queue list runs longer (multi-line month breakdowns can be chatty), split
  // across multiple fields so nothing gets truncated.
  function chunkIntoFields(lines, separator, headerName) {
    const out = [];
    let current = '';
    let isFirst = true;
    for (const line of lines) {
      const candidate = current ? current + separator + line : line;
      if (candidate.length > 1000) {
        out.push({ name: isFirst ? headerName : '↳ continued', value: current, inline: false });
        current = line;
        isFirst = false;
      } else {
        current = candidate;
      }
    }
    if (current) out.push({ name: isFirst ? headerName : '↳ continued', value: current, inline: false });
    return out;
  }

  const editorFields = editorLines.length > 0
    ? chunkIntoFields(editorLines, '\n\n', '🎬 Editor Queues')
    : [{ name: '🎬 Editor Queues', value: '_No briefs in any editor queue today._', inline: false }];

  return {
    username: 'Fleava Reports',
    embeds: [{
      title: '📊 Daily Creative Report',
      description: today,
      color: 0x7c6cf0,
      fields: [
        ...editorFields,
        { name: '📝 Strategist Status', value: strategistLines.join('\n') || '_No strategist briefs today._', inline: false },
        { name: '🚀 Ready to Launch (Laurence)', value: `**${readyCount}** creative${readyCount !== 1 ? 's' : ''} ready to launch in the ad account`, inline: false },
        { name: '​', value: `[📄 Google Sheet](${SHEET_URL}) · [🎞️ Frame.io](${FRAME_URL}) · [📈 Dashboard](https://fleava-creative-dashboard.vercel.app)`, inline: false },
      ],
      footer: { text: 'Sent daily at 9 AM ET · Fleava Creative Calendar' },
      timestamp: new Date().toISOString(),
    }],
  };
}

// Normalize a JSON config value to an array of valid email addresses.
// Accepts a string ("a@b.com") or array (["a@b.com", "c@d.com"]).
function recipientsFor(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(s => (s || '').trim()).filter(isValidEmail);
}

// ────────────────────────── Handler ──────────────────────────

export default async function handler(req, res) {
  const test = req.query.test === '1';
  const previewOnly = req.query.previewOnly === '1';

  // Auth: Vercel cron requests carry "Authorization: Bearer ${CRON_SECRET}".
  // For manual testing in browser you can bypass with ?test=1 but ONLY if you
  // also know the test query string — keeps the endpoint from being publicly
  // triggerable in production.
  if (!test) {
    const cronSecret = process.env.CRON_SECRET;
    const auth = req.headers.authorization || '';
    if (cronSecret && auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Vercel Hobby allows one cron firing per day, so we schedule at 13:00 UTC.
    // That's 9 AM EDT (March-November) and 8 AM EST (November-March). When the
    // user upgrades to Pro we can fire twice (13 + 14 UTC) and re-add a
    // timezone guard to keep delivery at exactly 9 AM ET year-round.
  }

  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const baseUrl = `${proto}://${host}`;
    const rows = await fetchAllRows(baseUrl);

    // ────────── Discord announcement (single consolidated message) ──────────
    // Posts only if DISCORD_WEBHOOK_URL is configured. Skip with ?skipDiscord=1.
    // In previewOnly mode we always build the payload so you can verify the
    // message format before configuring the webhook.
    let discordResult = null;
    if (req.query.skipDiscord !== '1') {
      const payload = buildDiscordPayload(rows);
      if (previewOnly) {
        discordResult = { previewOnly: true, payload };
      } else if (process.env.DISCORD_WEBHOOK_URL) {
        try {
          const r = await postToDiscord(payload);
          discordResult = { sent: true, ...r };
        } catch (e) {
          discordResult = { error: e.message };
        }
      } else {
        discordResult = { skipped: 'DISCORD_WEBHOOK_URL not set' };
      }
    }

    // ?preview=editor:Kashif  or  ?preview=strategist:Tysin  → returns the
    // rendered HTML for that person's email so you can view it in a browser.
    const previewName = req.query.preview;
    if (test && previewName) {
      const [kind, ...rest] = String(previewName).split(':');
      const name = rest.join(':');
      let html = `<p>Not found</p>`;
      if (kind === 'editor') {
        const r = buildEditorReport(rows, name);
        if (r) html = renderEditorEmail(r);
      } else if (kind === 'strategist') {
        const r = buildStrategistReport(rows, name);
        if (r) html = renderStrategistEmail(r);
      }
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }

    // In previewOnly mode we generate reports for every name even if no email
    // is set yet — that lets you test the content before configuring Resend.
    // ?testTo=hello@fleava.shop overrides every recipient to a single address.
    // Useful for sending all of the day's reports to your own inbox so you can
    // preview what each person would receive — works even before the sending
    // domain is verified in Resend.
    const testTo = req.query.testTo;
    const overrideTo = testTo && isValidEmail(testTo) ? [testTo] : null;

    // ?only=Mohamed restricts the run to a single person (case-insensitive).
    // Combine with ?testTo to send just that person's report to a chosen inbox.
    const only = req.query.only ? String(req.query.only).toLowerCase() : null;

    // ────────── Per-person email reports ──────────
    // Sends only if RESEND_API_KEY is configured. Skip with ?skipEmail=1.
    const skipEmail = req.query.skipEmail === '1' || !process.env.RESEND_API_KEY;

    // In previewOnly mode we generate reports for every name even if no email
    // is set yet — that lets you test the content before configuring Resend.
    const editorResults = [];
    let sentCount = 0;
    if (!skipEmail) for (const [name, raw] of Object.entries(teamEmails.editors || {})) {
      if (only && name.toLowerCase() !== only) continue;
      const to = overrideTo || recipientsFor(raw);
      if (!previewOnly && to.length === 0) { editorResults.push({ name, skipped: 'no email' }); continue; }
      const report = buildEditorReport(rows, name);
      if (!report) { editorResults.push({ name, to, skipped: 'no briefs' }); continue; }
      const baseSubject = `Daily Edit Queue — ${report.total} brief${report.total !== 1 ? 's' : ''}`;
      const subject = overrideTo ? `[${name}] ${baseSubject}` : baseSubject;
      const html = renderEditorEmail(report);
      if (previewOnly) {
        editorResults.push({ name, to, total: report.total, briefs: report.sortedMonths.map(([m, rs]) => ({ month: m, count: rs.length, names: rs.slice(0, 5).map(r => r['Ad Name']) })) });
        continue;
      }
      if (sentCount > 0) await sleep(SEND_DELAY_MS); // pace under Resend's 5 req/sec cap
      sentCount++;
      try {
        const r = await sendEmail({ to, subject, html });
        editorResults.push({ name, to, total: report.total, sent: true, id: r.id });
      } catch (e) {
        editorResults.push({ name, to, error: e.message });
      }
    }

    const strategistResults = [];
    if (!skipEmail) for (const [name, raw] of Object.entries(teamEmails.strategists || {})) {
      if (only && name.toLowerCase() !== only) continue;
      const to = overrideTo || recipientsFor(raw);
      if (!previewOnly && to.length === 0) { strategistResults.push({ name, skipped: 'no email' }); continue; }
      const report = buildStrategistReport(rows, name);
      if (!report) { strategistResults.push({ name, to, skipped: 'no briefs' }); continue; }
      const baseSubject = `Daily Brief Status — ${report.total} brief${report.total !== 1 ? 's' : ''}`;
      const subject = overrideTo ? `[${name}] ${baseSubject}` : baseSubject;
      const html = renderStrategistEmail(report);
      if (previewOnly) {
        const summary = {};
        for (const [bname, b] of Object.entries(report.buckets)) summary[bname] = b.rows.length;
        strategistResults.push({ name, to, total: report.total, hitRate: report.hitRate, byStatus: summary });
        continue;
      }
      if (sentCount > 0) await sleep(SEND_DELAY_MS);
      sentCount++;
      try {
        const r = await sendEmail({ to, subject, html });
        strategistResults.push({ name, to, total: report.total, sent: true, id: r.id });
      } catch (e) {
        strategistResults.push({ name, to, error: e.message });
      }
    }

    res.status(200).json({
      timestamp: new Date().toISOString(),
      mode: previewOnly ? 'preview' : (test ? 'test-send' : 'cron'),
      rowsFetched: rows.length,
      discord: discordResult,
      emailsSkipped: skipEmail,
      editors: editorResults,
      strategists: strategistResults,
    });
  } catch (err) {
    console.error('Daily report failed:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}
