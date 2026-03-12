/**
 * ============================================================
 * CUEDECK AGENT MODULE 2 — CUE ANTICIPATION ENGINE
 * ============================================================
 * Watches the session timeline and fires a pre-cue modal
 * N minutes before each session transition with:
 *   - AI-generated prep checklist for that specific cue
 *   - Crew assignment suggestions
 *   - Systems to warm up / check
 *   - Countdown timer to cue
 *
 * HOW TO DROP IN:
 *   1. Add the CSS to your stylesheet
 *   2. Add the HTML once inside <body>
 *   3. Include this script
 *   4. Call: CueDeckCueEngine.init(sessionsArray, options)
 *   5. The engine auto-fires modals at the right time
 *
 * REQUIRES: window.CUEDECK_API_KEY = 'sk-ant-...'
 *
 * OPTIONS:
 *   {
 *     alertMinutesBefore: 8,          // how many minutes before session to fire (default 8)
 *     correctedNow: () => Date.now(), // pass CueDeck's correctedNow() for clock-sync accuracy
 *     cueDeckSessions: S.sessions,       // pass CueDeck's raw S.sessions — auto-adapts schema
 *   }
 *
 * sessions format (standard — or pass cueDeckSessions to auto-adapt):
 * [
 *   {
 *     id: 'session-1',
 *     title: 'Opening Keynote',
 *     startTime: '09:30',        // HH:MM 24hr
 *     location: 'Main Hall',
 *     systems: ['stream', 'pa', 'slides'],
 *     interpreters: ['Polish', 'German'],
 *     notes: 'VIP speaker, extra check on confidence monitor'
 *   }
 * ]
 *
 * CUEDECK INTEGRATION EXAMPLE:
 *   CueDeckCueEngine.init([], {
 *     alertMinutesBefore: 8,
 *     correctedNow: correctedNow,    // CueDeck's clock-synced fn
 *     cueDeckSessions: S.sessions       // auto-adapts scheduled_start / room fields
 *   });
 *   // Re-init after each loadSnapshot() to pick up new sessions:
 *   // CueDeckCueEngine.reinit(S.sessions);
 * ============================================================
 */

