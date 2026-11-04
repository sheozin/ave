// checkin-theme.js: light/dark for the redesigned check-in pages (checkin-ui.css).
// The page sets data-theme on <html> before first paint from localStorage
// 'ck-theme'; with none saved it follows the system. The #theme button
// switches and remembers. Printing is always light.
export function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

export function initTheme(onChange = () => {}) {
  const btn = document.getElementById('theme');
  const show = () => {
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(isDark()));
    btn.querySelector('span').textContent = isDark() ? 'Light mode' : 'Dark mode';
  };
  const changed = () => { show(); onChange(); };
  if (btn) btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ck-theme', next); } catch (_) {}
    changed();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) changed();
  });
  let before = null;
  addEventListener('beforeprint', () => {
    before = document.documentElement.dataset.theme ?? '';
    document.documentElement.dataset.theme = 'light';
    onChange();
  });
  addEventListener('afterprint', () => {
    if (before === null) return;
    if (before) document.documentElement.dataset.theme = before; else delete document.documentElement.dataset.theme;
    before = null;
    onChange();
  });
  show();
}
