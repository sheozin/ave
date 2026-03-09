/**
 * ============================================================
 * CUEDECK AGENT MODULE 1 — INCIDENT ADVISOR
 * ============================================================
 * Watches technical warnings and fires a modal with:
 *   - AI-generated diagnosis
 *   - Step-by-step resolution actions
 *   - Estimated fix time
 *   - Escalation option
 *
 * HOW TO DROP IN:
 *   1. Add the CSS block to your stylesheet (or <style> tag)
 *   2. Add the HTML block once inside your <body>
 *   3. Include this <script> or import the JS
 *   4. Call: CueDeckIncidentAdvisor.init(options)
 *   5. Trigger manually: CueDeckIncidentAdvisor.trigger(incidentObject)
 *   6. Auto-trigger: CueDeckIncidentAdvisor.watch(systemsArray) on each realtime update
 *
 * REQUIRES: window.CUEDECK_API_KEY = 'sk-ant-...'
 *
 * OPTIONS (all optional):
 *   {
 *     supabaseClient: sb,             // Supabase JS client — logs to leod_event_log
 *     getEventId:  () => S.event?.id, // fn → current event UUID
 *     getRole:     () => S.role,      // fn → current operator role string
 *     onEscalate:  (incident) => {},  // custom escalation callback (e.g. send broadcast)
 *   }
 *
 * CUEDECK INTEGRATION EXAMPLE:
 *   // In your Supabase realtime handler:
 *   CueDeckIncidentAdvisor.init({
 *     supabaseClient: sb,
 *     getEventId:  () => S.event?.id,
 *     getRole:     () => S.role,
 *     onEscalate:  (inc) => sendBroadcast(`ESCALATION: ${inc.system} at ${inc.location}`)
 *   });
 *   // Then in your realtime subscription:
 *   .on('postgres_changes', ..., payload => {
 *     CueDeckIncidentAdvisor.watch([payload.new]);
 *   })
 * ============================================================
 */