const CUE_ENGINE_CSS = `
#cuedeck-cue-overlay {
  display: none;
  position: fixed; inset: 0; z-index: 8900;
  background: rgba(0, 0, 0, 0.70);
  backdrop-filter: blur(4px);
  align-items: center; justify-content: center;
  animation: ce-fade 0.2s ease;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
}
#cuedeck-cue-overlay.active { display: flex; }

@keyframes ce-fade  { from { opacity: 0 } to { opacity: 1 } }
@keyframes ce-up    { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: translateY(0) } }
@keyframes ce-pulse-border { 0%,100%{border-color:rgba(249,115,22,0.25)} 50%{border-color:rgba(249,115,22,0.55)} }

#cuedeck-cue-modal {
  background: #111827;
  border: 1px solid rgba(249, 115, 22, 0.25);
  border-radius: 12px;
  width: 580px; max-width: 95vw; max-height: 90vh;
  display: flex; flex-direction: column;
  box-shadow: 0 0 40px rgba(249,115,22,0.10), 0 8px 32px rgba(0,0,0,0.60);
  animation: ce-up 0.22s ease, ce-pulse-border 2.5s ease-in-out infinite;
  position: relative; overflow: hidden;
}
#cuedeck-cue-modal::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
  border-radius: 12px 12px 0 0;
  background: linear-gradient(90deg, #F97316, rgba(249,115,22,0.15));
}

.ce-header {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 16px 20px 14px;
  border-bottom: 1px solid rgba(148,163,184,0.08);
}
.ce-cue-badge {
  background: rgba(249,115,22,0.12); border: 1px solid rgba(249,115,22,0.35);
  border-radius: 6px; padding: 5px 10px;
  font-size: 9px; font-weight: 700; color: #FDBA74;
  letter-spacing: 0.10em; white-space: nowrap; text-transform: uppercase;
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
}
.ce-title-block { flex: 1; min-width: 0; }
.ce-pre-label {
  font-size: 9px; font-weight: 700; letter-spacing: 0.12em; color: #FDBA74;
  text-transform: uppercase; margin-bottom: 3px;
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
}
.ce-title { font-size: 15px; font-weight: 700; color: #E5E7EB; line-height: 1.3; }
.ce-meta  { font-size: 11px; color: #6B7280; margin-top: 3px;
            font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ce-close { background: none; border: none; cursor: pointer; border-radius: 6px;
            color: #6B7280; font-size: 16px; padding: 4px 6px;
            transition: color 0.15s, background 0.15s; line-height: 1; }
.ce-close:hover { color: #E5E7EB; background: rgba(148,163,184,0.08); }

/* Countdown */
.ce-countdown-bar {
  padding: 10px 20px; background: rgba(0,0,0,0.15);
  border-bottom: 1px solid rgba(148,163,184,0.06);
  display: flex; align-items: center; justify-content: space-between;
}
.ce-countdown-label { font-size: 9px; font-weight: 700; letter-spacing: 0.10em;
                      color: #4B5563; text-transform: uppercase;
                      font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ce-countdown-timer {
  font-size: 22px; font-weight: 600; color: #FDBA74;
  letter-spacing: 0.08em; text-shadow: 0 0 12px rgba(249,115,22,0.35);
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
  font-variant-numeric: tabular-nums;
}
.ce-countdown-timer.urgent { color: #FF8B85; text-shadow: 0 0 12px rgba(255,59,48,0.35); animation: ce-blink 0.9s ease-in-out infinite; }
@keyframes ce-blink { 0%,100%{opacity:1} 50%{opacity:0.5} }
.ce-progress-track { height: 2px; background: rgba(249,115,22,0.08); }
.ce-progress-fill  { height: 100%; background: #F97316; transition: width 1s linear; }

.ce-body { padding: 16px 20px; flex: 1; overflow-y: auto; }
.ce-body::-webkit-scrollbar { width: 4px; }
.ce-body::-webkit-scrollbar-track { background: transparent; }
.ce-body::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.15); border-radius: 4px; }

.ce-thinking {
  display: flex; align-items: center; gap: 10px;
  font-size: 11px; color: #FDBA74; padding: 10px 0;
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
}
.ce-spinner {
  width: 14px; height: 14px; flex-shrink: 0;
  border: 2px solid rgba(249,115,22,0.20); border-top-color: #F97316;
  border-radius: 50%; animation: ce-spin 0.7s linear infinite;
}
@keyframes ce-spin { to { transform: rotate(360deg) } }

.ce-section-label {
  font-size: 9px; font-weight: 700; letter-spacing: 0.10em; color: #4B5563;
  text-transform: uppercase; margin-bottom: 8px; margin-top: 14px;
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
}
.ce-section-label:first-child { margin-top: 0; }
.ce-checklist { display: flex; flex-direction: column; gap: 6px; }
.ce-check-item {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 9px 12px; border-radius: 6px;
  background: rgba(255,255,255,0.025); border: 1px solid rgba(148,163,184,0.08);
  cursor: pointer; transition: background 0.12s, border-color 0.12s;
}
.ce-check-item:hover { background: rgba(255,255,255,0.045); border-color: rgba(148,163,184,0.15); }
.ce-check-item.done  { background: rgba(34,197,94,0.06); border-color: rgba(34,197,94,0.20); }
.ce-check-box {
  width: 14px; height: 14px; flex-shrink: 0; border-radius: 3px;
  border: 1px solid rgba(249,115,22,0.35); margin-top: 1px;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; color: #86EFAC; transition: all 0.15s;
}
.ce-check-item.done .ce-check-box { background: rgba(34,197,94,0.15); border-color: #22C55E; }
.ce-check-text { font-size: 12px; color: #D1D5DB; flex: 1; line-height: 1.45; }
.ce-check-item.done .ce-check-text { color: #86EFAC; opacity: 0.65; text-decoration: line-through; }
.ce-tag { font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 4px;
          flex-shrink: 0; height: fit-content; letter-spacing: 0.04em;
          font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ce-tag-crew   { background: rgba(59,130,246,0.12);  color: #60A5FA; }
.ce-tag-sys    { background: rgba(249,115,22,0.12);  color: #FDBA74; }
.ce-tag-interp { background: rgba(139,92,246,0.12);  color: #C4B5FD; }

/* API error notice */
.ce-api-error {
  display: none;
  font-size: 10px; color: #FDBA74;
  background: rgba(249,115,22,0.07); border: 1px solid rgba(249,115,22,0.20);
  border-radius: 6px; padding: 8px 12px; margin-bottom: 10px;
  font-family: 'SF Mono','Fira Code','Monaco',monospace;
}

.ce-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid rgba(148,163,184,0.08);
  background: rgba(0,0,0,0.15); border-radius: 0 0 12px 12px;
}
.ce-completion      { font-size: 10px; color: #6B7280;
                      font-family: 'SF Mono','Fira Code','Monaco',monospace; }
.ce-completion span { color: #86EFAC; }
.ce-btn { font-family: 'Inter', system-ui, -apple-system, sans-serif;
          font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
          padding: 7px 14px; border-radius: 6px; border: 1px solid transparent;
          cursor: pointer; transition: filter 0.12s, background 0.12s; }
.ce-btn-ready  { background: #F97316; border-color: #F97316; color: #0B0F14; }
.ce-btn-ready:hover { filter: brightness(1.1); }
.ce-btn-snooze { background: rgba(255,255,255,0.04); border-color: rgba(148,163,184,0.15); color: #6B7280; }
.ce-btn-snooze:hover { border-color: rgba(148,163,184,0.30); color: #9CA3AF; }
`;

