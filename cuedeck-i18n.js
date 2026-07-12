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

      // Display modal
      'disp.addDisplay':    'Add Display',
      'disp.editDisplay':   'Edit Display',
      'disp.addSponsor':    'Add Sponsor',
      'disp.editSponsor':   'Edit Sponsor',
      'disp.nameRequired':  'Display name is required.',
      'disp.noEvent':       'No active event selected.',
      'disp.sponsorRequired':'Sponsor name is required.',
      'disp.noActiveEvent': 'No active event.',
      'disp.online':        'online',
      'disp.offline':       'offline',
      'disp.landscape':     'landscape',
      'disp.portrait':      'portrait',
      'disp.schedule':      'schedule',
      'disp.wayfinding':    'wayfinding',
      'disp.sponsors':      'sponsors',
      'disp.agenda':        'agenda',
      'disp.timeline':      'timeline',
      'disp.programme':     'programme',
      'disp.break':         'break',
      'disp.custom':        'custom',
      'disp.stageTimer':    'stage timer',

      // Stage monitor
      'stage.youAreLive':   'YOU ARE LIVE',
      'stage.remaining':    'REMAINING',
      'stage.nextSession':  'NEXT SESSION',
      'stage.noActive':     'No active session',
      'stage.standby':      'STANDBY',

      // Toasts
      'toast.refreshed':        'Refreshed',
      'toast.undoFailed':       'Undo failed',
      'toast.reverted':         'Reverted to',
      'toast.updatedByOther':   'Updated by another operator — refreshing',
      'toast.delayApplied':     'Delay applied',
      'toast.sessionsShifted':  'sessions shifted',
      'toast.delayRetry':       'Another delay is being applied — wait and retry',
      'toast.invalidCode':      'Enter a valid 6-character pairing code',
      'toast.noEvent':          'No event selected',
      'toast.invalidPairing':   'Invalid pairing code',
      'toast.codeExpired':      'Pairing code expired',
      'toast.codeUsed':         'Code already used',
      'toast.displayPaired':    'Display paired successfully!',
      'toast.autoStartEnabled': 'Auto-start enabled',
      'toast.autoStartDisabled':'Auto-start disabled',
      'toast.autoStarted':      'Auto-started',
      'toast.logEmpty':         'Log is empty',
      'toast.selectEvent':      'Select an event first',
      'toast.csvEmpty':         'CSV appears empty',
      'toast.csvNeeds':         'CSV needs: title, start, end columns',
      'toast.noValidRows':      'No valid rows found',
      'toast.importFailed':     'Import failed',
      'toast.imported':         'Imported',
      'toast.sessions':         'sessions',
      'toast.nudgeApplied':     'nudge applied',
      'toast.noStageTimer':     'No Stage Timer display configured',

      // Delay strip
      'delay.running':        'RUNNING',
      'delay.sessionsAffected':'sessions affected',
      'delay.nextAnchor':     'Next Anchor',
      'delay.resetDelays':    'Reset delays',
      'delay.confirmReset':   'Confirm reset?',

      // Batch
      'batch.selected':       'selected',
      'batch.setReady':       'SET READY',
      'batch.endAll':         'END ALL',
      'batch.cancelAll':      'CANCEL ALL',
      'batch.clickAgain':     'Click again to confirm',

      // Undo
      'undo.undo':            'UNDO',
      'undo.ended':           'ENDED',
      'undo.cancelled':       'CANCELLED',

      // Event modal
      'event.new':            'New Event',
      'event.edit':           'Edit Event',
      'event.name':           'Event Name',
      'event.date':           'Date',
      'event.timezone':       'Timezone',
      'event.venue':          'Venue',
      'event.startTime':      'Start Time',
      'event.endTime':        'End Time',

      // Users modal
      'users.title':          'Operators',
      'users.invite':         'Invite Operator',
      'users.pending':        'Pending',
      'users.active':         'Active',
      'users.suspended':      'Suspended',
      'users.noOperators':    'No operators yet',

      // Feedback
      'feedback.title':       'Send Feedback',
      'feedback.rate':        'How is your experience?',
      'feedback.category':    'Category',
      'feedback.general':     'General',
      'feedback.bug':         'Bug Report',
      'feedback.feature':     'Feature Request',
      'feedback.praise':      'Praise',
      'feedback.message':     'Your message',
      'feedback.send':        'Send Feedback',

      // Help menu
      'help.shortcuts':       'Keyboard Shortcuts',
      'help.quickRef':        'Quick Reference',
      'help.whatsNew':        'What\'s New',
      'help.docs':            'Documentation',
      'help.feedback':        'Send Feedback',
      'help.contact':         'Contact Support',
      'help.about':           'About CueDeck',

      // Profile panel
      'profile.plan':         'Plan',
      'profile.billing':      'Billing',
      'profile.signOut':      'Sign Out',

      // Auth
      'auth.login':           'Sign In',
      'auth.register':        'Register',
      'auth.email':           'Email',
      'auth.password':        'Password',
      'auth.name':            'Full Name',
      'auth.organization':    'Organization',
      'auth.forgotPassword':  'Forgot password?',
      'auth.noAccount':       'Don\'t have an account?',
      'auth.hasAccount':      'Already have an account?',

      // Confirm dialogs
      'confirm.areYouSure':   'Are you sure?',
      'confirm.confirm':      'Confirm?',
      'confirm.confirmCancel':'CONFIRM CANCEL',
      'confirm.confirmEnd':   'CONFIRM END',
      'confirm.confirmClear': 'CONFIRM CLEAR',
      'confirm.confirmReset': 'Confirm reset?',

      // Onboarding
      'onboard.welcome':      'Welcome to CueDeck',
      'onboard.step1':        'Create your first event',
      'onboard.step2':        'Add sessions to your schedule',
      'onboard.step3':        'Set up a display',
      'onboard.step4':        'Invite your first operator',
      'onboard.skip':         'Skip for now',
      'onboard.next':         'Next',
      'onboard.finish':       'Finish',

      // Diagnostic bar
      'diag.database':        'database',
      'diag.realtime':        'realtime',
      'diag.clockSync':       'clock sync',
      'diag.edgeFunctions':   'edge functions',
      'diag.sessions':        'sessions',
      'diag.live':            'live',

      // Session types
      'type.Keynote':         'Keynote',
      'type.Panel':           'Panel',
      'type.Workshop':        'Workshop',
      'type.Break':           'Break',
      'type.Presentation':    'Presentation',
      'type.Other':           'Other',

      // Bottom bar / broadcast
      'bc.send':              'SEND',
      'bc.clear':             'CLEAR',
      'bc.hold':              'Hold',
      'bc.phones':            'Phones',
      'bc.delay':             'Delay',
      'bc.seats':             'Seats',
      'bc.break':             'Break',
      'bc.broadcast':         'BROADCAST',

      // Presence header
      'presence.director':    'director',
      'presence.stage':       'stage',
      'presence.av':          'av',
      'presence.interp':      'interp',
      'presence.reg':         'reg',

      // Header misc
      'hdr.event':            'EVENT',
      'hdr.offset':           'offset',

      // CSV import
      'csv.import':           'Import Sessions (CSV)',
      'csv.dragDrop':         'Drag & drop a CSV file or click to browse',

      // Misc
      'misc.search':          'Search sessions...',
      'misc.allStatuses':     'All statuses',
      'misc.allRooms':        'All rooms',
      'misc.online':          'Back online — syncing...',
      'misc.saved':           'Saved',
      'misc.loading':         'Loading...',
      'misc.noEvents':        'No events yet',
      'misc.createFirst':     'Create your first event to get started',
      'misc.version':         'Version',
      'misc.copy':            'Copy',
      'misc.copied':          'Copied!',
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

      'disp.addDisplay':    'إضافة شاشة',
      'disp.editDisplay':   'تعديل الشاشة',
      'disp.addSponsor':    'إضافة راعي',
      'disp.editSponsor':   'تعديل الراعي',
      'disp.nameRequired':  'اسم الشاشة مطلوب.',
      'disp.noEvent':       'لا يوجد حدث مفعّل.',
      'disp.sponsorRequired':'اسم الراعي مطلوب.',
      'disp.noActiveEvent': 'لا يوجد حدث مفعّل.',
      'disp.online':        'متصل',
      'disp.offline':       'غير متصل',
      'disp.landscape':     'أفقي',
      'disp.portrait':      'عمودي',
      'disp.schedule':      'الجدول',
      'disp.wayfinding':    'الإرشاد',
      'disp.sponsors':      'الرعاة',
      'disp.agenda':        'جدول الأعمال',
      'disp.timeline':      'الجدول الزمني',
      'disp.programme':     'البرنامج',
      'disp.break':         'استراحة',
      'disp.custom':        'مخصص',
      'disp.stageTimer':    'مؤقت المسرح',

      'stage.youAreLive':   'أنت على الهواء',
      'stage.remaining':    'المتبقي',
      'stage.nextSession':  'الجلسة التالية',
      'stage.noActive':     'لا توجد جلسة نشطة',
      'stage.standby':      'انتظار',

      'toast.refreshed':        'تم التحديث',
      'toast.undoFailed':       'فشل التراجع',
      'toast.reverted':         'تم الرجوع إلى',
      'toast.updatedByOther':   'تم التحديث بواسطة مشغل آخر — جاري التحديث',
      'toast.delayApplied':     'تم تطبيق التأخير',
      'toast.sessionsShifted':  'جلسات تم إزاحتها',
      'toast.delayRetry':       'يتم تطبيق تأخير آخر — حاول مجدداً',
      'toast.invalidCode':      'أدخل رمز ربط صالح من 6 أحرف',
      'toast.noEvent':          'لم يتم اختيار حدث',
      'toast.invalidPairing':   'رمز ربط غير صالح',
      'toast.codeExpired':      'انتهت صلاحية رمز الربط',
      'toast.codeUsed':         'الرمز مستخدم بالفعل',
      'toast.displayPaired':    'تم ربط الشاشة بنجاح!',
      'toast.autoStartEnabled': 'تم تفعيل البدء التلقائي',
      'toast.autoStartDisabled':'تم تعطيل البدء التلقائي',
      'toast.autoStarted':      'بدء تلقائي',
      'toast.logEmpty':         'السجل فارغ',
      'toast.selectEvent':      'اختر حدثاً أولاً',
      'toast.csvEmpty':         'ملف CSV فارغ',
      'toast.csvNeeds':         'يحتاج CSV أعمدة: العنوان، البداية، النهاية',
      'toast.noValidRows':      'لم يتم العثور على صفوف صالحة',
      'toast.importFailed':     'فشل الاستيراد',
      'toast.imported':         'تم استيراد',
      'toast.sessions':         'جلسات',
      'toast.nudgeApplied':     'تم تطبيق التعديل',
      'toast.noStageTimer':     'لم يتم تكوين شاشة مؤقت المسرح',

      'delay.running':        'جاري التشغيل',
      'delay.sessionsAffected':'جلسات متأثرة',
      'delay.nextAnchor':     'المرساة التالية',
      'delay.resetDelays':    'إعادة تعيين التأخيرات',
      'delay.confirmReset':   'تأكيد إعادة التعيين؟',

      'batch.selected':       'محدد',
      'batch.setReady':       'تجهيز الكل',
      'batch.endAll':         'إنهاء الكل',
      'batch.cancelAll':      'إلغاء الكل',
      'batch.clickAgain':     'اضغط مجدداً للتأكيد',

      'undo.undo':            'تراجع',
      'undo.ended':           'منتهية',
      'undo.cancelled':       'ملغاة',

      'event.new':            'حدث جديد',
      'event.edit':           'تعديل الحدث',
      'event.name':           'اسم الحدث',
      'event.date':           'التاريخ',
      'event.timezone':       'المنطقة الزمنية',
      'event.venue':          'المكان',
      'event.startTime':      'وقت البدء',
      'event.endTime':        'وقت الانتهاء',

      'users.title':          'المشغلون',
      'users.invite':         'دعوة مشغل',
      'users.pending':        'قيد الانتظار',
      'users.active':         'نشط',
      'users.suspended':      'معلّق',
      'users.noOperators':    'لا يوجد مشغلون',

      'feedback.title':       'إرسال ملاحظات',
      'feedback.rate':        'كيف تقيّم تجربتك؟',
      'feedback.category':    'الفئة',
      'feedback.general':     'عام',
      'feedback.bug':         'تقرير خطأ',
      'feedback.feature':     'طلب ميزة',
      'feedback.praise':      'إشادة',
      'feedback.message':     'رسالتك',
      'feedback.send':        'إرسال الملاحظات',

      'help.shortcuts':       'اختصارات لوحة المفاتيح',
      'help.quickRef':        'مرجع سريع',
      'help.whatsNew':        'ما الجديد',
      'help.docs':            'الوثائق',
      'help.feedback':        'إرسال ملاحظات',
      'help.contact':         'تواصل مع الدعم',
      'help.about':           'حول CueDeck',

      'profile.plan':         'الخطة',
      'profile.billing':      'الفوترة',
      'profile.signOut':      'تسجيل الخروج',

      'auth.login':           'تسجيل الدخول',
      'auth.register':        'إنشاء حساب',
      'auth.email':           'البريد الإلكتروني',
      'auth.password':        'كلمة المرور',
      'auth.name':            'الاسم الكامل',
      'auth.organization':    'المؤسسة',
      'auth.forgotPassword':  'نسيت كلمة المرور؟',
      'auth.noAccount':       'ليس لديك حساب؟',
      'auth.hasAccount':      'لديك حساب بالفعل؟',

      'confirm.areYouSure':   'هل أنت متأكد؟',
      'confirm.confirm':      'تأكيد؟',
      'confirm.confirmCancel':'تأكيد الإلغاء',
      'confirm.confirmEnd':   'تأكيد الإنهاء',
      'confirm.confirmClear': 'تأكيد المسح',
      'confirm.confirmReset': 'تأكيد إعادة التعيين؟',

      'onboard.welcome':      'مرحباً بك في CueDeck',
      'onboard.step1':        'أنشئ أول حدث',
      'onboard.step2':        'أضف جلسات إلى الجدول',
      'onboard.step3':        'إعداد شاشة عرض',
      'onboard.step4':        'دعوة أول مشغل',
      'onboard.skip':         'تخطي الآن',
      'onboard.next':         'التالي',
      'onboard.finish':       'إنهاء',

      'diag.database':        'قاعدة البيانات',
      'diag.realtime':        'الوقت الحقيقي',
      'diag.clockSync':       'مزامنة الساعة',
      'diag.edgeFunctions':   'الوظائف',
      'diag.sessions':        'جلسات',
      'diag.live':            'مباشر',

      'type.Keynote':         'كلمة رئيسية',
      'type.Panel':           'حوار',
      'type.Workshop':        'ورشة عمل',
      'type.Break':           'استراحة',
      'type.Presentation':    'عرض تقديمي',
      'type.Other':           'أخرى',

      'bc.send':              'إرسال',
      'bc.clear':             'مسح',
      'bc.hold':              'توقف',
      'bc.phones':            'هواتف',
      'bc.delay':             'تأخير',
      'bc.seats':             'مقاعد',
      'bc.break':             'استراحة',
      'bc.broadcast':         'بث عام',

      'presence.director':    'مدير',
      'presence.stage':       'مسرح',
      'presence.av':          'صوتيات',
      'presence.interp':      'ترجمة',
      'presence.reg':         'تسجيل',

      'hdr.event':            'الحدث',
      'hdr.offset':           'فرق التوقيت',

      'csv.import':           'استيراد جلسات (CSV)',
      'csv.dragDrop':         'اسحب وأفلت ملف CSV أو اضغط للتصفح',

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
      'misc.noEvents':    'لا توجد فعاليات',
      'misc.createFirst': 'أنشئ أول فعالية للبدء',
      'misc.version':     'الإصدار',
      'misc.copy':        'نسخ',
      'misc.copied':      'تم النسخ!',
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

      'confirm.areYouSure':   'Czy na pewno?',
      'confirm.confirmCancel':'POTWIERDŹ ANULOWANIE',
      'confirm.confirmEnd':   'POTWIERDŹ ZAKOŃCZENIE',
      'confirm.confirmClear': 'POTWIERDŹ CZYSZCZENIE',
      'confirm.confirmReset': 'Potwierdź reset?',

      'toast.refreshed':    'Odświeżono',
      'toast.displayPaired':'Ekran połączony!',
      'toast.invalidCode':  'Wprowadź prawidłowy 6-znakowy kod',
      'toast.noEvent':      'Nie wybrano wydarzenia',

      'disp.addDisplay':    'Dodaj ekran',
      'disp.editDisplay':   'Edytuj ekran',
      'disp.addSponsor':    'Dodaj sponsora',
      'disp.editSponsor':   'Edytuj sponsora',

      'type.Keynote':       'Wykład',
      'type.Panel':         'Panel',
      'type.Workshop':      'Warsztaty',
      'type.Break':         'Przerwa',
      'type.Presentation':  'Prezentacja',
      'type.Other':         'Inne',

      'bc.send':            'WYŚLIJ',
      'bc.clear':           'WYCZYŚĆ',
      'bc.hold':            'Wstrzymaj',
      'bc.phones':          'Telefony',
      'bc.delay':           'Opóźnienie',
      'bc.seats':           'Miejsca',
      'bc.break':           'Przerwa',
      'bc.broadcast':       'KOMUNIKAT',

      'role.director':      'REŻYSER',
      'role.stage':         'SCENA',
      'role.av':            'AV',
      'role.interp':        'TŁUMACZ',
      'role.reg':           'REJESTR.',
      'role.signage':       'EKRANY',
      'role.label':         'ROLA',

      'filter.timeline':    'Oś czasu',
      'filter.list':        'Lista',
      'filter.clearAll':    'Wyczyść',
      'filter.searchPlaceholder': '...szukaj tytułu / mówcy',

      'hdr.operators':      'Operatorzy',
      'hdr.help':           'Pomoc',
      'hdr.sessions':       'sesje',
      'hdr.event':          'WYDARZENIE',

      'diag.database':      'baza danych',
      'diag.realtime':      'czas rzecz.',
      'diag.clockSync':     'synch. zegara',
      'diag.edgeFunctions': 'funkcje',
      'diag.sessions':      'sesje',
      'diag.live':          'na żywo',

      'sign.registeredDisplays': 'ZAREJESTROWANE EKRANY',
      'sign.globalOverride':  'GLOBALNE NADPISANIE',
      'sign.sponsorLibrary':  'BIBLIOTEKA SPONSORÓW',
      'sign.pairDisplay':     'Sparuj ekran',

      'delay.resetDelays':    'Resetuj opóźnienia',
      'delay.confirmReset':   'Potwierdzić reset?',

      'help.shortcuts':       'Skróty klawiszowe',
      'help.quickRef':        'Podręcznik',
      'help.whatsNew':        'Co nowego',
      'help.docs':            'Dokumentacja',
      'help.feedback':        'Wyślij opinię',
      'help.contact':         'Kontakt z pomocą',
      'help.about':           'O CueDeck',

      'profile.signOut':      'Wyloguj',
      'misc.search':          'Szukaj sesji...',
      'misc.allStatuses':     'Wszystkie statusy',
      'misc.allRooms':        'Wszystkie sale',
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

      'confirm.areYouSure':   'Sind Sie sicher?',
      'confirm.confirmCancel':'ABBRUCH BESTÄTIGEN',
      'confirm.confirmEnd':   'BEENDEN BESTÄTIGEN',
      'confirm.confirmClear': 'LÖSCHEN BESTÄTIGEN',
      'confirm.confirmReset': 'Reset bestätigen?',

      'toast.refreshed':    'Aktualisiert',
      'toast.displayPaired':'Display verbunden!',
      'toast.invalidCode':  'Gültigen 6-stelligen Code eingeben',
      'toast.noEvent':      'Kein Event ausgewählt',

      'disp.addDisplay':    'Display hinzufügen',
      'disp.editDisplay':   'Display bearbeiten',
      'disp.addSponsor':    'Sponsor hinzufügen',
      'disp.editSponsor':   'Sponsor bearbeiten',

      'type.Keynote':       'Keynote',
      'type.Panel':         'Podium',
      'type.Workshop':      'Workshop',
      'type.Break':         'Pause',
      'type.Presentation':  'Vortrag',
      'type.Other':         'Sonstiges',

      'bc.send':            'SENDEN',
      'bc.clear':           'LÖSCHEN',
      'bc.hold':            'Halt',
      'bc.phones':          'Telefone',
      'bc.delay':           'Verzögerung',
      'bc.seats':           'Plätze',
      'bc.break':           'Pause',
      'bc.broadcast':       'DURCHSAGE',

      'role.director':      'REGIE',
      'role.stage':         'BÜHNE',
      'role.av':            'AV',
      'role.interp':        'DOLM.',
      'role.reg':           'EMPFANG',
      'role.signage':       'ANZEIGEN',
      'role.label':         'ROLLE',

      'filter.timeline':    'Zeitachse',
      'filter.list':        'Liste',
      'filter.clearAll':    'Zurücksetzen',
      'filter.searchPlaceholder': '...Titel / Sprecher suchen',

      'hdr.operators':      'Operatoren',
      'hdr.help':           'Hilfe',
      'hdr.sessions':       'Sitzungen',
      'hdr.event':          'EVENT',

      'diag.database':      'Datenbank',
      'diag.realtime':      'Echtzeit',
      'diag.clockSync':     'Uhr-Sync',
      'diag.edgeFunctions': 'Funktionen',
      'diag.sessions':      'Sitzungen',
      'diag.live':          'live',

      'sign.registeredDisplays': 'REGISTRIERTE DISPLAYS',
      'sign.globalOverride':  'GLOBALE ÜBERSCHREIBUNG',
      'sign.sponsorLibrary':  'SPONSOREN-BIBLIOTHEK',
      'sign.pairDisplay':     'Display koppeln',

      'delay.resetDelays':    'Verzögerungen zurücksetzen',
      'delay.confirmReset':   'Reset bestätigen?',

      'help.shortcuts':       'Tastenkürzel',
      'help.quickRef':        'Kurzreferenz',
      'help.whatsNew':        'Neuigkeiten',
      'help.docs':            'Dokumentation',
      'help.feedback':        'Feedback senden',
      'help.contact':         'Support kontaktieren',
      'help.about':           'Über CueDeck',

      'profile.signOut':      'Abmelden',
      'misc.search':          'Sitzungen suchen...',
      'misc.allStatuses':     'Alle Status',
      'misc.allRooms':        'Alle Räume',
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

  // Translate static DOM elements after page load
  // Maps CSS selector → translation key
  function translateStaticDOM() {
    if (_locale === 'en') return; // English is the source, skip
    const map = {
      // Role bar
      '#role-bar > label':          'role.label',
      // Header buttons
      '#users-btn':                 'hdr.operators',
      '#help-btn':                  'hdr.help',
      // Broadcast bar
      '#bc-bar > label':            'bc.label',
      '#bc-input':                  null, // placeholder handled below
    };
    // Role buttons by data-role attribute
    const roleMap = {
      'director': 'role.director',
      'stage':    'role.stage',
      'av':       'role.av',
      'interp':   'role.interp',
      'reg':      'role.reg',
      'signage':  'role.signage',
    };

    // Update mapped elements
    for (const [sel, key] of Object.entries(map)) {
      if (!key) continue;
      const el = document.querySelector(sel);
      if (el) {
        // Preserve child elements (like badge spans)
        const children = [...el.childNodes].filter(n => n.nodeType === 1);
        if (children.length > 0) {
          // Find first text node and replace it
          for (const node of el.childNodes) {
            if (node.nodeType === 3 && node.textContent.trim()) {
              node.textContent = t(key);
              break;
            }
          }
        } else {
          el.textContent = t(key);
        }
      }
    }

    // Role buttons
    document.querySelectorAll('.rbtn').forEach(btn => {
      const role = btn.dataset.role || btn.textContent.trim().toLowerCase();
      if (roleMap[role]) btn.textContent = t(roleMap[role]);
    });

    // Broadcast input placeholder
    const bcInput = document.getElementById('bc-input');
    if (bcInput) bcInput.placeholder = t('bc.placeholder');

    // Filter bar Clear All button
    const clearBtn = document.getElementById('fb-clear');
    if (clearBtn) clearBtn.textContent = t('filter.clearAll');

    // View toggle pills
    document.querySelectorAll('.fb-view-pill').forEach(pill => {
      const text = pill.textContent.trim().toLowerCase();
      if (text.includes('timeline')) pill.childNodes[pill.childNodes.length - 1].textContent = ' ' + t('filter.timeline');
      if (text.includes('list')) pill.childNodes[pill.childNodes.length - 1].textContent = ' ' + t('filter.list');
    });

    // Help dropdown menu
    const helpItems = {
      'Keyboard Shortcuts': 'help.shortcuts',
      'Quick Reference':    'help.quickRef',
      'What\'s New':        'help.whatsNew',
      'Documentation':      'help.docs',
      'Send Feedback':      'help.feedback',
      'Contact Support':    'help.contact',
      'About CueDeck':      'help.about',
    };
    document.querySelectorAll('#help-dropdown button').forEach(btn => {
      const orig = btn.textContent.replace(/^[^\w]*/, '').trim(); // strip emoji
      if (helpItems[orig]) {
        const emoji = btn.textContent.match(/^([^\w]*)/)?.[1] || '';
        btn.textContent = emoji + t(helpItems[orig]);
      }
    });

    // Diagnostic bar pills
    const diagMap = { 'database': 'diag.database', 'realtime': 'diag.realtime', 'clock sync': 'diag.clockSync', 'edge functions': 'diag.edgeFunctions' };
    document.querySelectorAll('#diag-bar .di-lbl').forEach(lbl => {
      const key = diagMap[lbl.textContent.trim().toLowerCase()];
      if (key) lbl.textContent = t(key);
    });

    // Auth forms
    const authMap = {
      'Sign In': 'auth.login', 'Register': 'auth.register',
      'Email': 'auth.email', 'Password': 'auth.password',
      'Full Name': 'auth.name', 'Organization': 'auth.organization',
      'Forgot password?': 'auth.forgotPassword',
    };
    document.querySelectorAll('label, button, a').forEach(el => {
      const txt = el.childNodes[0]?.textContent?.trim();
      if (txt && authMap[txt]) el.childNodes[0].textContent = t(authMap[txt]);
    });

    // Broadcast presets
    document.querySelectorAll('.bc-preset-btn').forEach(btn => {
      const presetMap = {
        'Hold': 'btn.hold', 'Phones': 'bc.phones', 'Delay': 'delay.running',
        'Seats': 'bc.seats', 'Break': 'disp.break',
      };
      const key = presetMap[btn.textContent.replace(/[^\w\s]/g, '').trim()];
      if (key) {
        const emoji = btn.textContent.match(/^([^\w]*)/)?.[1] || '';
        btn.textContent = emoji + t(key);
      }
    });

    // Batch bar buttons
    const batchBar = document.getElementById('batch-bar');
    if (batchBar) {
      batchBar.querySelectorAll('.abtn').forEach(btn => {
        const map = { 'SET READY': 'batch.setReady', 'END ALL': 'batch.endAll', 'CANCEL ALL': 'batch.cancelAll' };
        const key = map[btn.textContent.trim()];
        if (key) btn.textContent = t(key);
      });
      const clearBtn = batchBar.querySelector('[onclick*="clearBatchSelection"]');
      if (clearBtn) clearBtn.textContent = t('filter.clearAll');
    }

    // Undo bar
    const undoBtn = document.getElementById('undo-btn');
    if (undoBtn) undoBtn.textContent = t('undo.undo');

    // Logout button title
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.title = t('profile.signOut');

    // Broadcast bottom bar buttons
    document.querySelectorAll('#bc-bar button').forEach(btn => {
      const txt = btn.textContent.trim();
      if (txt === 'SEND') btn.textContent = t('bc.send');
      if (txt === 'CLEAR') btn.textContent = t('bc.clear');
    });

    // Broadcast preset buttons at far right
    document.querySelectorAll('[onclick*="insertPreset"]').forEach(btn => {
      const presets = { 'Hold': 'bc.hold', 'Phones': 'bc.phones', 'Delay': 'bc.delay', 'Seats': 'bc.seats', 'Break': 'bc.break' };
      for (const [en, key] of Object.entries(presets)) {
        if (btn.textContent.includes(en)) {
          btn.textContent = btn.textContent.replace(en, t(key));
        }
      }
    });

    // "BROADCAST" label
    document.querySelectorAll('#bc-bar span').forEach(el => {
      if (el.textContent.trim() === 'BROADCAST') el.textContent = t('bc.broadcast');
    });

    // Presence indicators in header
    document.querySelectorAll('.pr-role').forEach(el => {
      const presMap = { 'director': 'presence.director', 'stage': 'presence.stage', 'av': 'presence.av', 'interp': 'presence.interp', 'reg': 'presence.reg' };
      const key = presMap[el.textContent.trim().toLowerCase()];
      if (key) el.textContent = t(key);
    });

    // Diagnostic "sessions: N" and "live" label
    document.querySelectorAll('#diag-bar span').forEach(el => {
      if (el.textContent.trim().startsWith('sessions')) el.textContent = el.textContent.replace('sessions', t('diag.sessions'));
    });
    const connLbl = document.getElementById('conn-lbl');
    if (connLbl && connLbl.textContent.trim() === 'live') connLbl.textContent = t('diag.live');

    // EVENT label
    document.querySelectorAll('#ev-select-wrap label, #ev-select-wrap span').forEach(el => {
      if (el.textContent.trim() === 'EVENT') el.textContent = t('hdr.event');
    });
  }

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

  return { t, setLocale, getLocale, getAvailableLocales, translateStaticDOM };
})();

// Global shortcut
const t = CueDeckI18n.t;
