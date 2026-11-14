// Applies the theme picked on this device (Light or Dark instead of following the device) before the
// page paints, so there's no flash. The picker is in the footer and on Profile; see setTheme in app.js.
(function () {
  try {
    var t = localStorage.getItem('mhs-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the device */ }
})();
