/* Lestha Send — « Recevoir » : saisir le code à 6 chiffres donné par l'expéditeur */
import { $, esc, icon, ls, toast, getSocket } from './core.js';
import { navigate } from './router.js';

/** Accepte aussi un lien collé (Direct ou Cloud) ou un identifiant TX-… */
function fromPasted(v) {
  const s = String(v || '').trim();
  const room = s.match(/room=(TX-[A-Z0-9]{6,8})/i) || s.match(/^(TX-[A-Z0-9]{6,8})$/i);
  if (room) return '/?room=' + room[1].toUpperCase();
  const t = s.match(/\/t\/([A-Za-z0-9]{6,32})/);
  if (t) return '/t/' + t[1];
  return null;
}

export default {
  async render(root, { params }) {
    document.title = 'Recevoir · Lestha Send';
    const pre = (params.get('code') || '').replace(/\D/g, '').slice(0, 6);
    root.innerHTML = `
    <section class="narrow"><div class="card glow"><div class="state-screen">
      <div class="state-icon info">${icon('download')}</div>
      <h2>Recevoir des fichiers</h2>
      <p class="muted">Saisissez le code à 6 chiffres affiché sur l'écran de l'expéditeur.</p>
      <form id="rcForm" class="stack" style="width:100%;max-width:360px;margin-top:8px" autocomplete="off">
        <input class="input rc-code" id="rcCode" inputmode="numeric" autocomplete="one-time-code" maxlength="80" placeholder="000 000" aria-label="Code à 6 chiffres" value="${esc(pre)}">
        <input class="input" id="rcName" maxlength="30" placeholder="Votre prénom (facultatif, vu par l'expéditeur)" value="${esc(ls.get('tx_rc_name', ''))}">
        <button class="btn primary block xl" type="submit" id="rcGo">${icon('download')}Recevoir</button>
        <p class="small faint" id="rcHint">Fichiers ou réunion : le même code. En mode Direct, l'expéditeur doit accepter votre appareil.</p>
      </form>
    </div></div></section>`;
    const input = $('#rcCode', root);
    setTimeout(() => input.focus(), 60);
    input.addEventListener('input', () => {
      if (fromPasted(input.value)) return;
      const d = input.value.replace(/\D/g, '').slice(0, 6);
      input.value = d.length > 3 ? d.slice(0, 3) + ' ' + d.slice(3) : d;
      if (d.length === 6) $('#rcGo', root).focus();
    });
    $('#rcForm', root).onsubmit = async (e) => {
      e.preventDefault();
      const direct = fromPasted(input.value);
      if (direct) return navigate(direct);
      const code = input.value.replace(/\D/g, '');
      if (code.length !== 6) { toast('Le code contient 6 chiffres', 'warn'); input.focus(); return; }
      const name = $('#rcName', root).value.trim();
      ls.set('tx_rc_name', name);
      const btn = $('#rcGo', root), hint = $('#rcHint', root);
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Recherche…';
      let socket;
      try { socket = await getSocket(); } catch (err) { socket = null; }
      if (!socket) { btn.disabled = false; btn.innerHTML = icon('download') + 'Recevoir'; return toast('Connexion impossible. Vérifiez votre réseau.', 'error'); }
      const slow = setTimeout(() => { btn.innerHTML = '<span class="spinner"></span>En attente de l\'expéditeur…'; hint.textContent = 'Une demande a été envoyée à l\'expéditeur : il doit appuyer sur « Accepter ».'; }, 1200);
      socket.timeout(100000).emit('code-lookup', { code, name }, (err, r) => {
        clearTimeout(slow);
        btn.disabled = false; btn.innerHTML = icon('download') + 'Recevoir';
        hint.textContent = 'En mode Direct, l\'expéditeur doit accepter votre appareil avant que le transfert commence.';
        if (err || !r) return toast('Pas de réponse. Réessayez.', 'error');
        if (r.error) return toast(r.error, 'error');
        if (r.path) navigate(r.path);
      });
    };
  },
  destroy() {}
};
