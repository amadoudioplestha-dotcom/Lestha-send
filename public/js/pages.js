/* Lestha Send — pages de confiance : À propos, Sécurité, Questions fréquentes, page introuvable */
import { esc, icon, getConfig, bytes } from './core.js';

const DAY = 86400000;
const days = (ms) => Math.round((ms || 0) / DAY);
const links = () => `<div class="row wrap page-links">
  <a class="btn ghost sm" href="/a-propos" data-link>${icon('users', 'sm')}À propos</a>
  <a class="btn ghost sm" href="/securite" data-link>${icon('shield', 'sm')}Sécurité</a>
  <a class="btn ghost sm" href="/faq" data-link>${icon('message', 'sm')}Questions fréquentes</a>
  <a class="btn primary sm" href="/" data-link>${icon('upload', 'sm')}Envoyer des fichiers</a></div>`;

/* ---------------------------------------------------------------------- */
/*  À propos                                                               */
/* ---------------------------------------------------------------------- */
function about(cfg) {
  document.title = 'À propos · Lestha Send';
  const li = cfg.founderLinkedin;
  return `<section class="narrow stack page">
    <div class="hero">
      <span class="eyebrow"><span class="pulse-dot"></span>À propos</span>
      <h1 style="font-size:clamp(30px,5.4vw,46px)">Fait au Sénégal, <span class="grad-text">pour ceux qui envoient lourd.</span></h1>
      <p class="lead">Lestha Send est né d'un besoin simple : envoyer de gros fichiers rapidement, même avec une connexion moyenne et un forfait mobile limité.</p>
    </div>

    <div class="card founder">
      <div class="founder-photo"><img src="/img/fondateur.jpg" alt="Amadou Diop, fondateur de Lestha Send" loading="lazy" onerror="this.remove()"><span aria-hidden="true">AD</span></div>
      <div class="stack" style="gap:10px;min-width:0">
        <div><h2 style="font-size:24px">Amadou Diop</h2><p class="muted small">Fondateur de Lestha Send · Richard-Toll, Sénégal</p></div>
        <p>Professionnel du numérique éducatif et du multimédia, et fondateur de Lestha TV, je travaille chaque jour avec des vidéos, des photos et des documents trop lourds pour WhatsApp ou l'e-mail.</p>
        <p>J'ai créé Lestha Send pour que les envoyer devienne simple pour tout le monde : sans compte, sans limite de taille en mode Direct, et dans le respect de vos données.</p>
        ${li || cfg.contactEmail ? `<div class="row wrap" style="gap:8px;margin-top:2px">
          ${li ? `<a class="btn sm" href="${esc(li)}" target="_blank" rel="noopener">${icon('external', 'sm')}LinkedIn</a>` : ''}
          ${cfg.contactEmail ? `<a class="btn sm ghost" href="mailto:${esc(cfg.contactEmail)}">${icon('mail', 'sm')}${esc(cfg.contactEmail)}</a>` : ''}
        </div>` : ''}
      </div>
    </div>

    <div class="card stack">
      <h3>${icon('sparkles')}Ce qui guide Lestha Send</h3>
      <ul class="plain checks">
        <li>${icon('check', 'sm')}<span><b>Gratuit pour l'essentiel.</b> Le mode Direct et le partage à proximité restent illimités et sans compte.</span></li>
        <li>${icon('check', 'sm')}<span><b>Vos fichiers vous appartiennent.</b> Nous ne les lisons pas, ne les revendons pas et les supprimons à l'expiration du lien.</span></li>
        <li>${icon('check', 'sm')}<span><b>Pensé pour nos réseaux.</b> Reprise automatique après coupure, envoi direct entre appareils proches, interface légère.</span></li>
      </ul>
    </div>

    <div class="card row wrap between">
      <div><h3>Écoles, entreprises, associations</h3><p class="small muted">Une question, une idée ou un partenariat ? Écrivez-moi.</p></div>
      ${cfg.contactEmail ? `<a class="btn primary" href="mailto:${esc(cfg.contactEmail)}">${icon('mail', 'sm')}Me contacter</a>` : ''}
    </div>
    ${links()}
  </section>`;
}