// ─── CSS ─────────────────────────────────────────────────────
const INCIDENT_ADVISOR_CSS = `
#cuedeck-incident-overlay {
  display: none;
  position: fixed; inset: 0; z-index: 9000;
  background: rgba(0, 0, 0, 0.70);
  backdrop-filter: blur(4px);
  align-items: center; justify-content: center;
  animation: ia-fade-in 0.2s ease;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
}
#cuedeck-incident-overlay.active { display: flex; }

@keyframes ia-fade-in  { from { opacity: 0 } to { opacity: 1 } }
@keyframes ia-slide-up { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: translateY(0) } }

#cuedeck-incident-modal {
  background: #111827;
  border: 1px solid rgba(255, 59, 48, 0.30);
  border-radius: 12px;
  width: 560px; max-width: 95vw; max-height: 90vh;
  display: flex; flex-direction: column;
  box-shadow: 0 0 40px rgba(255, 59, 48, 0.12), 0 8px 32px rgba(0,0,0,0.60);
  animation: ia-slide-up 0.22s ease;
  position: relative; overflow: hidden;
}
#cuedeck-incident-modal::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
  border-radius: 12px 12px 0 0;
  background: linear-gradient(90deg, #FF3B30, rgba(255,59,48,0.15));
}

.ia-header {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid rgba(148,163,184,0.08);
}
.ia-alert-icon {
  width: 36px; height: 36px; flex-shrink: 0; border-radius: 8px;
  background: rgba(255, 59, 48, 0.12);
  border: 1px solid rgba(255, 59, 48, 0.30);
  display: flex; align-items: center; justify-content: center;
  font-size: 16px;
}
.ia-title-block { flex: 1; min-width: 0; }
.ia-label {
  font-size: 9px; font-weight: 700; letter-spacing: 0.12em; color: #FF8B85;
  text-transform: uppercase; margin-bottom: 3px;
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
}
.ia-title {
  font-size: 15px; font-weight: 700; color: #E5E7EB; line-height: 1.3;
}
.ia-meta {
  font-size: 11px; color: #6B7280; margin-top: 3px;
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
}
.ia-close {
  background: none; border: none; cursor: pointer; border-radius: 6px;
  color: #6B7280; font-size: 16px; padding: 4px 6px; transition: color 0.15s, background 0.15s; line-height: 1;
}
.ia-close:hover { color: #E5E7EB; background: rgba(148,163,184,0.08); }

.ia-body { padding: 16px 20px; flex: 1; overflow-y: auto; }
.ia-body::-webkit-scrollbar { width: 4px; }
.ia-body::-webkit-scrollbar-track { background: transparent; }
.ia-body::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.15); border-radius: 4px; }

.ia-thinking {
  display: flex; align-items: center; gap: 10px;
  font-size: 11px; color: #60A5FA; padding: 12px 0;
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
}
.ia-spinner {
  width: 15px; height: 15px; flex-shrink: 0;
  border: 2px solid rgba(96,165,250,0.20); border-top-color: #60A5FA;
  border-radius: 50%; animation: ia-spin 0.7s linear infinite;
}
@keyframes ia-spin { to { transform: rotate(360deg) } }

/* API error notice (non-blocking — shown above fallback content) */
.ia-api-error {
  display: none;
  font-size: 10px; color: #FDBA74;
  background: rgba(249,115,22,0.07); border: 1px solid rgba(249,115,22,0.20);
  border-radius: 6px; padding: 8px 12px; margin-bottom: 12px;
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
}

.ia-diagnosis {
  font-size: 12px; color: #9CA3AF; line-height: 1.65;
  background: rgba(0,0,0,0.20); border: 1px solid rgba(148,163,184,0.08);
  border-radius: 6px; padding: 12px 14px; margin-bottom: 14px;
}
.ia-section-label {
  font-size: 9px; font-weight: 700; letter-spacing: 0.10em; color: #4B5563;
  text-transform: uppercase; margin-bottom: 8px;
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
}
.ia-steps { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.ia-step {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 9px 12px; border-radius: 6px;
  background: rgba(255,255,255,0.025); border: 1px solid rgba(148,163,184,0.08);
  cursor: pointer; transition: background 0.12s, border-color 0.12s;
}
.ia-step:hover  { background: rgba(255,255,255,0.045); border-color: rgba(148,163,184,0.15); }
.ia-step.done   { background: rgba(34,197,94,0.06); border-color: rgba(34,197,94,0.20); }
.ia-step-num    { font-size: 10px; color: #60A5FA; width: 16px; flex-shrink: 0; padding-top: 1px;
                  font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ia-step.done .ia-step-num  { color: #86EFAC; }
.ia-step-text   { font-size: 12px; color: #D1D5DB; flex: 1; line-height: 1.45; }
.ia-step.done .ia-step-text { color: #86EFAC; text-decoration: line-through; opacity: 0.6; }
.ia-step-check  { color: #86EFAC; font-size: 13px; opacity: 0; transition: opacity 0.2s; }
.ia-step.done .ia-step-check { opacity: 1; }

.ia-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid rgba(148,163,184,0.08);
  background: rgba(0,0,0,0.15); border-radius: 0 0 12px 12px;
}
.ia-eta      { font-size: 10px; color: #6B7280; font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ia-eta span { color: #FDBA74; }
.ia-actions  { display: flex; gap: 8px; }
.ia-btn {
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
  padding: 7px 14px; border-radius: 6px; border: 1px solid transparent;
  cursor: pointer; transition: filter 0.12s, background 0.12s;
}
.ia-btn-resolve  { background: #22C55E; border-color: #22C55E; color: #0B0F14; }
.ia-btn-resolve:hover  { filter: brightness(1.1); }
.ia-btn-escalate { background: rgba(255,59,48,0.10); border-color: rgba(255,59,48,0.35); color: #FF8B85; }
.ia-btn-escalate:hover { background: rgba(255,59,48,0.18); }

/* Status banners — shown instead of browser alert() */
.ia-status-banner {
  display: none; padding: 10px 14px; margin-bottom: 14px; border-radius: 6px;
  font-size: 11px; font-weight: 600; text-align: center; letter-spacing: 0.04em;
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
}
.ia-status-banner.resolve  { background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.25); color: #86EFAC; }
.ia-status-banner.escalate { background: rgba(255,59,48,0.08); border: 1px solid rgba(255,59,48,0.25); color: #FF8B85; }
`;