const CUE_ENGINE_HTML = `
<div id="cuedeck-cue-overlay">
  <div id="cuedeck-cue-modal">
    <div class="ce-header">
      <div class="ce-cue-badge" id="ce-cue-badge">PRE-CUE ALERT</div>
      <div class="ce-title-block">
        <div class="ce-pre-label">Cue Anticipation Engine</div>
        <div class="ce-title" id="ce-title">Upcoming Session</div>
        <div class="ce-meta"  id="ce-meta">Loading...</div>
      </div>
      <button class="ce-close" onclick="CueDeckCueEngine.dismiss()">✕</button>
    </div>
    <div class="ce-countdown-bar">
      <div class="ce-countdown-label">TIME TO CUE</div>
      <div class="ce-countdown-timer" id="ce-timer">00:00</div>
    </div>
    <div class="ce-progress-track">
      <div class="ce-progress-fill" id="ce-progress" style="width:100%"></div>
    </div>
    <div class="ce-body">
      <div class="ce-api-error" id="ce-api-error"></div>
      <div class="ce-thinking" id="ce-thinking">
        <div class="ce-spinner"></div>
        Generating prep checklist for this session...
      </div>
      <div id="ce-content" style="display:none">
        <div class="ce-section-label">Pre-Cue Checklist — click to confirm each item</div>
        <div class="ce-checklist" id="ce-checklist"></div>
      </div>
    </div>
    <div class="ce-footer">
      <div class="ce-completion">Checked: <span id="ce-checked-count">0</span> / <span id="ce-total-count">0</span></div>
      <div style="display:flex;gap:8px">
        <button class="ce-btn ce-btn-snooze" onclick="CueDeckCueEngine.snooze()">SNOOZE 2 MIN</button>
        <button class="ce-btn ce-btn-ready"  onclick="CueDeckCueEngine.confirmReady()">✓ CUE READY</button>
      </div>
    </div>
  </div>
</div>
`;

