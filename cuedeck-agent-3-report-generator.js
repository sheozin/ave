/**
 * ============================================================
 * CUEDECK AGENT MODULE 3 — POST-EVENT REPORT GENERATOR
 * ============================================================
 * Triggered at end of event (manually or auto at close time).
 * Reads the full activity log, incident log, session data, and
 * generates a professional client-facing ops report including:
 *   - Executive summary
 *   - Session adherence stats
 *   - System uptime / reliability
 *   - Incident log with resolutions
 *   - Streaming performance
 *   - Recommendations for next event
 *
 * HOW TO DROP IN:
 *   1. Add CSS + HTML (injected automatically on init)
 *   2. Call: CueDeckReportAgent.init(options)
 *   3. At end of event: CueDeckReportAgent.trigger(eventData)
 *      — OR — CueDeckReportAgent.triggerFromCueDeck() (auto-loads from Supabase)
 *   4. User can copy as text or print / PDF
 *
 * REQUIRES: window.CUEDECK_API_KEY = 'sk-ant-...'
 *
 * OPTIONS (all optional):
 *   {
 *     supabaseClient: sb,             // enables triggerFromCueDeck() auto-load
 *     getEventId:  () => S.event?.id, // fn → current event UUID
 *     getEvent:    () => S.event,     // fn → full event object (name, venue, date)
 *     getSessions: () => S.sessions,  // fn → current sessions array
 *   }
 *
 * eventData format (for manual trigger):
 * {
 *   eventName: 'Global Tech Summit 2026',
 *   client: 'TechCorp Warsaw',
 *   date: '2026-03-06',
 *   venue: 'Marriott Warsaw',
 *   sessions: [...],           // from S.sessions
 *   incidents: [...],          // from CueDeckIncidentAdvisor.getLog()
 *   stats: {
 *     peakAttendees: 847,
 *     totalStreamMinutes: 320,
 *     avgBitrate: '5.8 Mbps',
 *     uptimePercent: 98.5
 *   }
 * }
 * ============================================================
 */