/* ---------------------------------------------------------------------- */
/*  Sécurité                                                               */
/* ---------------------------------------------------------------------- */
function security() {
  document.title = 'Sécurité · Lestha Send';
  const flow = (steps) => `<div class="flow">${steps.map((s, i) => `${i ? `<div class="flow-arrow" aria-hidden="true">${icon('arrow-right', 'sm')}</div>` : ''}<div class="flow-step ${s[2] || ''}"><div class="flow-ic">${icon(s[0])}</div><span>${s[1]}</span></div>`).join('')}</div>`;
  return `<section class="narrow stack page">
    <div class="hero">
      <span class="eyebrow">${icon('shield', 'sm')}Sécurité</span>
      <h1 style="font-size:clamp(30px,5.4vw,46px)">Comment vos fichiers <span class="grad-text">sont protégés.</span></h1>
      <p class="lead">Trois façons d'envoyer, trois niveaux de protection. Voici ce qui se passe vraiment, sans jargon.</p>
    </div>

    <div class="card stack">
      <div class="row between wrap"><h3>${icon('bolt')}Mode Direct et À proximité</h3><span class="pill ok">Rien n'est stocké</span></div>
      ${flow([['phone', 'Votre appareil'], ['lock', 'Chiffré de bout en bout', 'accent'], ['monitor', 'L\'appareil du destinataire']])}
      <p class="small muted">Le fichier va directement d'un appareil à l'autre, chiffré pendant tout le trajet (WebRTC). Nos serveurs servent seulement à mettre les deux appareils en relation : ils ne voient jamais le fichier. Quand vous fermez la page, plus rien n'existe.</p>
    </div>

    <div class="card stack">
      <div class="row between wrap"><h3>${icon('cloud')}Mode Cloud (lien de téléchargement)</h3><span class="pill info">Supprimé automatiquement</span></div>
      ${flow([['phone', 'Votre appareil'], ['lock', 'Connexion HTTPS', 'accent'], ['cloud', 'Stockage sécurisé'], ['clock', 'Effacé à l\'expiration', 'muted']])}
      <p class="small muted">Le fichier est envoyé en HTTPS vers un stockage sécurisé (Cloudflare R2), puis supprimé automatiquement à la date d'expiration que vous choisissez. Vous pouvez aussi le supprimer à tout moment depuis votre tableau de bord.</p>
    </div>

    <div class="card stack">
      <h3>${icon('lock')}Les protections en place</h3>
      <ul class="plain checks">
        <li>${icon('check', 'sm')}<span><b>Liens impossibles à deviner.</b> Chaque lien contient un identifiant aléatoire.</span></li>
        <li>${icon('check', 'sm')}<span><b>Code PIN optionnel</b> de 6 à 8 chiffres. Après 20 erreurs, le lien se verrouille pendant une heure.</span></li>
        <li>${icon('check', 'sm')}<span><b>Expéditeur vérifié.</b> Quand l'expéditeur a confirmé son adresse e-mail, la page de téléchargement l'indique.</span></li>
        <li>${icon('check', 'sm')}<span><b>Bouton « Signaler »</b> sur chaque lien. Un lien signalé plusieurs fois est suspendu automatiquement, puis examiné.</span></li>
        <li>${icon('check', 'sm')}<span><b>Limites anti-abus</b> sur les envois, les e-mails et les tentatives, pour que le service reste rapide et sûr pour tous.</span></li>
        <li>${icon('check', 'sm')}<span><b>Aucun traceur publicitaire</b>, aucune revente de données.</span></li>
      </ul>
    </div>

    <div class="banner info">${icon('shield')}<span><b>Nos conseils :</b> pour un document sensible, utilisez le mode Direct ou ajoutez un code PIN, choisissez une durée courte, et transmettez le code par un autre moyen que le lien (appel, SMS).</span></div>
    ${links()}
  </section>`;
}

