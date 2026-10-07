// supabase/functions/_shared/email-i18n.ts
// Guest emails in the guest's language (migration 123): confirmation, QR
// ticket, plus-one ticket, reminder, thank-you and invitation. English is the
// source text and the fallback; keys are the English text, {name}-style
// placeholders are filled by et(). Values filled in are escaped by the
// templates, never here. tests/email-i18n.spec.ts fails when a template uses
// a string missing in any language.

export type Lang = 'en' | 'pl' | 'de' | 'ar'
export const LANGS: Lang[] = ['en', 'pl', 'de', 'ar']
export const isLang = (x: unknown): x is Lang => typeof x === 'string' && (LANGS as string[]).includes(x)
export const dirOf = (l: Lang) => (l === 'ar' ? 'rtl' : 'ltr')
// The list separator: Arabic has its own comma.
export const sepOf = (l: Lang) => (l === 'ar' ? '، ' : ', ')
// Organizer text is dir="auto" (its own punctuation) but lines up with the email.
export const alignOf = (l: Lang) => (l === 'ar' ? 'right' : 'left')

export function et(lang: Lang, text: string, vars?: Record<string, string | number>): string {
  const s = (lang !== 'en' && DICT[lang]?.[text]) || text
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s
}

// "Sunday 18 October" in the guest's language (the calendar date, in UTC).
export function emailDate(lang: Lang, iso: string | null, withYear = false): string {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : lang,
    { weekday: 'long', day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
}

// The time zone's own name in the guest's language ("Central European Time").
export function zoneName(lang: Lang, tz: string | null): string {
  if (!tz) return ''
  try {
    const n = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang, { timeZone: tz, timeZoneName: 'longGeneric' })
      .formatToParts(new Date()).find(x => x.type === 'timeZoneName')
    return n?.value ?? ''
  } catch { return '' }
}

// The language for each address: the guest's own, else the event's fixed
// page language, else English (checkin_web_langs). A failed lookup is
// English, never a failed send.
// deno-lint-ignore no-explicit-any
export async function langsFor(sb: any, eventId: string, emails: string[]): Promise<Map<string, Lang>> {
  const out = new Map<string, Lang>()
  const list = [...new Set(emails.filter(Boolean).map(e => e.toLowerCase()))]
  if (!list.length) return out
  const { data, error } = await sb.rpc('checkin_web_langs', { p_event_id: eventId, p_emails: list })
  if (error) { console.error('email-i18n: language lookup failed', error.code); return out }
  for (const r of (data ?? []) as { email: string; lang: string }[]) if (isLang(r.lang)) out.set(String(r.email).toLowerCase(), r.lang)
  return out
}

