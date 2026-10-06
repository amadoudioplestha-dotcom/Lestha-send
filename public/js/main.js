/* Lestha Send — point d'entrée */
import { $, ss, toast, enableRipples, lowMemory, isWebView, getConfig, icon } from './core.js';
import { route, startRouter } from './router.js';
import { trackPage, openFeedback } from './ux.js';
import { accountInit } from './account.js';
window.addEventListener('tx:route', trackPage);

// Appareils modestes : effets allégés (évite les rechargements forcés par manque de mémoire)
if (lowMemory || /Android [4-8]\b/.test(navigator.userAgent)) document.documentElement.classList.add('lite');

route((path, params) => (path === '/' && params.get('room') ? [path] : null), () => import('./p2p.js').then(m => ({ default: m.receiveView })), 'send');
route(/^\/t\/([A-Za-z0-9]{6,32})\/?$/, () => import('./receive.js'), null, () => ({ to: '/', label: 'Accueil', inApp: true }));
route(/^\/m\/([A-Za-z0-9]{6,32})\/?$/, () => import('./manage.js'), 'dashboard');
route(/^\/dashboard\/?$/, () => import('./dashboard.js'), 'dashboard');
/* Services désactivés depuis la console : masqués du menu, page « indisponible » */
const offView = { render(root) { root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon info">${icon('clock')}</div><h2>Service indisponible pour le moment</h2><p class="muted">Ce service n'est pas ouvert actuellement. Les envois de fichiers fonctionnent normalement.</p><a class="btn primary" href="/" data-link>${icon('upload')}Envoyer des fichiers</a></div></div></section>`; } };
const gate = (key, loader) => async () => { const cfg = await getConfig(); return cfg.modules && cfg.modules[key] === false ? { default: offView } : loader(); };
getConfig().then(cfg => { const m = cfg.modules || {}; document.querySelectorAll('[data-nav]').forEach(a => { if (m[a.dataset.nav] === false) a.hidden = true; }); }).catch(() => {});
route(/^\/reunion(?:\/([a-z0-9]{10}))?\/?$/, gate('meet', () => import('./meet.js')), 'meet', (m) => (m && m[1] ? { to: '/reunion', label: 'Réunions', skip: '#mtBar, .meet, #mtRoom' } : null));
route(/^\/recevoir\/?$/, () => import('./receive-code.js'), 'receive');
route(/^\/proximite\/?$/, gate('nearby', () => import('./nearby.js')), 'nearby');
route(/^\/classe(?:\/([A-Za-z0-9]{20}))?\/?$/, gate('classroom', () => import('./classroom.js')), 'classroom', (m) => (m && m[1] ? { to: '/classe', label: 'Classe' } : null));
route(/^\/w\/([A-Za-z0-9]{6,32})\/?$/, () => import('./watch.js'), null, (m) => ({ to: '/t/' + m[1], label: 'Retour aux fichiers' }));
route(/^\/demande\/?$/, () => import('./request.js').then(m => ({ default: m.createView })), 'send', () => ({ to: '/', label: 'Envoyer' }));
route(/^\/d\/([A-Za-z0-9]{6,32})\/?$/, () => import('./request.js').then(m => ({ default: m.depositView })), null, () => ({ to: '/', label: 'Accueil', inApp: true }));
route(/^\/r\/([A-Za-z0-9]{6,32})\/?$/, () => import('./request.js').then(m => ({ default: m.manageView })), 'dashboard');
route(/^\/direct\/?$/, gate('live', () => import('./live.js').then(m => ({ default: m.studioView }))), 'live');
route(/^\/live\/([A-Za-z0-9]{6,32})\/?$/, gate('live', () => import('./live.js').then(m => ({ default: m.roomView }))), 'live', () => ({ to: '/direct', label: 'Direct' }));
route(/^\/(conditions|confidentialite)\/?$/, () => import('./legal.js'), null, () => ({ to: '/', label: 'Accueil' }));
route(/^\/@([A-Za-z0-9-]{3,30})\/?$/, () => import('./handle.js'), null, () => ({ to: '/', label: 'Accueil', inApp: true }));
route(/^\/(a-propos|securite|faq)\/?$/, () => import('./pages.js'), null, () => ({ to: '/', label: 'Accueil' }));
route(/^\/(send|p2p|index\.html)?\/?$/, () => import('./send.js'), 'send');
route(/^.*$/, () => import('./pages.js'), null);

enableRipples();
startRouter();
document.addEventListener('click', (e) => { const b = e.target.closest('[data-feedback]'); if (!b) return; e.preventDefault(); openFeedback({ kind: b.dataset.feedback || 'avis' }); });

/* Sélecteur de fichiers interrompu par le système (Android, mémoire faible) */
try {
  if (ss.get('tx_picking')) {
    ss.del('tx_picking');
    setTimeout(() => toast('Le téléphone a rechargé la page pendant la sélection (mémoire faible). Fermez quelques onglets ou applications puis réessayez.', 'warn', { duration: 9000 }), 500);
  }
} catch (e) { /* ignore */ }
if (isWebView) setTimeout(() => toast('Navigateur intégré détecté : pour les gros fichiers, ouvrez Lestha Send dans Chrome ou Safari.', 'info', { duration: 8000 }), 900);

/* Compte enseignant (e-mail + code) : vos espaces sur tous vos appareils */
accountInit();

/* Statut réseau */
const net = $('#netStatus');
const setNet = () => { const on = navigator.onLine !== false; net.classList.toggle('off', !on); net.title = on ? 'En ligne' : 'Hors connexion'; net.setAttribute('aria-label', on ? 'Connexion Internet : en ligne' : 'Connexion Internet : hors connexion'); };
window.addEventListener('online', () => { setNet(); toast('Connexion rétablie', 'success'); });
window.addEventListener('offline', () => { setNet(); toast('Vous êtes hors connexion — les transferts reprendront automatiquement', 'warn'); });
setNet();

/* PWA : service worker + installation */
if ('serviceWorker' in navigator && isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('#btnInstall').classList.remove('hidden'); });
$('#btnInstall').onclick = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(() => {});
  deferredPrompt = null;
  $('#btnInstall').classList.add('hidden');
};

/* Tâches de fond légères */
setTimeout(async () => {
  const p2p = await import('./p2p.js'); p2p.cleanupOPFS();
  const d = await import('./dashboard.js'); d.updateNavBadge();
  setInterval(() => { if (document.visibilityState === 'visible') d.updateNavBadge(); }, 60000);
}, 2500);