// ─── HTML TEMPLATE ────────────────────────────────────────────
const INCIDENT_ADVISOR_HTML = `
<div id="cuedeck-incident-overlay">
  <div id="cuedeck-incident-modal">
    <div class="ia-header">
      <div class="ia-alert-icon">⚠</div>
      <div class="ia-title-block">
        <div class="ia-label">Incident Advisor · Auto-Triggered</div>
        <div class="ia-title" id="ia-incident-title">Technical Issue Detected</div>
        <div class="ia-meta"  id="ia-incident-meta">Loading details...</div>
      </div>
      <button class="ia-close" onclick="CueDeckIncidentAdvisor.close()">✕</button>
    </div>
    <div class="ia-body">
      <div class="ia-status-banner resolve"   id="ia-resolved-banner">✓ INCIDENT MARKED RESOLVED — LOG ENTRY SAVED</div>
      <div class="ia-status-banner escalate"  id="ia-escalated-banner">⬆ INCIDENT ESCALATED — SENIOR TECHNICIAN NOTIFIED</div>
      <div class="ia-api-error" id="ia-api-error"></div>
      <div class="ia-thinking" id="ia-thinking">
        <div class="ia-spinner"></div>
        Analyzing incident and generating response plan...
      </div>
      <div id="ia-content" style="display:none">
        <div class="ia-section-label">Diagnosis</div>
        <div class="ia-diagnosis" id="ia-diagnosis"></div>
        <div class="ia-section-label">Resolution Steps — click to check off</div>
        <div class="ia-steps"    id="ia-steps"></div>
      </div>
    </div>
    <div class="ia-footer">
      <div class="ia-eta">Est. resolution: <span id="ia-eta">—</span></div>
      <div class="ia-actions">
        <button class="ia-btn ia-btn-escalate" onclick="CueDeckIncidentAdvisor.escalate()">⬆ ESCALATE</button>
        <button class="ia-btn ia-btn-resolve"  onclick="CueDeckIncidentAdvisor.resolve()">✓ MARK RESOLVED</button>
      </div>
    </div>
  </div>
</div>
`;

