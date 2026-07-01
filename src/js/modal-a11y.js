// Accessibility enhancer for the episode detail modal (WCAG 2.4.3 / 2.1.2).
//
// The modal markup + open/close logic is duplicated inline in podcast.njk and
// podcast-episodes.njk, and both toggle the `.open` class on #episodeModal.
// Rather than fork focus-management into each, this observes that class change
// and adds: move focus into the dialog on open, restore it to the trigger on
// close, and trap Tab within the dialog while open. Escape-to-close and
// click-outside-to-close already live in the page scripts.
(function () {
  var modal = document.getElementById('episodeModal');
  if (!modal) return;
  var dialog = modal.querySelector('.episode-modal') || modal;
  var lastFocused = null;

  var FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])', 'iframe',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function focusables() {
    return Array.prototype.filter.call(
      dialog.querySelectorAll(FOCUSABLE),
      function (el) { return el.offsetWidth || el.offsetHeight || el.getClientRects().length; }
    );
  }

  function onKeydown(e) {
    if (e.key !== 'Tab') return;
    var f = focusables();
    if (!f.length) { e.preventDefault(); dialog.focus(); return; }
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function onOpen() {
    lastFocused = document.activeElement;
    var closeBtn = document.getElementById('modalClose');
    (closeBtn || dialog).focus();
    document.addEventListener('keydown', onKeydown, true);
  }

  function onClose() {
    document.removeEventListener('keydown', onKeydown, true);
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
  }

  var wasOpen = modal.classList.contains('open');
  new MutationObserver(function () {
    var isOpen = modal.classList.contains('open');
    if (isOpen === wasOpen) return;
    wasOpen = isOpen;
    if (isOpen) onOpen(); else onClose();
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });
})();
