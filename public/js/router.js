/* Mini-routeur SPA (History API) */
const routes = [];
let current = null;
let token = 0;

export function route(pattern, load, nav) { routes.push({ re: pattern, load, nav }); }

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search + location.hash && !replace) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render();
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
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === r.nav));
  const root = document.getElementById('view');
  const mod = await r.load();
  if (my !== token) return;
  const view = mod.default;
  root.innerHTML = '';
  current = view;
  window.scrollTo(0, 0);
  await view.render(root, { match, params, hash: location.hash.slice(1) });
}

export function startRouter() {
  window.addEventListener('popstate', render);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || a.target === '_blank') return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  render();
}