// ─── JAVASCRIPT MODULE ────────────────────────────────────────
const CueDeckIncidentAdvisor = (() => {

  // ═══════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════
  let currentIncident = null;
  let incidentLog     = [];
  let _opts           = {};

  // Deduplication — prevents modal spam when watch() is called on every realtime tick
  const _seen             = new Map(); // key: "system::location" → last trigger timestamp
  const INCIDENT_COOLDOWN = 60_000;    // ms — 60s cooldown per unique system+location

  // ═══════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════
  function init(options = {}) {
    _opts = options; // { supabaseClient, getEventId, getRole, onEscalate }

    const style = document.createElement('style');
    style.textContent = INCIDENT_ADVISOR_CSS;
    document.head.appendChild(style);

    const div = document.createElement('div');
    div.innerHTML = INCIDENT_ADVISOR_HTML;
    document.body.appendChild(div.firstElementChild);

    console.log('[CueDeck] Incident Advisor initialized');
  }

  // ═══════════════════════════════════════════════════
  // TRIGGER — opens modal for a given incident
  // incidentObject: { system, location, severity, description, timestamp }
  // ═══════════════════════════════════════════════════
  async function trigger(incident) {
    currentIncident = incident;

    _el('ia-incident-title').textContent =
      `${incident.system} — ${incident.severity || 'Warning'} Detected`;
    _el('ia-incident-meta').textContent =
      `${incident.location || 'Unknown location'} · ${incident.timestamp || new Date().toLocaleTimeString()}`;

    _show('ia-thinking');
    _hide('ia-content');
    _hide('ia-resolved-banner');
    _hide('ia-escalated-banner');
    _hide('ia-api-error');
    _el('ia-eta').textContent = '—';

    _el('cuedeck-incident-overlay').classList.add('active');
    await _fetchAIAdvice(incident);
  }

  // ═══════════════════════════════════════════════════
  // CLAUDE API CALL
  // ═══════════════════════════════════════════════════
  async function _fetchAIAdvice(incident) {
    const apiKey = window.CUEDECK_API_KEY;
    if (!apiKey) { _renderFallback(incident); return; }

    const prompt = `You are an AV technical expert for live corporate events. An incident has been detected during a live conference.

Incident Details:
- System: ${incident.system}
- Location: ${incident.location || 'Not specified'}
- Severity: ${incident.severity || 'Warning'}
- Description: ${incident.description || 'No description provided'}
- Time: ${incident.timestamp || 'Just now'}

Respond ONLY with valid JSON in this exact format, no markdown:
{
  "diagnosis": "2-3 sentence technical diagnosis of what is likely happening and why",
  "steps": ["action 1", "action 2", "action 3", "action 4"],
  "eta_minutes": 5
}`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-allow-browser': 'true'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data   = await res.json();
      const text   = data.content?.[0]?.text || '';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      _renderAdvice(parsed);

    } catch (e) {
      console.warn('[CueDeck] Incident Advisor API error:', e.message);
      const errEl = _el('ia-api-error');
      errEl.textContent = `AI unavailable (${e.message}) — showing standard protocol`;
      errEl.style.display = 'block';
      _renderFallback(incident);
    }
  }

  // ═══════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════
  function _renderAdvice(data) {
    _hide('ia-thinking');
    _show('ia-content');
    _el('ia-diagnosis').textContent  = data.diagnosis || '';
    _el('ia-eta').textContent        = data.eta_minutes ? `~${data.eta_minutes} min` : '—';

    const stepsEl = _el('ia-steps');
    stepsEl.innerHTML = '';
    (data.steps || []).forEach((step, i) => {
      const el = document.createElement('div');
      el.className = 'ia-step';
      el.innerHTML = `
        <span class="ia-step-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="ia-step-text">${_esc(step)}</span>
        <span class="ia-step-check">✓</span>
      `;
      el.onclick = () => el.classList.toggle('done');
      stepsEl.appendChild(el);
    });
  }

  function _renderFallback(incident) {
    _renderAdvice({
      diagnosis: `${incident.system} has reported a ${incident.severity || 'warning'} condition at ${incident.location}. Manual inspection required — check power, connections, and signal path.`,
      steps: [
        'Physically inspect the affected unit and all connected cables',
        'Check signal path from source to output — look for patching errors',
        'Attempt soft restart of the affected system module',
        'Switch to backup unit if available and issue persists'
      ],
      eta_minutes: 5
    });
  }

  // ═══════════════════════════════════════════════════
  // CLOSE
  // ═══════════════════════════════════════════════════
  function close() {
    _el('cuedeck-incident-overlay').classList.remove('active');
  }

  // ═══════════════════════════════════════════════════
  // RESOLVE — logs to leod_event_log if Supabase configured
  // ═══════════════════════════════════════════════════
  async function resolve() {
    const entry = { ...currentIncident, resolved: true, resolvedAt: new Date().toISOString() };
    incidentLog.push(entry);

    if (_opts.supabaseClient && _opts.getEventId) {
      try {
        await _opts.supabaseClient.from('leod_event_log').insert({
          event_id:      _opts.getEventId(),
          session_id:    null,
          system:        'incident-advisor',
          action:        'INCIDENT_RESOLVED',
          details:       JSON.stringify(entry),
          operator_role: _opts.getRole ? _opts.getRole() : 'unknown'
        });
      } catch (e) {
        console.warn('[CueDeck] Incident Advisor: Supabase log failed:', e.message);
      }
    }

    _el('ia-resolved-banner').style.display = 'block';
    setTimeout(close, 1800);
  }

  // ═══════════════════════════════════════════════════
  // ESCALATE — in-modal banner instead of browser alert()
  // ═══════════════════════════════════════════════════
  async function escalate() {
    const entry = { ...currentIncident, escalated: true, escalatedAt: new Date().toISOString() };
    incidentLog.push(entry);

    if (_opts.supabaseClient && _opts.getEventId) {
      try {
        await _opts.supabaseClient.from('leod_event_log').insert({
          event_id:      _opts.getEventId(),
          session_id:    null,
          system:        'incident-advisor',
          action:        'INCIDENT_ESCALATED',
          details:       JSON.stringify(entry),
          operator_role: _opts.getRole ? _opts.getRole() : 'unknown'
        });
      } catch (e) {
        console.warn('[CueDeck] Incident Advisor: Supabase log failed:', e.message);
      }
    }

    // In-modal banner — no disruptive browser alert()
    _el('ia-escalated-banner').style.display = 'block';

    // Custom escalation handler (e.g. CueDeck broadcast, Slack webhook)
    if (typeof _opts.onEscalate === 'function') {
      _opts.onEscalate(entry);
    } else {
      console.warn('[CueDeck ESCALATION]', entry.system, '@', entry.location, entry.escalatedAt);
    }

    setTimeout(close, 2500);
  }

  // ═══════════════════════════════════════════════════
  // WATCH — auto-trigger on systems array, with deduplication cooldown
  // systemsArray: [{ id, system, location, status, description }]
  // Call on each Supabase realtime update — cooldown prevents modal spam.
  // ═══════════════════════════════════════════════════
  function watch(systemsArray) {
    const now = Date.now();
    systemsArray.forEach(s => {
      if (s.status !== 'warning' && s.status !== 'error' && s.status !== 'critical') return;

      // Deduplicate: skip if same system+location triggered within cooldown window
      const key = `${s.system || s.id}::${s.location || ''}`;
      if (now - (_seen.get(key) || 0) < INCIDENT_COOLDOWN) return;
      _seen.set(key, now);

      trigger({
        system:      s.system || s.id,
        location:    s.location,
        severity:    s.status === 'critical' ? 'Critical' : s.status === 'error' ? 'Error' : 'Warning',
        description: s.description || `${s.system} status changed to ${s.status}`,
        timestamp:   new Date().toLocaleTimeString()
      });
    });
  }

  // ═══════════════════════════════════════════════════
  // GET LOG — returns resolved/escalated incident array
  // Used by Report Agent to build end-of-event report.
  // ═══════════════════════════════════════════════════
  function getLog() { return incidentLog; }

  // ─── DOM helpers ──────────────────────────────────
  function _el(id)    { return document.getElementById(id); }
  function _show(id)  { _el(id).style.display = 'flex'; }
  function _hide(id)  { _el(id).style.display = 'none'; }
  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { init, trigger, watch, close, resolve, escalate, getLog };
})();

// ── DEMO: Uncomment to test in browser ──
// document.addEventListener('DOMContentLoaded', () => {
//   window.CUEDECK_API_KEY = 'sk-ant-YOUR-KEY-HERE';
//   CueDeckIncidentAdvisor.init();
//   setTimeout(() => {
//     CueDeckIncidentAdvisor.trigger({
//       system: 'Hall B PA System',
//       location: 'Main Stage Left',
//       severity: 'Warning',
//       description: 'Monitor speaker distortion detected at 80Hz range, possible amp clipping',
//       timestamp: new Date().toLocaleTimeString()
//     });
//   }, 500);
// });
