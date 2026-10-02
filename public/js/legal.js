/* Lestha Send — pages « Conditions d'utilisation » et « Confidentialité »
 * Texte de base à faire relire : il décrit fidèlement le fonctionnement du service,
 * mais ne remplace pas l'avis d'un juriste. */
import { esc, icon, getConfig, bytes } from './core.js';

const DAY = 86400000;
const days = (ms) => Math.round((ms || 0) / DAY);

function page(title, intro, sections, contact) {
  return `<section class="narrow stack legal">
    <div class="card stack">
      <span class="eyebrow">${icon('shield')}Lestha Send</span>
      <h2>${esc(title)}</h2>
      <p class="muted">${intro}</p>
      ${sections.map(([h, body]) => `<h3 style="margin-top:14px">${esc(h)}</h3>${body}`).join('')}
      <h3 style="margin-top:14px">Contact</h3>
      <p>${contact ? `Pour toute question ou demande : <b>${esc(contact)}</b>.` : 'Pour toute question, utilisez le lien « Signaler » présent sur chaque page de téléchargement.'}</p>
      <p class="small faint">Dernière mise à jour : octobre 2026.</p>
      <div class="row wrap"><a class="btn ghost" href="/conditions" data-link>Conditions d'utilisation</a><a class="btn ghost" href="/confidentialite" data-link>Confidentialité</a><a class="btn primary" href="/" data-link>${icon('upload')}Envoyer des fichiers</a></div>
    </div>
  </section>`;
}

export default {
  async render(root) {
    const cfg = await getConfig();
    const free = (cfg.limits && cfg.limits.free) || {};
    const ver = (cfg.limits && cfg.limits.verified) || {};
    const contact = cfg.contactEmail || '';
    if (location.pathname.startsWith('/confidentialite')) {
      document.title = 'Confidentialité · Lestha Send';
      root.innerHTML = page('Confidentialité', 'Ce que Lestha Send conserve, pourquoi, et pendant combien de temps.', [
        ['Mode Direct et À proximité', '<p>Les fichiers passent directement d\'un appareil à l\'autre, chiffrés pendant le transfert. Ils ne sont jamais stockés sur nos serveurs. Le serveur ne fait que mettre les deux appareils en relation.</p>'],
        ['Mode Cloud', `<p>Les fichiers sont conservés sur un stockage sécurisé (Cloudflare R2) jusqu'à l'expiration du lien choisie par l'expéditeur, puis supprimés automatiquement dans l'heure qui suit. L'expéditeur peut aussi les supprimer à tout moment depuis son tableau de bord.</p>`],
        ['Ce qui est enregistré', '<ul class="plain"><li>Les noms, tailles et types des fichiers, le titre et le message saisis par l\'expéditeur.</li><li>Les statistiques du lien : nombre de vues et de téléchargements, type d\'appareil et de navigateur.</li><li>Une empreinte de l\'adresse IP (jamais l\'adresse en clair), pour lutter contre les abus.</li><li>Votre adresse e-mail, seulement si vous la confirmez ou si vous envoyez un lien par e-mail.</li></ul>'],
        ['Ce que nous ne faisons pas', '<p>Nous ne lisons pas le contenu de vos fichiers, ne revendons aucune donnée et n\'utilisons aucun traceur publicitaire. L\'administrateur du service ne voit que les informations ci-dessus, jamais le contenu des fichiers.</p>'],
        ['Vos droits', '<p>Vous pouvez demander l\'accès, la correction ou la suppression des informations vous concernant. Au Sénégal, la protection des données personnelles relève de la Commission de protection des données personnelles (CDP).</p>']
      ], contact);
    } else {
      document.title = 'Conditions d\'utilisation · Lestha Send';
      root.innerHTML = page('Conditions d\'utilisation', 'En utilisant Lestha Send, vous acceptez les règles ci-dessous.', [
        ['Le service', `<p>Lestha Send permet d'envoyer des fichiers en mode Direct (sans stockage, sans limite de taille), en mode Cloud (lien de téléchargement temporaire) et à proximité entre vos appareils. Le service est gratuit.</p>`],
        ['Limites du mode Cloud', `<ul class="plain"><li>Sans compte : ${free.maxBytes ? bytes(free.maxBytes, 0) : '—'} par envoi, liens de ${days(free.maxTtl) || '—'} jours.</li><li>Avec une adresse e-mail confirmée : ${ver.maxBytes ? bytes(ver.maxBytes, 0) : '—'} par envoi, liens de ${days(ver.maxTtl) || '—'} jours, envoi du lien par e-mail et demandes de fichiers.</li><li>Un nombre d'envois par jour s'applique pour garantir le service à tous.</li></ul>`],
        ['Contenus interdits', '<p>Il est interdit d\'envoyer des contenus illégaux, des logiciels malveillants, des contenus portant atteinte aux droits d\'autrui, ou d\'utiliser le service pour tromper des personnes (hameçonnage, fausses factures, arnaques). Tout lien signalé à plusieurs reprises est suspendu automatiquement, puis examiné.</p>'],
        ['Votre responsabilité', '<p>Vous êtes responsable des fichiers que vous envoyez et des personnes à qui vous les transmettez. Protégez les fichiers sensibles par un code PIN et choisissez une durée de lien adaptée.</p>'],
        ['Disponibilité', '<p>Nous faisons notre possible pour que le service fonctionne en permanence, mais ne pouvons pas le garantir. Conservez toujours une copie de vos fichiers importants : un lien expiré ne peut pas être récupéré.</p>'],
        ['Signaler un abus', '<p>Chaque page de téléchargement comporte un lien « Signaler ». Les signalements sont examinés et peuvent entraîner la suppression du lien et le blocage de son expéditeur.</p>']
      ], contact);
    }
  },
  destroy() { }
};