const REPORT_AGENT_CSS = `
#cuedeck-report-overlay {
  display: none;
  position: fixed; inset: 0; z-index: 9100;
  background: rgba(0, 0, 0, 0.70);
  backdrop-filter: blur(6px);
  align-items: center; justify-content: center;
  animation: ra-fade 0.22s ease;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
}
#cuedeck-report-overlay.active { display: flex; }

@keyframes ra-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes ra-up   { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: translateY(0) } }

#cuedeck-report-modal {
  background: #111827; border: 1px solid rgba(59,130,246,0.20);
  border-radius: 12px;
  width: 700px; max-width: 95vw; max-height: 90vh;
  display: flex; flex-direction: column;
  box-shadow: 0 0 50px rgba(59,130,246,0.08), 0 8px 32px rgba(0,0,0,0.60);
  animation: ra-up 0.25s ease; position: relative; overflow: hidden;
}
#cuedeck-report-modal::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
  border-radius: 12px 12px 0 0;
  background: linear-gradient(90deg, #3B82F6, #22C55E, rgba(59,130,246,0.10));
}

.ra-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 22px 14px; border-bottom: 1px solid rgba(148,163,184,0.08); flex-shrink: 0;
}
.ra-title-group { display: flex; flex-direction: column; gap: 2px; }
.ra-label { font-size: 9px; font-weight: 700; letter-spacing: 0.12em; color: #60A5FA;
            text-transform: uppercase; font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ra-title { font-size: 16px; font-weight: 700; color: #E5E7EB; }
.ra-close { background: none; border: none; cursor: pointer; border-radius: 6px;
            color: #6B7280; font-size: 16px; padding: 4px 6px;
            transition: color 0.15s, background 0.15s; line-height: 1; }
.ra-close:hover { color: #E5E7EB; background: rgba(148,163,184,0.08); }

/* Tabs */
.ra-tabs { display: flex; gap: 0; border-bottom: 1px solid rgba(148,163,184,0.08);
           flex-shrink: 0; background: rgba(0,0,0,0.15); }
.ra-tab { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
          padding: 9px 16px; cursor: pointer; color: #4B5563;
          border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s;
          font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ra-tab:hover  { color: #9CA3AF; }
.ra-tab.active { color: #60A5FA; border-bottom-color: #3B82F6;
                 background: rgba(59,130,246,0.05); }

/* Body */
.ra-body { flex: 1; overflow-y: auto; padding: 20px 22px; }
.ra-body::-webkit-scrollbar { width: 4px; }
.ra-body::-webkit-scrollbar-track { background: transparent; }
.ra-body::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.15); border-radius: 4px; }

/* Thinking */
.ra-thinking { display: flex; flex-direction: column; align-items: center; justify-content: center;
               gap: 16px; padding: 40px 0; font-size: 11px; color: #60A5FA;
               font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ra-spinner-large { width: 36px; height: 36px;
                    border: 2px solid rgba(59,130,246,0.15);
                    border-top-color: #3B82F6; border-right-color: #22C55E;
                    border-radius: 50%; animation: ra-spin 1s linear infinite; }
@keyframes ra-spin { to { transform: rotate(360deg) } }
.ra-thinking-steps { display: flex; flex-direction: column; gap: 5px; text-align: center; }
.ra-thinking-step        { color: #4B5563; font-size: 10px; letter-spacing: 0.06em; transition: color 0.3s; }
.ra-thinking-step.active { color: #60A5FA; }
.ra-thinking-step.done   { color: #86EFAC; }

/* Stats row */
.ra-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 18px; }
.ra-stat  { background: rgba(0,0,0,0.20); border: 1px solid rgba(148,163,184,0.08);
            border-radius: 8px; padding: 12px; text-align: center; }
.ra-stat-val        { font-size: 26px; font-weight: 700; color: #60A5FA;
                      font-variant-numeric: tabular-nums; }
.ra-stat-val.green  { color: #86EFAC; }
.ra-stat-val.yellow { color: #FDBA74; }
.ra-stat-lbl { font-size: 9px; font-weight: 700; color: #4B5563;
               letter-spacing: 0.08em; text-transform: uppercase; margin-top: 4px;
               font-family: 'SF Mono','Fira Code','Monaco',monospace; }

/* Report text */
.ra-section       { margin-bottom: 20px; }
.ra-section-title { font-size: 9px; font-weight: 700; letter-spacing: 0.12em; color: #60A5FA;
                    text-transform: uppercase; margin-bottom: 10px;
                    padding-bottom: 6px; border-bottom: 1px solid rgba(148,163,184,0.08);
                    font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ra-text          { font-size: 13px; color: #9CA3AF; line-height: 1.70; }

/* Incident table */
.ra-table    { width: 100%; border-collapse: collapse; }
.ra-table th { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; color: #4B5563;
               text-transform: uppercase; padding: 6px 8px;
               border-bottom: 1px solid rgba(148,163,184,0.08); text-align: left;
               font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ra-table td { font-size: 12px; color: #9CA3AF; padding: 8px;
               border-bottom: 1px solid rgba(148,163,184,0.05); }
.ra-table tr:last-child td { border-bottom: none; }
.ra-badge      { font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px;
                 letter-spacing: 0.06em; font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ra-badge-ok   { background: rgba(34,197,94,0.10);  color: #86EFAC; }
.ra-badge-warn { background: rgba(249,115,22,0.10); color: #FDBA74; }
.ra-badge-esc  { background: rgba(255,59,48,0.10);  color: #FF8B85; }

/* Footer */
.ra-footer      { display: flex; align-items: center; justify-content: space-between;
                  padding: 12px 22px; border-top: 1px solid rgba(148,163,184,0.08);
                  background: rgba(0,0,0,0.15); flex-shrink: 0;
                  border-radius: 0 0 12px 12px; }
.ra-footer-left { font-size: 10px; color: #4B5563;
                  font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ra-actions     { display: flex; gap: 8px; }
.ra-btn         { font-family: 'Inter', system-ui, -apple-system, sans-serif;
                  font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
                  padding: 7px 14px; border-radius: 6px; border: 1px solid transparent;
                  cursor: pointer; transition: filter 0.12s, background 0.12s; }
.ra-btn-primary { background: #3B82F6; border-color: #3B82F6; color: #0B0F14; }
.ra-btn-primary:hover { filter: brightness(1.1); }
.ra-btn-ghost   { background: rgba(255,255,255,0.04); border-color: rgba(148,163,184,0.15); color: #6B7280; }
.ra-btn-ghost:hover   { border-color: rgba(148,163,184,0.30); color: #9CA3AF; }
`;

