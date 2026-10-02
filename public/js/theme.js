/* Lestha Send — thème clair / sombre
 * Chargé tôt dans <head> (script classique, non module) : le bon thème est posé
 * avant le premier affichage, sans clignotement.
 * Choix possibles : « auto » (suit le téléphone ou l'ordinateur), « light », « dark ».
 */
(function () {
  'use strict';
  var KEY = 'tx_theme';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  var COLORS = { dark: '#070b16', light: '#f3f8fc' };
  var LABELS = { auto: 'Thème : automatique', light: 'Thème : clair', dark: 'Thème : sombre' };
  var ICONS = {
    auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'
  };

  function read() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch (e) { return 'auto'; } }
  function write(v) { try { if (v === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) { /* stockage indisponible : le choix vaut pour la session */ } }
  function resolve(choice) { return choice === 'auto' ? (media && media.matches ? 'light' : 'dark') : choice; }

  var choice = read();
  function apply() {
    var t = resolve(choice);
    root.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLORS[t]);
    var cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', t);
    var btn = document.getElementById('btnTheme');
    if (btn) {
      btn.title = LABELS[choice] + ' (cliquer pour changer)';
      btn.setAttribute('aria-label', LABELS[choice]);
      btn.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[choice] + '</svg>';
    }
  }
  apply();
  if (media) {
    var onChange = function () { if (choice === 'auto') apply(); };
    if (media.addEventListener) media.addEventListener('change', onChange); else if (media.addListener) media.addListener(onChange);
  }

  var ORDER = ['auto', 'light', 'dark'];
  window.LSTheme = {
    get: function () { return choice; },
    current: function () { return resolve(choice); },
    set: function (v) { choice = ORDER.indexOf(v) >= 0 ? v : 'auto'; write(choice); apply(); },
    cycle: function () { this.set(ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length]); }
  };

  // Bouton dans la barre du haut (page publique et console)
  function mount() {
    var host = document.querySelector('.topbar-actions');
    if (!host || document.getElementById('btnTheme')) return;
    var btn = document.createElement('button');
    btn.id = 'btnTheme'; btn.type = 'button'; btn.className = 'icon-btn theme-btn';
    btn.addEventListener('click', function () { window.LSTheme.cycle(); });
    host.insertBefore(btn, host.firstChild);
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
