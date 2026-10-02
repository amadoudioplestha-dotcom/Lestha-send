'use strict';
/** Envoi d'e-mails : SendGrid (prioritaire) ou SMTP (nodemailer) */
let sgMail = null;
try { sgMail = require('@sendgrid/mail'); } catch (e) { /* optionnel */ }
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* optionnel */ }

const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function bytes(n) {
  if (!n) return '0 o';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return (n / Math.pow(1024, i)).toFixed(i < 2 ? 0 : 1) + ' ' + u[i];
}

function createMailer(env) {
  const APP = String(env.APP_NAME || 'Lestha Send');
  const site = () => String(env.PUBLIC_URL || '').replace(/\/$/, '');
  const from = env.SENDGRID_FROM_EMAIL || env.SMTP_FROM;
  const sendgridOk = !!(sgMail && env.SENDGRID_API_KEY && from);
  let smtp = null;
  if (!sendgridOk && nodemailer && env.SMTP_HOST && from) {
    smtp = nodemailer.createTransport({
      host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
    });
  }
  if (sendgridOk) sgMail.setApiKey(env.SENDGRID_API_KEY);
  const enabled = sendgridOk || !!smtp;
  // Les réponses des destinataires arrivent sur l'adresse de contact (jamais sur une adresse noreply)
  const replyTo = env.CONTACT_EMAIL || from;

  async function send({ to, subject, text, html }) {
    if (!enabled) throw Object.assign(new Error('Service e-mail non configuré'), { status: 503 });
    if (sendgridOk) {
      await sgMail.send({
        to, from: { email: from, name: APP }, replyTo, subject, text, html,
        trackingSettings: { clickTracking: { enable: false, enableText: false }, openTracking: { enable: false } }
      });
    } else {
      await smtp.sendMail({ from: `${APP} <${from}>`, replyTo, to, subject, text, html });
    }
  }

  /* -------- Gabarit commun : carte claire, bandeau aux couleurs du logo -------- */
  const C = { ink: '#0b1b2e', text: '#334155', muted: '#64748b', line: '#e2e8f0', soft: '#f1f7fb', cyan: '#0284a8' };
  const p = (html, extra = '') => `<p style="color:${C.text};font-size:15px;line-height:1.6;margin:0 0 16px;${extra}">${html}</p>`;
  const small = (html, extra = '') => `<p style="color:${C.muted};font-size:13px;line-height:1.6;margin:0 0 14px;${extra}">${html}</p>`;
  const button = (href, label) => `<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:6px auto 4px;"><tr><td style="border-radius:12px;background:#00b4d8;background-image:linear-gradient(90deg,#00b4d8,#06d6a0);"><a href="${esc(href)}" style="display:inline-block;padding:14px 30px;color:#04121f;font-weight:800;font-size:16px;text-decoration:none;border-radius:12px;">${esc(label)}</a></td></tr></table>`;
  const quote = (text) => `<div style="color:${C.ink};font-size:15px;line-height:1.6;background:${C.soft};border-left:3px solid #00b4d8;padding:12px 14px;border-radius:8px;margin:0 0 18px;">${esc(text)}</div>`;

  /** Pied de message : invitation à utiliser le service + signalement d'abus */
  function footer(reportLink) {
    const s = site();
    return `<p style="color:${C.muted};font-size:12px;line-height:1.7;text-align:center;margin:20px 0 0;">Envoyé avec ${esc(APP)}${s ? ` · <a href="${esc(s)}" style="color:${C.cyan};">Envoyez vous aussi vos fichiers, gratuitement</a>` : ''}${reportLink ? `<br><a href="${esc(reportLink)}" style="color:${C.muted};">Signaler un envoi abusif</a>` : ''}</p>`;
  }

  function layout(title, inner, reportLink) {
    const s = site();
    const logo = s ? `<img src="${esc(s)}/icon-192.png" width="34" height="34" alt="" style="display:inline-block;vertical-align:middle;border:0;border-radius:9px;margin-right:10px;">` : '';
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#eef4f9;">
<div style="font-family:Inter,Segoe UI,Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:28px 16px;">
  <div style="margin:0 0 16px;padding:0 4px;">${logo}<span style="vertical-align:middle;font-size:19px;font-weight:800;color:${C.ink};letter-spacing:-.01em;">Lestha <span style="color:#00a3c4;">Send</span></span></div>
  <div style="background:#ffffff;border:1px solid ${C.line};border-radius:18px;overflow:hidden;">
    <div style="height:5px;background:#00b4d8;background-image:linear-gradient(90deg,#00b4d8,#06d6a0);"></div>
    <div style="padding:26px 24px;">
      <h1 style="color:${C.ink};font-size:21px;line-height:1.3;margin:0 0 16px;">${esc(title)}</h1>
      ${inner}
    </div>
  </div>
  ${footer(reportLink)}
</div></body></html>`;
  }

  /** E-mail au destinataire : lien de téléchargement */
  function transferEmail({ t, link, senderName, senderEmail }) {
    const files = t.files.slice(0, 8).map(f => `<tr><td style="color:${C.ink};font-size:14px;padding:8px 0;border-bottom:1px solid ${C.line};word-break:break-all;">${esc(f.path || f.name)}</td><td style="color:${C.muted};font-size:13px;text-align:right;padding:8px 0 8px 12px;border-bottom:1px solid ${C.line};white-space:nowrap;">${bytes(f.size)}</td></tr>`).join('');
    const more = t.files.length > 8 ? small(`+ ${t.files.length - 8} autre(s) fichier(s)`, 'margin:8px 0 0;') : '';
    const who = senderName ? esc(senderName) + ' vous a envoyé' : 'On vous a envoyé';
    // L'adresse de l'expéditeur a été vérifiée par code : c'est la seule information garantie
    const verified = senderEmail ? small(`Expéditeur : <strong style="color:${C.ink};">${esc(senderEmail)}</strong> ✓ adresse vérifiée. Le nom et le message sont écrits par l'expéditeur.`) : '';
    const exp = new Date(t.expiresAt).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Dakar' });
    const title = t.title || (t.files.length === 1 ? t.files[0].name : `${t.files.length} fichiers`);
    const html = layout(`${who} ${t.files.length > 1 ? t.files.length + ' fichiers' : 'un fichier'}`, `
      ${verified}${t.message ? quote(t.message) : ''}
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 6px;">${files}</table>${more}
      ${small(`Total : <strong style="color:${C.ink};">${bytes(t.totalSize)}</strong> · disponible jusqu'au ${esc(exp)}${t.pin ? ' · 🔒 protégé par un code PIN' : ''}`, 'margin:12px 0 20px;')}
      ${button(link, 'Télécharger')}
      ${small(esc(link), 'text-align:center;word-break:break-all;margin:14px 0 0;font-size:12px;')}`, link + '?signaler=1');
    const text = `${who.replace(/<[^>]+>/g, '')} : ${title}\n${senderEmail ? 'Expéditeur vérifié : ' + senderEmail + '\n' : ''}${t.message ? '\n« ' + t.message + ' »\n' : ''}\nTotal : ${bytes(t.totalSize)} — disponible jusqu'au ${exp}\n\nTélécharger : ${link}\nSignaler un abus : ${link}?signaler=1\n\n— ${APP}`;
    return { subject: `📦 ${title} — ${bytes(t.totalSize)} vous attendent`, html, text };
  }

  /** E-mail à l'expéditeur : premier téléchargement */
  function downloadNotice({ t, manageLink, fileName, device }) {
    const title = t.title || (t.files.length === 1 ? t.files[0].name : `${t.files.length} fichiers`);
    const html = layout('Votre envoi a été téléchargé ✅', `
      ${p(`<strong style="color:${C.ink};">${esc(fileName || title)}</strong> vient d'être téléchargé depuis un ${esc(device || 'appareil')}.`)}
      ${button(manageLink, 'Voir le tableau de bord')}`);
    return { subject: `✅ Téléchargé : ${title}`, html, text: `${fileName || title} vient d'être téléchargé.\nTableau de bord : ${manageLink}` };
  }

  /** Lien direct (mode P2P) */
  function p2pEmail({ link, fileName, sender }) {
    const html = layout('Un fichier vous attend', `
      ${p(`Le fichier <strong style="color:${C.ink};">${esc(fileName || 'sans nom')}</strong> vous a été envoyé en <strong>transfert direct</strong>${sender ? ` par <strong style="color:${C.ink};">${esc(sender)}</strong> (adresse vérifiée)` : ''}.`)}
      ${button(link, 'Récupérer le fichier')}
      ${small(`Transfert direct chiffré de bout en bout : le lien fonctionne tant que l'expéditeur garde ${esc(APP)} ouvert.`, 'margin:16px 0 0;')}`);
    return { subject: `Un fichier vous attend : ${fileName || 'sans nom'}`, html, text: `Un fichier vous attend : ${fileName}\n${sender ? 'Expéditeur vérifié : ' + sender + '\n' : ''}${link}\n\nLe lien fonctionne tant que l'expéditeur garde ${APP} ouvert.` };
  }

  /** Message simple au gabarit Lestha Send (code, alertes, dépôts…) */
  function simple({ title, paragraphs = [], action, note }) {
    return layout(title, paragraphs.map(x => p(x)).join('') + (action ? button(action.href, action.label) : '') + (note ? small(note, 'margin:16px 0 0;') : ''));
  }

  return { enabled, provider: sendgridOk ? 'sendgrid' : (smtp ? 'smtp' : null), appName: APP, send, transferEmail, downloadNotice, p2pEmail, layout, simple, esc };
}

module.exports = { createMailer, bytes };