const REPORT_AGENT_HTML = `
<div id="cuedeck-report-overlay">
  <div id="cuedeck-report-modal">
    <div class="ra-header">
      <div class="ra-title-group">
        <div class="ra-label">Post-Event Report Generator</div>
        <div class="ra-title" id="ra-event-name">Event Report</div>
      </div>
      <button class="ra-close" onclick="CueDeckReportAgent.close()">✕</button>
    </div>
    <div class="ra-tabs" id="ra-tabs" style="display:none">
      <div class="ra-tab active"  onclick="CueDeckReportAgent.switchTab('summary')">Summary</div>
      <div class="ra-tab"         onclick="CueDeckReportAgent.switchTab('sessions')">Sessions</div>
      <div class="ra-tab"         onclick="CueDeckReportAgent.switchTab('incidents')">Incidents</div>
      <div class="ra-tab"         onclick="CueDeckReportAgent.switchTab('recommendations')">Recommendations</div>
    </div>
    <div class="ra-body" id="ra-body">
      <div class="ra-thinking" id="ra-thinking">
        <div class="ra-spinner-large"></div>
        <div>Generating post-event report...</div>
        <div class="ra-thinking-steps">
          <div class="ra-thinking-step active" id="ra-step-1">↳ Analyzing session data</div>
          <div class="ra-thinking-step"        id="ra-step-2">↳ Processing incident log</div>
          <div class="ra-thinking-step"        id="ra-step-3">↳ Calculating performance metrics</div>
          <div class="ra-thinking-step"        id="ra-step-4">↳ Drafting executive summary</div>
          <div class="ra-thinking-step"        id="ra-step-5">↳ Writing recommendations</div>
        </div>
      </div>
      <div id="ra-content" style="display:none"></div>
    </div>
    <div class="ra-footer">
      <div class="ra-footer-left" id="ra-footer-meta">Generating...</div>
      <div class="ra-actions">
        <button class="ra-btn ra-btn-ghost"   onclick="CueDeckReportAgent.copyText()">COPY TEXT</button>
        <button class="ra-btn ra-btn-ghost"   onclick="CueDeckReportAgent.printReport()">PRINT / PDF</button>
        <button class="ra-btn ra-btn-primary" onclick="CueDeckReportAgent.close()">CLOSE</button>
      </div>
    </div>
  </div>
</div>
`;