export const DICT: Record<Exclude<Lang, 'en'>, Record<string, string>> = {
  pl: {
    'Your check-in QR code: {event}': 'Twój kod QR do wejścia: {event}',
    'Hi {name},': 'Cześć {name},',
    'Show this QR code at the entrance to check in. No need to print anything: your phone screen works fine.': 'Pokaż ten kod QR przy wejściu. Nie musisz niczego drukować: wystarczy ekran telefonu.',
    'Lost this email? Just show your name at the entrance instead.': 'Zgubiłeś(-aś) tego e-maila? Wystarczy podać imię i nazwisko przy wejściu.',
    'Ticket for {name}: {event}': 'Bilet dla {name}: {event}',
    'This is the check-in QR code for {guest}, who is coming with you. Forward it to them, or show it at the entrance together.': 'To kod QR do wejścia dla osoby {guest}, która przychodzi z Tobą. Prześlij go tej osobie albo pokażcie go razem przy wejściu.',
    'Check-in powered by': 'Obsługa wejścia:',
    'Your check-in QR code': 'Twój kod QR do wejścia',
    'Confirm your registration': 'Potwierdź rejestrację',
    'the event': 'wydarzenie',
    'Someone asked to register this email address for {event}.': 'Ktoś poprosił o rejestrację tego adresu e-mail na wydarzenie {event}.',
    'If it was you, confirm here to get your check-in QR code:': 'Jeśli to Ty, potwierdź tutaj, aby otrzymać kod QR do wejścia:',
    'If it was not you, ignore this email. Nothing is registered unless the link is used, and the request is deleted after 48 hours.': 'Jeśli to nie Ty, zignoruj tego e-maila. Nic nie zostanie zarejestrowane bez użycia linku, a prośba zostanie usunięta po 48 godzinach.',
    'Someone asked to register this email address for this event. If it was you, confirm to get your check-in QR code.': 'Ktoś poprosił o rejestrację tego adresu e-mail na to wydarzenie. Jeśli to Ty, potwierdź, aby otrzymać kod QR do wejścia.',
    'Confirm my registration': 'Potwierdzam rejestrację',
    'If it was not you, ignore this email. Nothing is registered unless the button is used, and the request is deleted after 48 hours.': 'Jeśli to nie Ty, zignoruj tego e-maila. Nic nie zostanie zarejestrowane bez użycia przycisku, a prośba zostanie usunięta po 48 godzinach.',
    'Registration by': 'Rejestracja:',
    'See you soon': 'Do zobaczenia',
    'Hi {name}, this is a reminder that you are registered.': 'Cześć {name}, przypominamy, że jesteś zarejestrowany(-a).',
    'When': 'Kiedy',
    'Where': 'Gdzie',
    'Open in Maps': 'Otwórz w Mapach',
    'From the organizer': 'Od organizatora',
    'Show this at the entrance. The code works if the QR will not scan.': 'Pokaż to przy wejściu. Jeśli kod QR się nie zeskanuje, wystarczy kod.',
    '{date}, doors open {time}': '{date}, wejście od {time}',
    'Reminder: {event}, {date}': 'Przypomnienie: {event}, {date}',
    'Thank you for coming': 'Dziękujemy za przybycie',
    'Hi {name}, thank you for joining us on {date}.': 'Cześć {name}, dziękujemy, że byłeś(-aś) z nami: {date}.',
    'Open the link': 'Otwórz link',
    'Thank you for coming to {event}': 'Dziękujemy za udział w wydarzeniu {event}',
    'You are invited': 'Zapraszamy',
    'Hi {name}, we would love to see you there. Please let us know if you can come.': 'Cześć {name}, bardzo chcielibyśmy Cię zobaczyć. Daj nam znać, czy przyjdziesz.',
    'Reply to the invitation': 'Odpowiedz na zaproszenie',
    'This link is personal to you. Your ticket arrives by email once you say you are coming.': 'Ten link jest tylko dla Ciebie. Bilet przyjdzie e-mailem, gdy potwierdzisz udział.',
    'Invitations powered by': 'Zaproszenia:',
    'You are invited: {event}': 'Zaproszenie: {event}',
  },
  de: {
    'Your check-in QR code: {event}': 'Ihr QR-Code für den Einlass: {event}',
    'Hi {name},': 'Hallo {name},',
    'Show this QR code at the entrance to check in. No need to print anything: your phone screen works fine.': 'Zeigen Sie diesen QR-Code am Eingang. Sie müssen nichts ausdrucken: Ihr Handydisplay genügt.',
    'Lost this email? Just show your name at the entrance instead.': 'E-Mail verloren? Nennen Sie einfach Ihren Namen am Eingang.',
    'Ticket for {name}: {event}': 'Ticket für {name}: {event}',
    'This is the check-in QR code for {guest}, who is coming with you. Forward it to them, or show it at the entrance together.': 'Dies ist der QR-Code für {guest}, die oder der mit Ihnen kommt. Leiten Sie ihn weiter oder zeigen Sie ihn gemeinsam am Eingang.',
    'Check-in powered by': 'Einlass mit',
    'Your check-in QR code': 'Ihr QR-Code für den Einlass',
    'Confirm your registration': 'Bestätigen Sie Ihre Anmeldung',
    'the event': 'die Veranstaltung',
    'Someone asked to register this email address for {event}.': 'Jemand möchte diese E-Mail-Adresse für {event} anmelden.',
    'If it was you, confirm here to get your check-in QR code:': 'Wenn Sie das waren, bestätigen Sie hier, um Ihren QR-Code zu erhalten:',
    'If it was not you, ignore this email. Nothing is registered unless the link is used, and the request is deleted after 48 hours.': 'Wenn Sie es nicht waren, ignorieren Sie diese E-Mail. Ohne den Link wird nichts angemeldet, und die Anfrage wird nach 48 Stunden gelöscht.',
    'Someone asked to register this email address for this event. If it was you, confirm to get your check-in QR code.': 'Jemand möchte diese E-Mail-Adresse für diese Veranstaltung anmelden. Wenn Sie das waren, bestätigen Sie, um Ihren QR-Code zu erhalten.',
    'Confirm my registration': 'Anmeldung bestätigen',
    'If it was not you, ignore this email. Nothing is registered unless the button is used, and the request is deleted after 48 hours.': 'Wenn Sie es nicht waren, ignorieren Sie diese E-Mail. Ohne den Button wird nichts angemeldet, und die Anfrage wird nach 48 Stunden gelöscht.',
    'Registration by': 'Anmeldung über',
    'See you soon': 'Bis bald',
    'Hi {name}, this is a reminder that you are registered.': 'Hallo {name}, wir möchten Sie an Ihre Anmeldung erinnern.',
    'When': 'Wann',
    'Where': 'Wo',
    'Open in Maps': 'In Karten öffnen',
    'From the organizer': 'Vom Veranstalter',
    'Show this at the entrance. The code works if the QR will not scan.': 'Zeigen Sie dies am Eingang. Lässt sich der QR-Code nicht scannen, genügt der Code.',
    '{date}, doors open {time}': '{date}, Einlass ab {time}',
    'Reminder: {event}, {date}': 'Erinnerung: {event}, {date}',
    'Thank you for coming': 'Danke für Ihren Besuch',
    'Hi {name}, thank you for joining us on {date}.': 'Hallo {name}, danke, dass Sie am {date} dabei waren.',
    'Open the link': 'Link öffnen',
    'Thank you for coming to {event}': 'Danke für Ihren Besuch bei {event}',
    'You are invited': 'Sie sind eingeladen',
    'Hi {name}, we would love to see you there. Please let us know if you can come.': 'Hallo {name}, wir würden uns freuen, Sie dabeizuhaben. Bitte sagen Sie uns, ob Sie kommen können.',
    'Reply to the invitation': 'Auf die Einladung antworten',
    'This link is personal to you. Your ticket arrives by email once you say you are coming.': 'Dieser Link ist nur für Sie. Ihr Ticket kommt per E-Mail, sobald Sie zusagen.',
    'Invitations powered by': 'Einladungen mit',
    'You are invited: {event}': 'Einladung: {event}',
  },
  ar: {
    'Your check-in QR code: {event}': 'رمز QR الخاص بدخولك: {event}',
    'Hi {name},': 'مرحبًا {name}،',
    'Show this QR code at the entrance to check in. No need to print anything: your phone screen works fine.': 'أظهر رمز QR هذا عند المدخل لتسجيل حضورك. لا حاجة إلى الطباعة: تكفي شاشة هاتفك.',
    'Lost this email? Just show your name at the entrance instead.': 'فقدت هذه الرسالة؟ يكفي أن تذكر اسمك عند المدخل.',
    'Ticket for {name}: {event}': 'تذكرة {name}: {event}',
    'This is the check-in QR code for {guest}, who is coming with you. Forward it to them, or show it at the entrance together.': 'هذا رمز QR لدخول {guest} الذي يرافقك. أعد توجيهه إليه، أو أظهراه معًا عند المدخل.',
    'Check-in powered by': 'تسجيل الحضور بواسطة',
    'Your check-in QR code': 'رمز QR الخاص بدخولك',
    'Confirm your registration': 'أكّد تسجيلك',
    'the event': 'الفعالية',
    'Someone asked to register this email address for {event}.': 'طلب شخص ما تسجيل هذا البريد الإلكتروني في {event}.',
    'If it was you, confirm here to get your check-in QR code:': 'إذا كنت أنت، فأكّد من هنا للحصول على رمز QR الخاص بدخولك:',
    'If it was not you, ignore this email. Nothing is registered unless the link is used, and the request is deleted after 48 hours.': 'إذا لم تكن أنت، فتجاهل هذه الرسالة. لن يُسجَّل أي شيء ما لم يُستخدم الرابط، وسيُحذف الطلب بعد 48 ساعة.',
    'Someone asked to register this email address for this event. If it was you, confirm to get your check-in QR code.': 'طلب شخص ما تسجيل هذا البريد الإلكتروني في هذه الفعالية. إذا كنت أنت، فأكّد للحصول على رمز QR الخاص بدخولك.',
    'Confirm my registration': 'تأكيد تسجيلي',
    'If it was not you, ignore this email. Nothing is registered unless the button is used, and the request is deleted after 48 hours.': 'إذا لم تكن أنت، فتجاهل هذه الرسالة. لن يُسجَّل أي شيء ما لم يُستخدم الزر، وسيُحذف الطلب بعد 48 ساعة.',
    'Registration by': 'التسجيل عبر',
    'See you soon': 'نراك قريبًا',
    'Hi {name}, this is a reminder that you are registered.': 'مرحبًا {name}، نذكّرك بأنك مسجّل في الفعالية.',
    'When': 'الموعد',
    'Where': 'المكان',
    'Open in Maps': 'فتح في الخرائط',
    'From the organizer': 'من المنظّم',
    'Show this at the entrance. The code works if the QR will not scan.': 'أظهر هذا عند المدخل. يمكن استخدام الرمز إذا تعذّر مسح رمز QR.',
    '{date}, doors open {time}': '{date}، تفتح الأبواب {time}',
    'Reminder: {event}, {date}': 'تذكير: {event}، {date}',
    'Thank you for coming': 'شكرًا لحضورك',
    'Hi {name}, thank you for joining us on {date}.': 'مرحبًا {name}، شكرًا لانضمامك إلينا يوم {date}.',
    'Open the link': 'فتح الرابط',
    'Thank you for coming to {event}': 'شكرًا لحضورك {event}',
    'You are invited': 'أنت مدعو',
    'Hi {name}, we would love to see you there. Please let us know if you can come.': 'مرحبًا {name}، يسعدنا حضورك. يُرجى إخبارنا إن كنت تستطيع الحضور.',
    'Reply to the invitation': 'الرد على الدعوة',
    'This link is personal to you. Your ticket arrives by email once you say you are coming.': 'هذا الرابط خاص بك. ستصلك تذكرتك بالبريد الإلكتروني بعد تأكيد حضورك.',
    'Invitations powered by': 'الدعوات بواسطة',
    'You are invited: {event}': 'دعوة: {event}',
  },
}
