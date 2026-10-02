/* Lestha Send — lien personnel lestha-send.com/@nom : résout le nom puis affiche la page de dépôt */
import { esc, icon, api } from './core.js';
import { depositView } from './request.js';

export default {
  async render(root, { match, params }) {
    const name = String(match[1] || '').toLowerCase();
    root.innerHTML = `<section class="narrow"><div class="skeleton" style="height:380px;border-radius:20px"></div></section>`;
    let h;
    try { h = await api('/api/public/h/' + encodeURIComponent(name)); }
    catch (e) {
      document.title = 'Lien introuvable · Lestha Send';
      root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon bad">${icon('x')}</div><h2>@${esc(name)} n'existe pas</h2><p class="muted">Vérifiez l'orthographe du lien auprès de la personne qui vous l'a donné.</p><a class="btn primary" href="/" data-link>${icon('upload', 'sm')}Découvrir Lestha Send</a></div></div></section>`;
      return;
    }
    document.title = '@' + h.name + ' · Lestha Send';
    return depositView.render(root, { match: [null, h.id], params });
  },
  destroy() { return depositView.destroy(); }
};