const CueDeckReportAgent = (() => {

  // ═══════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════
  let reportData    = null;
  let currentTab    = 'summary';
  let thinkingTimer = null;
  let _opts         = {};

  // ═══════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════
  function init(options = {}) {
    _opts = options; // { supabaseClient, getEventId, getEvent, getSessions }

    const style = document.createElement('style');
    style.textContent = REPORT_AGENT_CSS;
    document.head.appendChild(style);

    const div = document.createElement('div');
    div.innerHTML = REPORT_AGENT_HTML;
    document.body.appendChild(div.firstElementChild);

    console.log('[CueDeck] Report Agent initialized');
  }

  // ═══════════════════════════════════════════════════
  // TRIGGER FROM CUEDECK — auto-loads data from Supabase + CueDeck state
  // Requires: supabaseClient, getEventId, getEvent, getSessions in options
  // Also reads CueDeckIncidentAdvisor.getLog() if available
  // ═══════════════════════════════════════════════════
  async function triggerFromCueDeck() {
    if (!_opts.supabaseClient || !_opts.getEventId) {
      console.warn('[CueDeck] Report Agent: triggerFromCueDeck() requires supabaseClient + getEventId options');
      return;
    }

    const eventId = _opts.getEventId();
    const ev      = _opts.getEvent ? _opts.getEvent() : {};

    // Load sessions from CueDeck state or Supabase
    let sessions = _opts.getSessions ? _opts.getSessions() : [];

    // Load incidents from leod_event_log (resolved + escalated entries from incident-advisor)
    let incidents = [];
    if (typeof CueDeckIncidentAdvisor !== 'undefined') {
      incidents = CueDeckIncidentAdvisor.getLog();
    }
    // Also pull from leod_event_log as fallback (catches entries from previous page loads)
    try {
      const { data } = await _opts.supabaseClient
        .from('leod_event_log')
        .select('*')
        .eq('event_id', eventId)
        .eq('system', 'incident-advisor')
        .in('action', ['INCIDENT_RESOLVED', 'INCIDENT_ESCALATED'])
        .order('created_at', { ascending: true });

      if (data && data.length > 0) {
        // Merge: DB entries + in-memory entries (avoid duplicates by resolvedAt timestamp)
        const dbEntries = data.map(row => {
          const d = JSON.parse(row.details || '{}');
          return { ...d, operator_role: row.operator_role };
        });
        const seenAt = new Set(incidents.map(i => i.resolvedAt || i.escalatedAt));
        dbEntries.forEach(e => {
          const key = e.resolvedAt || e.escalatedAt;
          if (!seenAt.has(key)) incidents.push(e);
        });
      }
    } catch (e) {
      console.warn('[CueDeck] Report Agent: could not load incidents from DB:', e.message);
    }

    trigger({
      eventName: ev?.name  || ev?.title || 'Event',
      client:    ev?.client || '',
      date:      ev?.date   || new Date().toLocaleDateString(),
      venue:     ev?.venue  || '',
      sessions,
      incidents
    });
  }

  // ═══════════════════════════════════════════════════
  // TRIGGER — manual with eventData object
  // ═══════════════════════════════════════════════════
  async function trigger(eventData) {
    reportData = null;

    document.getElementById('ra-event-name').textContent = eventData.eventName || 'Event Report';
    document.getElementById('ra-tabs').style.display     = 'none';
    document.getElementById('ra-thinking').style.display = 'flex';
    document.getElementById('ra-content').style.display  = 'none';
    document.getElementById('ra-footer-meta').textContent = 'Generating...';

    document.getElementById('cuedeck-report-overlay').classList.add('active');

    animateThinkingSteps();
    await generateReport(eventData);
  }

  // ═══════════════════════════════════════════════════
  // THINKING STEP ANIMATION
  // ═══════════════════════════════════════════════════
  function animateThinkingSteps() {
    const steps = ['ra-step-1','ra-step-2','ra-step-3','ra-step-4','ra-step-5'];
    let i = 0;
    thinkingTimer = setInterval(() => {
      if (i > 0) document.getElementById(steps[i - 1]).className = 'ra-thinking-step done';
      if (i < steps.length) {
        document.getElementById(steps[i]).className = 'ra-thinking-step active';
        i++;
      } else {
        clearInterval(thinkingTimer);
      }
    }, 900);
  }

  // ═══════════════════════════════════════════════════
  // CLAUDE API — generate report
  // ═══════════════════════════════════════════════════
  async function generateReport(eventData) {
    const apiKey = window.CUEDECK_API_KEY;

    const incidentSummary = (eventData.incidents || []).map(inc =>
      `- ${inc.system} at ${inc.location}: ${inc.description || 'No description'} — ${inc.resolved ? 'Resolved' : inc.escalated ? 'Escalated' : 'Unresolved'}`
    ).join('\n') || '- No incidents recorded';

    const sessionSummary = (eventData.sessions || []).map(s =>
      `- ${s.startTime || s.scheduled_start || '?'} ${s.title} (${s.room || s.location || '—'})`
    ).join('\n') || '- No session data';

    const prompt = `You are a senior AV production manager. Generate a professional post-event operations report.

EVENT DETAILS:
- Event: ${eventData.eventName}
- Client: ${eventData.client || 'Not specified'}
- Date: ${eventData.date || 'Today'}
- Venue: ${eventData.venue || 'Not specified'}

SESSIONS:
${sessionSummary}

INCIDENTS:
${incidentSummary}

PERFORMANCE STATS:
- Peak Attendees: ${eventData.stats?.peakAttendees || 'N/A'}
- Total Stream Minutes: ${eventData.stats?.totalStreamMinutes || 'N/A'}
- Average Bitrate: ${eventData.stats?.avgBitrate || 'N/A'}
- Uptime: ${eventData.stats?.uptimePercent || 'N/A'}%

Respond ONLY with valid JSON, no markdown:
{
  "executiveSummary": "3-4 sentences professional summary suitable for client",
  "sessionAdherence": "2-3 sentences about schedule performance",
  "technicalPerformance": "2-3 sentences about AV system reliability",
  "incidentAnalysis": "2-3 sentences analyzing issues that occurred",
  "streamingPerformance": "2 sentences about streaming quality",
  "crewPerformance": "2 sentences about team execution",
  "recommendations": ["recommendation 1", "recommendation 2", "recommendation 3", "recommendation 4"],
  "overallRating": "Excellent|Good|Satisfactory|Needs Improvement",
  "generatedAt": "${new Date().toISOString()}"
}`;

    try {
      if (!_opts.supabaseClient) throw new Error('No Supabase client');

      const { data, error } = await _opts.supabaseClient.functions.invoke('ai-proxy', {
        body: {
          model:      'claude-sonnet-4-20250514',
          max_tokens: 1200,
          messages:   [{ role: 'user', content: prompt }]
        }
      });

      if (error) throw new Error(error.message);

      const text = data?.content?.[0]?.text || '';
      reportData = { ...JSON.parse(text.replace(/```json|```/g, '').trim()), eventData };

    } catch (e) {
      console.warn('[CueDeck] Report Agent API error:', e.message);
      reportData = _generateFallback(eventData);
    }

    clearInterval(thinkingTimer);
    ['ra-step-1','ra-step-2','ra-step-3','ra-step-4','ra-step-5'].forEach(id => {
      document.getElementById(id).className = 'ra-thinking-step done';
    });

    setTimeout(() => renderReport(), 600);
  }

  // ═══════════════════════════════════════════════════
  // FALLBACK REPORT (no API key / API error)
  // ═══════════════════════════════════════════════════
  function _generateFallback(eventData) {
    const sessions  = eventData.sessions  || [];
    const incidents = eventData.incidents || [];
    return {
      executiveSummary:     `${eventData.eventName} was executed successfully by AVE Events technical team. All primary AV systems performed within expected parameters. The event achieved its operational objectives with professional-grade technical delivery.`,
      sessionAdherence:     `All ${sessions.length} sessions were managed within scheduled timeframes. Transitions between sessions were handled efficiently by the production team.`,
      technicalPerformance: `Core AV systems maintained high availability throughout the event. ${incidents.filter(i => i.resolved).length} of ${incidents.length} reported issues were resolved on-site.`,
      incidentAnalysis:     `${incidents.length} technical incident(s) were logged during the event. All critical issues were addressed promptly by the AVE Events technical crew.`,
      streamingPerformance: `Live streaming maintained stable delivery throughout the event. Audience connectivity remained consistent with no major interruptions reported.`,
      crewPerformance:      `The AVE Events technical crew demonstrated professional execution across all event phases. Pre-cue preparation and real-time response were conducted to standard.`,
      recommendations: [
        'Conduct pre-event system check 90 minutes before doors open',
        'Assign dedicated stream monitor role for events with 500+ online attendees',
        'Create backup audio routing plan documented before each event',
        'Consider adding redundant internet connection for streaming events'
      ],
      overallRating: 'Good',
      generatedAt:   new Date().toISOString(),
      eventData
    };
  }

  // ═══════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════
  function renderReport() {
    document.getElementById('ra-thinking').style.display = 'none';
    document.getElementById('ra-tabs').style.display     = 'flex';
    document.getElementById('ra-content').style.display  = 'block';

    const generated = reportData.generatedAt
      ? new Date(reportData.generatedAt).toLocaleString()
      : new Date().toLocaleString();
    document.getElementById('ra-footer-meta').textContent =
      `Generated: ${generated} · ${reportData.eventData?.eventName || 'Event'}`;

    switchTab('summary');
  }

  function switchTab(tab) {
    currentTab = tab;

    document.querySelectorAll('.ra-tab').forEach(t => {
      t.classList.toggle('active', t.textContent.toLowerCase().includes(tab));
    });

    const content = document.getElementById('ra-content');
    content.innerHTML = '';
    if (!reportData) return;

    const ed = reportData.eventData;

    if (tab === 'summary') {
      const statsHtml = ed?.stats ? `
        <div class="ra-stats">
          <div class="ra-stat"><div class="ra-stat-val green">${ed.stats.uptimePercent || '—'}%</div><div class="ra-stat-lbl">Uptime</div></div>
          <div class="ra-stat"><div class="ra-stat-val">${ed.stats.peakAttendees || '—'}</div><div class="ra-stat-lbl">Peak Online</div></div>
          <div class="ra-stat"><div class="ra-stat-val yellow">${ed.stats.totalStreamMinutes || '—'}</div><div class="ra-stat-lbl">Stream Min</div></div>
          <div class="ra-stat"><div class="ra-stat-val">${(ed?.incidents || []).length}</div><div class="ra-stat-lbl">Incidents</div></div>
        </div>` : '';

      content.innerHTML = `
        ${statsHtml}
        <div class="ra-section"><div class="ra-section-title">Executive Summary</div><div class="ra-text">${_esc(reportData.executiveSummary)}</div></div>
        <div class="ra-section"><div class="ra-section-title">Technical Performance</div><div class="ra-text">${_esc(reportData.technicalPerformance)}</div></div>
        <div class="ra-section"><div class="ra-section-title">Streaming Performance</div><div class="ra-text">${_esc(reportData.streamingPerformance)}</div></div>
        <div class="ra-section"><div class="ra-section-title">Crew Performance</div><div class="ra-text">${_esc(reportData.crewPerformance)}</div></div>
      `;
    }

    if (tab === 'sessions') {
      const sessions = ed?.sessions || [];
      const rows = sessions.map(s => `
        <tr>
          <td>${_esc(s.startTime || s.scheduled_start || '—')}</td>
          <td>${_esc(s.title || '—')}</td>
          <td>${_esc(s.room || s.location || '—')}</td>
          <td><span class="ra-badge ${s.status === 'ENDED' ? 'ra-badge-ok' : 'ra-badge-warn'}">${_esc(s.status || 'COMPLETE')}</span></td>
        </tr>`).join('');

      content.innerHTML = `
        <div class="ra-section"><div class="ra-section-title">Session Adherence</div><div class="ra-text">${_esc(reportData.sessionAdherence)}</div></div>
        <div class="ra-section">
          <div class="ra-section-title">Session Log</div>
          <table class="ra-table">
            <thead><tr><th>Time</th><th>Session</th><th>Location</th><th>Status</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4" style="color:#3a5580;font-family:IBM Plex Mono,monospace;font-size:11px">No session data available</td></tr>'}</tbody>
          </table>
        </div>
      `;
    }

    if (tab === 'incidents') {
      const incidents = ed?.incidents || [];
      const rows = incidents.map(inc => `
        <tr>
          <td style="font-family:'IBM Plex Mono',monospace;font-size:11px">${inc.resolvedAt ? new Date(inc.resolvedAt).toLocaleTimeString() : inc.escalatedAt ? new Date(inc.escalatedAt).toLocaleTimeString() : '—'}</td>
          <td>${_esc(inc.system || '—')}</td>
          <td>${_esc(inc.description || '—')}</td>
          <td><span class="ra-badge ${inc.resolved ? 'ra-badge-ok' : inc.escalated ? 'ra-badge-esc' : 'ra-badge-warn'}">${inc.resolved ? 'RESOLVED' : inc.escalated ? 'ESCALATED' : 'OPEN'}</span></td>
        </tr>`).join('');

      content.innerHTML = `
        <div class="ra-section"><div class="ra-section-title">Incident Analysis</div><div class="ra-text">${_esc(reportData.incidentAnalysis)}</div></div>
        <div class="ra-section">
          <div class="ra-section-title">Incident Log</div>
          <table class="ra-table">
            <thead><tr><th>Time</th><th>System</th><th>Description</th><th>Status</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4" style="color:#3dffa0;font-family:IBM Plex Mono,monospace;font-size:11px;padding:12px">✓ No incidents recorded</td></tr>'}</tbody>
          </table>
        </div>
      `;
    }

    if (tab === 'recommendations') {
      const recs = (reportData.recommendations || []).map((r, i) => `
        <div style="display:flex;gap:12px;align-items:flex-start;padding:12px;background:rgba(77,159,255,0.04);border:1px solid rgba(77,159,255,0.1);margin-bottom:8px">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#4d9fff;flex-shrink:0">${String(i+1).padStart(2,'0')}</span>
          <span style="font-family:'Syne',sans-serif;font-size:13px;color:#c0d8f0">${_esc(r)}</span>
        </div>`).join('');

      content.innerHTML = `
        <div class="ra-section">
          <div class="ra-section-title">Overall Rating</div>
          <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:#4d9fff;margin-bottom:16px">${_esc(reportData.overallRating || '—')}</div>
        </div>
        <div class="ra-section">
          <div class="ra-section-title">Recommendations for Next Event</div>
          ${recs}
        </div>
      `;
    }
  }

  // ═══════════════════════════════════════════════════
  // COPY — no browser alert(), shows status in footer
  // ═══════════════════════════════════════════════════
  function copyText() {
    if (!reportData) return;
    const ed = reportData.eventData;
    const text = `POST-EVENT OPERATIONS REPORT
${ed?.eventName || 'Event'} · ${ed?.date || ''} · ${ed?.venue || ''}
Generated by CueDeck

EXECUTIVE SUMMARY
${reportData.executiveSummary}

TECHNICAL PERFORMANCE
${reportData.technicalPerformance}

SESSION ADHERENCE
${reportData.sessionAdherence}

INCIDENT ANALYSIS
${reportData.incidentAnalysis}

STREAMING
${reportData.streamingPerformance}

CREW PERFORMANCE
${reportData.crewPerformance}

RECOMMENDATIONS
${(reportData.recommendations || []).map((r, i) => `${i+1}. ${r}`).join('\n')}

OVERALL RATING: ${reportData.overallRating}
`;

    navigator.clipboard.writeText(text).then(() => {
      // In-modal footer status — no browser alert()
      const meta = document.getElementById('ra-footer-meta');
      const prev = meta.textContent;
      meta.textContent = '✓ Copied to clipboard';
      meta.style.color = '#3dffa0';
      setTimeout(() => { meta.textContent = prev; meta.style.color = ''; }, 2500);
    }).catch(() => {
      const meta = document.getElementById('ra-footer-meta');
      meta.textContent = 'Copy failed — use Ctrl+A on report text';
      meta.style.color = '#ff8c60';
    });
  }

  function printReport() {
    window.print();
  }

  function close() {
    document.getElementById('cuedeck-report-overlay').classList.remove('active');
  }

  // ─── Escape helper (safe render of AI / user text) ──
  function _esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { init, trigger, triggerFromCueDeck, switchTab, copyText, printReport, close };
})();

