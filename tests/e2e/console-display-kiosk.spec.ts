// tests/e2e/console-display-kiosk.spec.ts
// The Displays window's pairing help says how to get a screen into full
// screen at power-on: install as an app, a kiosk browser on Android TV, or
// Chrome with --kiosk on a mini PC. In en, ar, pl and de, without em-dashes.
import { test, expect } from '@playwright/test';

const BASE = process.env.CONSOLE_BASE || 'http://127.0.0.1:7230';

const EXPECT: Record<string, string[]> = {
  en: ['Full screen at power-on', 'Install or Add to home screen', 'Fully Kiosk Browser', '--kiosk'],
  ar: ['ملء الشاشة عند التشغيل', 'إضافة إلى الشاشة الرئيسية', 'Fully Kiosk Browser', '--kiosk'],
  pl: ['Pełny ekran po włączeniu', 'Dodaj do ekranu głównego', 'Fully Kiosk Browser', '--kiosk'],
  de: ['Vollbild beim Einschalten', 'Zum Startbildschirm hinzufügen', 'Fully Kiosk Browser', '--kiosk'],
};

for (const [lang, parts] of Object.entries(EXPECT)) {
  test(`Displays help explains full screen at power-on (${lang})`, async ({ page }) => {
    await page.addInitScript((l: string) => localStorage.setItem('cuedeck_locale', l), lang);
    await page.route(u => /(^|\.)supabase\.co$/.test(u.hostname), route =>
      route.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '{}' }));
    await page.goto(`${BASE}/cuedeck-console.html`);
    await page.evaluate(`S.event = { id: 'e1', name: 'Probe event' }; S.userRole = 'director'; S.displays = []; renderSignagePanel();`);
    const help = page.locator('#sp-kiosk-help');
    await expect(help).toHaveCount(1);
    const text = (await help.textContent()) || '';
    for (const p of parts) expect(text, p).toContain(p);
    expect(text).not.toContain('—');
    // the start-up command is shown with the real display URL
    expect(text).toContain('https://app.cuedeck.io/d');
  });
}
