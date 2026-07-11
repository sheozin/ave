/**
 * CueDeck i18n — Lightweight translation layer
 *
 * Usage:
 *   t('session.status.LIVE')  → 'LIVE' (en) / 'مباشر' (ar)
 *   t('btn.goLive')           → 'GO LIVE' (en) / 'بث مباشر' (ar)
 *   setLocale('ar')           → switches language + direction
 */
const CueDeckI18n = (() => {
  let _locale = 'en';

  const translations = {
    en: {
      // Status labels
      'status.PLANNED':   'PLANNED',
      'status.READY':     'READY',
      'status.CALLING':   'CALLING',
      'status.LIVE':      'LIVE',
      'status.OVERRUN':   'OVERRUN',
      'status.HOLD':      'HOLD',
      'status.ENDED':     'ENDED',
      'status.CANCELLED': 'CANCELLED',

      // Action buttons
      'btn.goLive':       'GO LIVE',
      'btn.setReady':     'SET READY',
      'btn.callSpeaker':  'CALL SPEAKER',
      'btn.hold':         'HOLD',
      'btn.endSession':   'END SESSION',
      'btn.deArm':        'DE-ARM',
      'btn.cancel':       'CANCEL',
      'btn.confirmCancel':'CONFIRM CANCEL',
      'btn.confirmEnd':   'CONFIRM END',
      'btn.resume':       'RESUME',
      'btn.reinstate':    'REINSTATE',
      'btn.pullBack':     'PULL BACK',
      'btn.confirmOnStage':'CONFIRM ON STAGE',
      'btn.undo':         'UNDO',
      'btn.save':         'Save',
      'btn.delete':       'Delete',
      'btn.areYouSure':   'Are you sure?',
      'btn.clear':        'CLEAR',
      'btn.confirmClear': 'CONFIRM CLEAR',
      'btn.pair':         'Pair',
      'btn.addDisplay':   'Add Display',
      'btn.addSponsor':   'Add Sponsor',

      // Session modal
      'sess.new':         'New Session',
      'sess.edit':        'Edit Session',
      'sess.title':       'Title',
      'sess.type':        'Type',
      'sess.room':        'Room',
      'sess.speaker':     'Speaker',
      'sess.company':     'Company',
      'sess.start':       'Planned Start',
      'sess.end':         'Planned End',
      'sess.notes':       'Notes',
      'sess.anchor':      'anchor',
      'sess.recording':   'recording',
      'sess.streaming':   'streaming',
      'sess.remote':      'remote',
      'sess.interpretation':'interpretation',

      // Time labels
      'time.planned':     'PLANNED',
      'time.scheduled':   'SCHEDULED',
      'time.started':     'STARTED',
      'time.elapsed':     'elapsed',
      'time.remaining':   'left',
      'time.overrun':     'OVERRUN',

      // Dashboard
      'dash.noEvents':    'No events yet',
      'dash.createFirst': 'Create your first event to get started',
      'dash.standby':     'STANDBY',

      // Broadcast
      'bc.label':         'BROADCAST',
      'bc.placeholder':   'Type a message to all operators...',

      // Signage
      'sign.pairDisplay':     'Pair a Display',
      'sign.enterCode':       'Enter pairing code',
      'sign.howToConnect':    'How to connect a display',
      'sign.registeredDisplays': 'REGISTERED DISPLAYS',
      'sign.globalOverride':  'GLOBAL DISPLAY OVERRIDE',
      'sign.sponsorLibrary':  'SPONSOR LIBRARY',
      'sign.copyId':          'Copy ID',
      'sign.launch':          'Launch',
      'sign.reset':           'Reset',
      'sign.edit':            'Edit',
      'sign.pushAll':         '→ PUSH ALL',

      // Roles
      'role.director':  'DIRECTOR',
      'role.stage':     'STAGE',
      'role.av':        'AV',
      'role.interp':    'INTERP',
      'role.reg':       'REG',
      'role.signage':   'SIGNAGE',
      'role.label':     'ROLE',

      // Filter bar
      'filter.timeline':    'Timeline',
      'filter.list':        'List',
      'filter.clearAll':    'Clear All',
      'filter.searchPlaceholder': '...search title / speaker',

      // Header
      'hdr.operators':  'Operators',
      'hdr.help':       'Help',
      'hdr.sessions':   'sessions',

      // Misc
      'misc.search':      'Search sessions...',
      'misc.allStatuses': 'All statuses',
      'misc.allRooms':    'All rooms',
      'misc.online':      'Back online — syncing...',
      'misc.saved':       'Saved',
      'misc.loading':     'Loading...',
    },

    ar: {
      'status.PLANNED':   'مُخطط',
      'status.READY':     'جاهز',
      'status.CALLING':   'استدعاء',
      'status.LIVE':      'مباشر',
      'status.OVERRUN':   'تجاوز',
      'status.HOLD':      'توقف',
      'status.ENDED':     'انتهى',
      'status.CANCELLED': 'ملغي',

      'btn.goLive':       'بث مباشر',
      'btn.setReady':     'تجهيز',
      'btn.callSpeaker':  'استدعاء المتحدث',
      'btn.hold':         'توقف',
      'btn.endSession':   'إنهاء الجلسة',
      'btn.deArm':        'إلغاء التجهيز',
      'btn.cancel':       'إلغاء',
      'btn.confirmCancel':'تأكيد الإلغاء',
      'btn.confirmEnd':   'تأكيد الإنهاء',
      'btn.resume':       'استئناف',
      'btn.reinstate':    'استعادة',
      'btn.pullBack':     'تراجع',
      'btn.confirmOnStage':'تأكيد على المسرح',
      'btn.undo':         'تراجع',
      'btn.save':         'حفظ',
      'btn.delete':       'حذف',
      'btn.areYouSure':   'هل أنت متأكد؟',
      'btn.clear':        'مسح',
      'btn.confirmClear': 'تأكيد المسح',
      'btn.pair':         'ربط',
      'btn.addDisplay':   'إضافة شاشة',
      'btn.addSponsor':   'إضافة راعي',

      'sess.new':         'جلسة جديدة',
      'sess.edit':        'تعديل الجلسة',
      'sess.title':       'العنوان',
      'sess.type':        'النوع',
      'sess.room':        'القاعة',
      'sess.speaker':     'المتحدث',
      'sess.company':     'الشركة',
      'sess.start':       'بداية مخططة',
      'sess.end':         'نهاية مخططة',
      'sess.notes':       'ملاحظات',
      'sess.anchor':      'مرساة',
      'sess.recording':   'تسجيل',
      'sess.streaming':   'بث',
      'sess.remote':      'عن بُعد',
      'sess.interpretation':'ترجمة فورية',

      'time.planned':     'مخطط',
      'time.scheduled':   'مجدول',
      'time.started':     'بدأ',
      'time.elapsed':     'منقضي',
      'time.remaining':   'متبقي',
      'time.overrun':     'تجاوز',

      'dash.noEvents':    'لا توجد فعاليات',
      'dash.createFirst': 'أنشئ أول فعالية للبدء',
      'dash.standby':     'انتظار',

      'bc.label':         'بث عام',
      'bc.placeholder':   'اكتب رسالة لجميع المشغلين...',

      'sign.pairDisplay':     'ربط شاشة',
      'sign.enterCode':       'أدخل رمز الربط',
      'sign.howToConnect':    'كيفية توصيل شاشة',
      'sign.registeredDisplays': 'الشاشات المسجلة',
      'sign.globalOverride':  'تجاوز عام للشاشات',
      'sign.sponsorLibrary':  'مكتبة الرعاة',
      'sign.copyId':          'نسخ المعرف',
      'sign.launch':          'تشغيل',
      'sign.reset':           'إعادة تعيين',
      'sign.edit':            'تعديل',
      'sign.pushAll':         '← دفع الكل',

      'role.director':  'مدير',
      'role.stage':     'مسرح',
      'role.av':        'صوتيات',
      'role.interp':    'ترجمة',
      'role.reg':       'تسجيل',
      'role.signage':   'شاشات',
      'role.label':     'الدور',

      'filter.timeline':    'الجدول الزمني',
      'filter.list':        'قائمة',
      'filter.clearAll':    'مسح الكل',
      'filter.searchPlaceholder': '...بحث بالعنوان / المتحدث',

      'hdr.operators':  'المشغلون',
      'hdr.help':       'مساعدة',
      'hdr.sessions':   'جلسات',

      'misc.search':      'بحث في الجلسات...',
      'misc.allStatuses': 'جميع الحالات',
      'misc.allRooms':    'جميع القاعات',
      'misc.online':      'عاد الاتصال — جاري المزامنة...',
      'misc.saved':       'تم الحفظ',
      'misc.loading':     'جاري التحميل...',
    },

    pl: {
      'status.PLANNED':   'ZAPLANOWANE',
      'status.READY':     'GOTOWE',
      'status.CALLING':   'WZYWANIE',
      'status.LIVE':      'NA ŻYWO',
      'status.OVERRUN':   'PRZEKROCZONE',
      'status.HOLD':      'WSTRZYMANE',
      'status.ENDED':     'ZAKOŃCZONE',
      'status.CANCELLED': 'ANULOWANE',

      'btn.goLive':       'ROZPOCZNIJ',
      'btn.setReady':     'PRZYGOTUJ',
      'btn.callSpeaker':  'WEZWIJ MÓWCĘ',
      'btn.hold':         'WSTRZYMAJ',
      'btn.endSession':   'ZAKOŃCZ SESJĘ',
      'btn.cancel':       'ANULUJ',
      'btn.confirmEnd':   'POTWIERDŹ ZAKOŃCZENIE',
      'btn.undo':         'COFNIJ',
      'btn.save':         'Zapisz',
      'btn.delete':       'Usuń',
      'btn.areYouSure':   'Czy na pewno?',

      'sess.new':         'Nowa sesja',
      'sess.edit':        'Edytuj sesję',
      'sess.title':       'Tytuł',
      'sess.room':        'Sala',
      'sess.speaker':     'Mówca',

      'time.planned':     'PLANOWANY',
      'time.scheduled':   'ZAPLANOWANY',
      'time.elapsed':     'upłynęło',
      'time.remaining':   'pozostało',

      'dash.noEvents':    'Brak wydarzeń',
      'misc.search':      'Szukaj sesji...',
    },

    de: {
      'status.PLANNED':   'GEPLANT',
      'status.READY':     'BEREIT',
      'status.CALLING':   'AUFRUF',
      'status.LIVE':      'LIVE',
      'status.OVERRUN':   'ÜBERZOGEN',
      'status.HOLD':      'PAUSE',
      'status.ENDED':     'BEENDET',
      'status.CANCELLED': 'ABGESAGT',

      'btn.goLive':       'LIVE GEHEN',
      'btn.setReady':     'BEREIT SETZEN',
      'btn.callSpeaker':  'SPRECHER RUFEN',
      'btn.hold':         'PAUSE',
      'btn.endSession':   'SITZUNG BEENDEN',
      'btn.cancel':       'ABBRECHEN',
      'btn.confirmEnd':   'BEENDEN BESTÄTIGEN',
      'btn.undo':         'RÜCKGÄNGIG',
      'btn.save':         'Speichern',
      'btn.delete':       'Löschen',
      'btn.areYouSure':   'Sind Sie sicher?',

      'sess.new':         'Neue Sitzung',
      'sess.edit':        'Sitzung bearbeiten',
      'sess.title':       'Titel',
      'sess.room':        'Raum',
      'sess.speaker':     'Sprecher',

      'time.planned':     'GEPLANT',
      'time.scheduled':   'TERMINIERT',
      'time.elapsed':     'vergangen',
      'time.remaining':   'verbleibend',

      'dash.noEvents':    'Keine Veranstaltungen',
      'misc.search':      'Sitzungen suchen...',
    },
  };

  function t(key) {
    return translations[_locale]?.[key] || translations.en[key] || key;
  }

  function setLocale(locale) {
    if (!translations[locale]) return;
    _locale = locale;
    document.documentElement.lang = locale;
    document.documentElement.dir  = locale === 'ar' ? 'rtl' : 'ltr';
    localStorage.setItem('cuedeck_locale', locale);
  }

  function getLocale() { return _locale; }

  function getAvailableLocales() {
    return [
      { code: 'en', name: 'English',  flag: '🇬🇧' },
      { code: 'ar', name: 'العربية',   flag: '🇦🇪' },
      { code: 'pl', name: 'Polski',   flag: '🇵🇱' },
      { code: 'de', name: 'Deutsch',  flag: '🇩🇪' },
    ];
  }

  // Auto-restore from localStorage
  const saved = localStorage.getItem('cuedeck_locale');
  if (saved && translations[saved]) setLocale(saved);

  return { t, setLocale, getLocale, getAvailableLocales };
})();

// Global shortcut
const t = CueDeckI18n.t;