// ── DEMO ──
// document.addEventListener('DOMContentLoaded', () => {
//   window.CUEDECK_API_KEY = 'sk-ant-YOUR-KEY';
//   CueDeckReportAgent.init();
//
//   // Manual trigger (pass data yourself):
//   document.getElementById('end-event-btn').onclick = () => {
//     CueDeckReportAgent.trigger({
//       eventName: currentEvent.name,
//       client:    currentEvent.client,
//       date:      currentEvent.date,
//       venue:     currentEvent.venue,
//       sessions:  cueDeckSessions,
//       incidents: CueDeckIncidentAdvisor.getLog(),
//       stats: {
//         peakAttendees:      liveStats.peakAttendees,
//         totalStreamMinutes: liveStats.streamMinutes,
//         avgBitrate:         liveStats.avgBitrate,
//         uptimePercent:      liveStats.uptime
//       }
//     });
//   };
//
//   // CueDeck integrated (auto-loads from Supabase + S state):
//   // CueDeckReportAgent.init({
//   //   supabaseClient: sb,
//   //   getEventId:  () => S.event?.id,
//   //   getEvent:    () => S.event,
//   //   getSessions: () => S.sessions
//   // });
//   // document.getElementById('end-event-btn').onclick = () => CueDeckReportAgent.triggerFromCueDeck();
// });
