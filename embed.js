// embed.js: put on an organizer's own website next to the CueDeck
// registration iframe (Event admin, Registration, "Put it on your website").
// Each embedded form reports its height; this sets the matching iframe to
// it, so the form never shows a scrollbar. Only messages from CueDeck are
// read, and only a height is ever taken from them.
(function () {
  // The CueDeck this script was loaded from: the only sender it listens to.
  var me = document.currentScript && document.currentScript.src;
  var ORIGIN = me ? new URL(me).origin : 'https://app.cuedeck.io';
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.type !== 'cuedeck:height') return;
    var h = Number(e.data.height);
    if (!isFinite(h) || h < 100 || h > 20000) return;
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === e.source) { frames[i].style.height = Math.ceil(h) + 'px'; return; }
    }
  });
})();
