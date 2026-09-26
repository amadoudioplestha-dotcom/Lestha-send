/* TransferX — point d'entrée */
import { $, ss, toast, enableRipples, lowMemory, isWebView } from './core.js';
import { route, startRouter } from './router.js';

// Appareils modestes : effets allégés (évite les rechargements forcés par manque de mémoire)
if (lowMemory || /Android [4-8]\b/.test(navigator.userAgent)) document.documentElement.classList.add('lite');

route((path, params) => (path === '/' && params.get('room') ? [path] : null), () => import('./p2p.js').then(m => ({ default: m.receiveView })), 'send');
route(/^\/t\/([A-Za-z0-9]{6,32})\/?$/, () => import('./receive.js'), null);
route(/^\/m\/([A-Za-z0-9]{6,32})\/?$/, () => import('./manage.js'), 'dashboard');
route(/^\/dashboard\/?$/, () => import('./dashboard.js'), 'dashboard');
route(/^.*$/, () => import('./send.js'), 'send');

enableRipples();
startRouter();

/* Sélecteur de fichiers interrompu par le système (Android, mémoire faible) */
try {
  if (ss.get('tx_picking')) {
    ss.del('tx_picking');
    setTimeout(() => toast('Le téléphone a rechargé la page pendant la sélection (mémoire faible). Fermez quelques onglets ou applications puis réessayez.', 'warn', { duration: 9000 }), 500);
  }
} catch (e) { /* ignore */ }
if (isWebView) setTimeout(() => toast('Navigateur intégré détecté : pour les gros fichiers, ouvrez TransferX dans Chrome ou Safari.', 'info', { duration: 8000 }), 900);

/* Statut réseau */
const net = $('#netStatus');
const setNet = () => { const on = navigator.onLine !== false; net.classList.toggle('off', !on); net.title = on ? 'En ligne' : 'Hors connexion'; };
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