/* ---------------------------------------------------------------------- */
/*  Questions fréquentes                                                   */
/* ---------------------------------------------------------------------- */
function faq(cfg) {
  document.title = 'Questions fréquentes · Lestha Send';
  const free = (cfg.limits && cfg.limits.free) || {};
  const ver = (cfg.limits && cfg.limits.verified) || {};
  const Q = [
    ['Est-ce vraiment gratuit ?', 'Oui. Le mode Direct et le partage à proximité sont gratuits et illimités. Le mode Cloud est gratuit dans les limites indiquées ci-dessous.'],
    ['Quelle taille puis-je envoyer ?', `En mode Direct : aucune limite, le fichier passe d'un appareil à l'autre. En mode Cloud : ${free.maxBytes ? bytes(free.maxBytes, 0) : '2 Go'} par envoi sans compte, ${ver.maxBytes ? bytes(ver.maxBytes, 0) : '10 Go'} avec une adresse e-mail confirmée.`],
    ['Combien de temps mon lien reste-t-il valable ?', `Vous choisissez la durée : jusqu'à ${days(free.maxTtl) || 3} jours sans compte, ${days(ver.maxTtl) || 7} jours avec une adresse confirmée. Ensuite, les fichiers sont supprimés automatiquement.`],
    ['Quelle différence entre Direct et Cloud ?', 'Direct : le fichier va en temps réel de votre appareil à celui du destinataire, sans être stocké. Il faut garder la page ouverte pendant l\'envoi. Cloud : vous déposez le fichier, vous partagez un lien, et le destinataire le télécharge quand il veut, même si vous êtes déconnecté.'],
    ['Faut-il créer un compte ?', 'Non. Pour aller plus loin (fichiers plus lourds, envoi du lien par e-mail, lien personnel @nom), il suffit de confirmer votre adresse e-mail avec un code à 6 chiffres. Pas de mot de passe.'],
    ['Que se passe-t-il si ma connexion coupe ?', 'L\'envoi reprend automatiquement là où il s\'était arrêté quand la connexion revient. Vous n\'avez rien à refaire.'],
    ['Comment protéger un fichier sensible ?', 'Ajoutez un code PIN de 6 à 8 chiffres au moment de l\'envoi et communiquez-le séparément. Vous pouvez aussi limiter le nombre de téléchargements ou supprimer le lien à tout moment.'],
    ['Comment recevoir des fichiers de plusieurs personnes ?', 'Créez un espace Smart Drop (décrivez votre besoin : candidatures, devoirs, photos…, le formulaire est prêt), ou réservez votre lien personnel lestha-send.com/@votre-nom : chacun y dépose ses fichiers et vous les retrouvez au même endroit.'],
    ['Lestha Send fonctionne-t-il sur téléphone ?', 'Oui, sur Android, iPhone et ordinateur, directement dans le navigateur. Vous pouvez aussi l\'installer comme une application depuis le menu de votre navigateur.'],
    ['Quelqu\'un m\'a envoyé un lien suspect, que faire ?', 'Ne téléchargez rien et utilisez le bouton « Signaler » de la page. Un lien signalé plusieurs fois est suspendu automatiquement.']
  ];
  return `<section class="narrow stack page">
    <div class="hero">
      <span class="eyebrow">${icon('message', 'sm')}Aide</span>
      <h1 style="font-size:clamp(30px,5.4vw,46px)">Questions <span class="grad-text">fréquentes.</span></h1>
      <p class="lead">Tout ce qu'il faut savoir pour bien envoyer vos fichiers.</p>
    </div>
    <div class="faq">${Q.map(([q, a], i) => `<details class="card faq-item"${i === 0 ? ' open' : ''}><summary><span>${esc(q)}</span>${icon('plus', 'sm')}</summary><p class="muted">${esc(a)}</p></details>`).join('')}</div>
    <div class="card row wrap between"><div><h3>Vous ne trouvez pas votre réponse ?</h3><p class="small muted">Écrivez-nous, nous répondons rapidement.</p></div>${cfg.contactEmail ? `<a class="btn" href="mailto:${esc(cfg.contactEmail)}">${icon('mail', 'sm')}Nous écrire</a>` : ''}</div>
    ${links()}
  </section>`;
}

/* ---------------------------------------------------------------------- */
/*  Page introuvable                                                       */
/* ---------------------------------------------------------------------- */
function notFound() {
  document.title = 'Page introuvable · Lestha Send';
  return `<section class="narrow"><div class="card glow"><div class="state-screen">
    <div class="nf-code grad-text">404</div>
    <h2>Cette page n'existe pas</h2>
    <p class="muted">Le lien est peut-être incomplet, ou le fichier a expiré et a été supprimé. Vérifiez l'adresse auprès de la personne qui vous l'a envoyée.</p>
    <div class="row wrap" style="justify-content:center"><a class="btn primary" href="/" data-link>${icon('upload', 'sm')}Envoyer des fichiers</a><a class="btn ghost" href="/faq" data-link>${icon('message', 'sm')}Questions fréquentes</a></div>
  </div></div></section>`;
}

export default {
  async render(root) {
    const p = location.pathname.replace(/\/$/, '');
    if (p === '/securite') { root.innerHTML = security(); return; }
    if (p === '/a-propos' || p === '/faq') {
      const cfg = await getConfig().catch(() => ({}));
      root.innerHTML = p === '/faq' ? faq(cfg) : about(cfg);
      return;
    }
    root.innerHTML = notFound();
  },
  destroy() { }
};