const CueDeckCueEngine = (() => {

  // ═══════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════
  let sessions          = [];
  let alertMinutes      = 8;
  let timers            = [];
  let countdownInterval = null;
  let currentSession    = null;
  let _sessionTime      = null; // stored for snooze re-trigger
  let cueStartTime      = null;
  let totalSeconds      = 0;
  let _supabaseClient   = null;

  // Clock function — overridden with CueDeck's correctedNow() via options.correctedNow
  // Default: Date.now() (client time, may have skew — pass correctedNow for accuracy)
  let _nowFn = () => Date.now();

  // ═══════════════════════════════════════════════════
  // SESSION ADAPTER
  // Converts CueDeck's native S.sessions schema to CueEngine format:
  //   scheduled_start (ISO / 'HH:MM:SS') → startTime ('HH:MM')
  //   room                               → location
  //   status filter: skips ENDED/CANCELLED
  // ═══════════════════════════════════════════════════
  function adaptSessions(cueDeckSessions) {
    return (cueDeckSessions || [])
      .filter(s => s.status !== 'ENDED' && s.status !== 'CANCELLED')
      .map(s => {
        let startTime = s.scheduled_start || s.startTime || '';

        if (startTime.includes('T')) {
          // ISO timestamp: '2026-03-06T09:30:00Z' → extract HH:MM in local timezone
          const d = new Date(startTime);
          startTime = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        } else if (startTime.length >= 5) {
          // 'HH:MM:SS' or 'HH:MM' → take first 5 chars
          startTime = startTime.slice(0, 5);
        }

        return {
          id:           s.id,
          title:        s.title || 'Untitled Session',
          startTime,
          location:     s.room || s.location || 'TBC',
          systems:      s.systems || [],      // leod_sessions has no systems field — caller can enrich
          interpreters: s.interpreters || [], // leod_sessions has no interp field — caller can enrich
          notes:        s.notes || ''
        };
      })
      .filter(s => s.startTime && s.startTime.includes(':')); // drop sessions with invalid time
  }

  // ═══════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════
  function init(sessionsArray, options = {}) {
    alertMinutes     = options.alertMinutesBefore || 8;
    _supabaseClient  = options.supabaseClient || null;

    // Accept CueDeck's correctedNow() for clock-sync accuracy
    if (typeof options.correctedNow === 'function') {
      _nowFn = options.correctedNow;
    }

    const style = document.createElement('style');
    style.textContent = CUE_ENGINE_CSS;
    document.head.appendChild(style);

    const div = document.createElement('div');
    div.innerHTML = CUE_ENGINE_HTML;
    document.body.appendChild(div.firstElementChild);

    // Auto-adapt CueDeck sessions if provided via options
    if (options.cueDeckSessions) {
      sessions = adaptSessions(options.cueDeckSessions);
    } else {
      sessions = sessionsArray || [];
    }

    scheduleAll();
    console.log(`[CueDeck] Cue Engine initialized — watching ${sessions.length} sessions (alert ${alertMinutes} min before)`);
  }

  // ── Re-init with fresh CueDeck sessions (call after loadSnapshot) ──
  function reinit(cueDeckSessions) {
    sessions = adaptSessions(cueDeckSessions);
    scheduleAll();
    console.log(`[CueDeck] Cue Engine re-initialized — ${sessions.length} sessions scheduled`);
  }

  // ═══════════════════════════════════════════════════
  // SCHEDULE — sets setTimeout for each upcoming session
  // Uses _nowFn() instead of new Date() for clock accuracy
  // ═══════════════════════════════════════════════════
  function scheduleAll() {
    timers.forEach(clearTimeout);
    timers = [];

    const nowMs = _nowFn(); // corrected millisecond timestamp

    sessions.forEach(session => {
      const [h, m] = session.startTime.split(':').map(Number);
      if (isNaN(h) || isNaN(m)) return;

      // Build today's session timestamp using corrected clock as the base date
      const sessionDate = new Date(nowMs);
      sessionDate.setHours(h, m, 0, 0);
      const sessionMs = sessionDate.getTime();

      const alertMs       = sessionMs - alertMinutes * 60_000;
      const msUntilAlert  = alertMs - nowMs;

      if (msUntilAlert > 0) {
        const t = setTimeout(() => triggerCue(session, sessionDate), msUntilAlert);
        timers.push(t);
        console.log(`[CueDeck] Cue scheduled: "${session.title}" @ ${session.startTime} (alert in ${Math.round(msUntilAlert / 60000)} min)`);
      }
    });
  }

  // ═══════════════════════════════════════════════════
  // TRIGGER CUE — opens pre-cue modal
  // ═══════════════════════════════════════════════════
  async function triggerCue(session, sessionTime) {
    currentSession = session;
    _sessionTime   = sessionTime; // saved for snooze
    cueStartTime   = new Date(_nowFn());
    totalSeconds   = alertMinutes * 60;

    document.getElementById('ce-cue-badge').textContent = `PRE-CUE · ${alertMinutes} MIN WARNING`;
    document.getElementById('ce-title').textContent     = session.title;
    document.getElementById('ce-meta').textContent =
      `${session.startTime} · ${session.location || 'TBC'} · ${(session.systems || []).join(', ')}`;

    document.getElementById('ce-thinking').style.display = 'flex';
    document.getElementById('ce-content').style.display  = 'none';
    document.getElementById('ce-api-error').style.display = 'none';
    document.getElementById('cuedeck-cue-overlay').classList.add('active');

    startCountdown(sessionTime);
    await fetchCueChecklist(session);
  }

  // ═══════════════════════════════════════════════════
  // COUNTDOWN — uses _nowFn() for corrected time
  // ═══════════════════════════════════════════════════
  function startCountdown(sessionTime) {
    if (countdownInterval) clearInterval(countdownInterval);

    countdownInterval = setInterval(() => {
      const nowMs  = _nowFn();
      const diff   = Math.max(0, Math.floor((sessionTime.getTime() - nowMs) / 1000));
      const mins   = Math.floor(diff / 60);
      const secs   = diff % 60;
      const timerEl = document.getElementById('ce-timer');
      timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      timerEl.className   = 'ce-countdown-timer' + (diff < 120 ? ' urgent' : '');

      const elapsed = (nowMs - cueStartTime.getTime()) / 1000;
      const pct     = Math.max(0, 100 - (elapsed / totalSeconds) * 100);
      document.getElementById('ce-progress').style.width = pct + '%';

      if (diff === 0) clearInterval(countdownInterval);
    }, 1000);
  }

  // ═══════════════════════════════════════════════════
  // CLAUDE API — fetch tailored checklist
  // ═══════════════════════════════════════════════════
  async function fetchCueChecklist(session) {
    if (!_supabaseClient) { renderFallbackChecklist(session); return; }

    const prompt = `You are an AV production manager for live corporate conferences. Generate a pre-cue checklist for the upcoming session.

Session: ${session.title}
Start Time: ${session.startTime}
Location: ${session.location || 'Main Hall'}
AV Systems: ${(session.systems || []).join(', ') || 'Standard PA, slides, streaming'}
Interpretation Languages: ${(session.interpreters || []).join(', ') || 'None'}
Notes: ${session.notes || 'None'}
Time until cue: ${alertMinutes} minutes

Respond ONLY with valid JSON, no markdown:
{
  "checklist": [
    { "task": "task description", "tag": "crew|system|interp", "assignee": "optional role name" },
    ...
  ]
}
Generate 6-8 specific, actionable items.`;

    try {
      const { data, error } = await _supabaseClient.functions.invoke('ai-proxy', {
        body: {
          model:      'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages:   [{ role: 'user', content: prompt }]
        }
      });

      if (error) throw new Error(error.message);

      const text   = data?.content?.[0]?.text || '';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      renderChecklist(parsed.checklist);

    } catch (e) {
      console.warn('[CueDeck] Cue Engine API error:', e.message);
      const errEl = document.getElementById('ce-api-error');
      errEl.textContent = `AI unavailable (${e.message}) — showing standard checklist`;
      errEl.style.display = 'block';
      renderFallbackChecklist(session);
    }
  }

  // ═══════════════════════════════════════════════════
  // RENDER CHECKLIST
  // ═══════════════════════════════════════════════════
  function renderChecklist(items) {
    document.getElementById('ce-thinking').style.display = 'none';
    document.getElementById('ce-content').style.display  = 'block';

    const list = document.getElementById('ce-checklist');
    list.innerHTML = '';
    document.getElementById('ce-total-count').textContent   = items.length;
    document.getElementById('ce-checked-count').textContent = '0';

    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'ce-check-item';

      const tagClass = item.tag === 'crew' ? 'ce-tag-crew' : item.tag === 'interp' ? 'ce-tag-interp' : 'ce-tag-sys';
      const tagLabel = item.assignee || (item.tag === 'crew' ? 'CREW' : item.tag === 'interp' ? 'INTERP' : 'SYSTEM');

      el.innerHTML = `
        <div class="ce-check-box"></div>
        <span class="ce-check-text">${_esc(item.task)}</span>
        <span class="ce-tag ${tagClass}">${_esc(tagLabel)}</span>
      `;

      el.onclick = () => {
        el.classList.toggle('done');
        el.querySelector('.ce-check-box').textContent = el.classList.contains('done') ? '✓' : '';
        _updateCount();
      };

      list.appendChild(el);
    });
  }

  function renderFallbackChecklist(session) {
    const defaults = [
      { task: `Confirm ${session.location} PA system is powered and levels set`, tag: 'system' },
      { task: 'Test confidence monitor and presenter clicker / advancer', tag: 'system' },
      { task: 'Verify slide deck is loaded and on the correct opening slide', tag: 'system' },
      { task: 'Check streaming encoder is running and bitrate is stable', tag: 'system', assignee: 'STREAM' },
      { task: 'Confirm presenter microphone pack is charged and live', tag: 'crew', assignee: 'AUDIO' },
      {
        task: session.interpreters?.length
          ? `Booth check — ${session.interpreters.join(', ')} channels active`
          : 'Confirm no interpretation is required for this session',
        tag: 'interp'
      },
      { task: `Signal stage manager — ready for intro in ${alertMinutes} min`, tag: 'crew', assignee: 'STAGE' }
    ];
    renderChecklist(defaults);
  }

  function _updateCount() {
    const done = document.querySelectorAll('#ce-checklist .ce-check-item.done').length;
    document.getElementById('ce-checked-count').textContent = done;
  }

  // ═══════════════════════════════════════════════════
  // ACTIONS
  // ═══════════════════════════════════════════════════
  function dismiss() {
    if (countdownInterval) clearInterval(countdownInterval);
    document.getElementById('cuedeck-cue-overlay').classList.remove('active');
  }

  function confirmReady() {
    console.log(`[CueDeck] Cue confirmed ready: ${currentSession?.title}`);
    dismiss();
  }

  function snooze() {
    dismiss();
    // Re-trigger after 2 min, using stored _sessionTime (not currentSession.startTime string)
    setTimeout(() => {
      if (currentSession && _sessionTime) {
        triggerCue(currentSession, _sessionTime);
      }
    }, 2 * 60 * 1000);
  }

  // ─── Helpers ──────────────────────────────────────
  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { init, reinit, triggerCue, adaptSessions, dismiss, confirmReady, snooze };
})();

// ── DEMO ──
// document.addEventListener('DOMContentLoaded', () => {
//   window.CUEDECK_API_KEY = 'sk-ant-YOUR-KEY';
//
//   // Standard usage:
//   CueDeckCueEngine.init([
//     {
//       id: 's1',
//       title: 'Panel Discussion – AI & Future',
//       startTime: '10:30',
//       location: 'Main Hall',
//       systems: ['Stream', 'PA', 'Confidence Monitor', 'LED Wall'],
//       interpreters: ['Polish', 'German'],
//       notes: 'Four panelists, all wireless mics. Record to NAS.'
//     }
//   ], { alertMinutesBefore: 8 });
//
//   // CueDeck integrated usage (pass correctedNow + S.sessions):
//   // CueDeckCueEngine.init([], {
//   //   alertMinutesBefore: 8,
//   //   correctedNow: correctedNow,
//   //   cueDeckSessions: S.sessions
//   // });
// });
