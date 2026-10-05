/* Mini-routeur SPA (History API) */
const routes = [];
let current = null;
let token = 0;
let backObs = null;

/**
 * back (facultatif) : bouton « Retour » ajouté en haut de la page.
 *   (match, path) => ({ to, label, inApp, skip }) | null
 *   to : page de repli si l'on arrive directement par un lien · inApp : seulement après une navigation dans le site
 *   skip : sélecteur ; si présent dans la page (ex. salle de réunion ouverte), pas de bouton
 */
export function route(pattern, load, nav, back) { routes.push({ re: pattern, load, nav, back }); }

/** Position dans l'historique du site : > 0 = on peut revenir à la page précédente du site */
const idx = () => (history.state && history.state.idx) || 0;
export const canGoBack = () => idx() > 0;
export function goBack(fallback) { if (canGoBack()) history.back(); else navigate(fallback || '/'); }

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search + location.hash && !replace) return;
  history[replace ? 'replaceState' : 'pushState']({ idx: replace ? idx() : idx() + 1 }, '', path);
  render();
}

const BACK_ICON = '<svg class="i sm" aria-hidden="true"><use href="#i-arrow-left"/></svg>';
/** Ajoute le bouton Retour (et le remet si la page se redessine, ex. chargement puis contenu) */
function placeBack(root, r, match, path) {
  if (backObs) { backObs.disconnect(); backObs = null; }
  const cfg = r.back && r.back(match, path);
  if (!cfg || (cfg.inApp && !canGoBack())) return;
  const put = () => {
    if (root.querySelector('[data-back]') || (cfg.skip && root.querySelector(cfg.skip))) return;
    const slot = root.querySelector('[data-back-slot]') || root.querySelector('section'); if (!slot) return;
    const a = document.createElement('a');
    a.href = cfg.to; a.className = 'btn ghost sm back-link'; a.setAttribute('data-back', '');
    a.innerHTML = BACK_ICON + '<span>' + (canGoBack() ? 'Retour' : (cfg.label || 'Retour')) + '</span>';
    slot.prepend(a);
  };
  put();
  backObs = new MutationObserver(put); backObs.observe(root, { childList: true });
}

export async function render() {
  const my = ++token;
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  let match = null, r = null;
  for (const x of routes) {
    const m = typeof x.re === 'function' ? x.re(path, params) : path.match(x.re);
    if (m) { match = m; r = x; break; }
  }
  if (!r) { r = routes[0]; match = []; }
  if (current && current.destroy) { try { current.destroy(); } catch (e) { console.error(e); } }
  current = null;
  document.querySelectorAll('[data-nav]').forEach(a => {
    const active = a.dataset.nav === r.nav;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const root = document.getElementById('view');
  const mod = await r.load();
  if (my !== token) return;
  const view = mod.default;
  root.innerHTML = '';
  current = view;
  window.scrollTo(0, 0);
  await view.render(root, { match, params, hash: location.hash.slice(1) });
  if (my === token) placeBack(root, r, match, path);
  root.focus({ preventScroll: true });
  try { window.dispatchEvent(new CustomEvent('tx:route', { detail: { nav: r.nav, path } })); } catch (e) { /* ignore */ }
}

export function startRouter() {
  if (!history.state || history.state.idx == null) history.replaceState(Object.assign({}, history.state, { idx: 0 }), '');
  window.addEventListener('popstate', render);
  document.addEventListener('click', (e) => {
    const bk = e.target.closest('[data-back]');
    if (bk && !(e.ctrlKey || e.metaKey || e.shiftKey)) { e.preventDefault(); goBack(bk.getAttribute('href')); return; }
    const a = e.target.closest('a[data-link]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || a.target === '_blank') return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  render();
}
