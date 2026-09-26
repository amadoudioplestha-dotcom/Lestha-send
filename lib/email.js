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

  async function send({ to, subject, text, html }) {
    if (!enabled) throw Object.assign(new Error('Service e-mail non configuré'), { status: 503 });
    if (sendgridOk) {
      await sgMail.send({
        to, from: { email: from, name: 'TransferX' }, replyTo: from, subject, text, html,
        trackingSettings: { clickTracking: { enable: false, enableText: false }, openTracking: { enable: false } }
      });
    } else {
      await smtp.sendMail({ from: `TransferX <${from}>`, to, subject, text, html });
    }
  }

  function layout(title, inner) {
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0b1220;">
<div style="font-family:Inter,Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:28px 18px;">
  <div style="color:#00b4d8;font-size:12px;letter-spacing:.18em;font-weight:800;margin-bottom:14px;">TRANSFERX</div>
  <div style="background:#131d33;border:1px solid #24324d;border-radius:18px;padding:26px;">
    <h2 style="color:#f1f5f9;font-size:21px;margin:0 0 14px;">${esc(title)}</h2>
    ${inner}
  </div>
  <p style="color:#64748b;font-size:12px;line-height:1.6;text-align:center;margin:18px 0 0;">Envoyé avec TransferX · transfert sécurisé</p>
</div></body></html>`;
  }

  /** E-mail au destinataire : lien de téléchargement */
  function transferEmail({ t, link, senderName }) {
    const files = t.files.slice(0, 8).map(f => `<tr><td style="color:#cbd5e1;font-size:14px;padding:6px 0;border-bottom:1px solid #24324d;">${esc(f.path || f.name)}</td><td style="color:#94a3b8;font-size:13px;text-align:right;padding:6px 0;border-bottom:1px solid #24324d;white-space:nowrap;">${bytes(f.size)}</td></tr>`).join('');
    const more = t.files.length > 8 ? `<p style="color:#94a3b8;font-size:13px;margin:8px 0 0;">+ ${t.files.length - 8} autre(s) fichier(s)</p>` : '';
    const who = senderName ? esc(senderName) + ' vous a envoyé' : 'On vous a envoyé';
    const exp = new Date(t.expiresAt).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Dakar' });
    const title = t.title || (t.files.length === 1 ? t.files[0].name : `${t.files.length} fichiers`);
    const html = layout(`${who} ${t.files.length > 1 ? t.files.length + ' fichiers' : 'un fichier'}`, `
      ${t.message ? `<p style="color:#e2e8f0;font-size:15px;line-height:1.55;background:#0f1729;border-left:3px solid #00b4d8;padding:12px 14px;border-radius:8px;margin:0 0 18px;">${esc(t.message)}</p>` : ''}
      <table style="width:100%;border-collapse:collapse;margin:0 0 6px;">${files}</table>${more}
      <p style="color:#94a3b8;font-size:13px;margin:12px 0 22px;">Total : <strong style="color:#e2e8f0;">${bytes(t.totalSize)}</strong> · Disponible jusqu'au ${esc(exp)}${t.pin ? ' · 🔒 protégé par un code PIN' : ''}</p>
      <p style="text-align:center;margin:0 0 8px;"><a href="${esc(link)}" style="background:linear-gradient(90deg,#00b4d8,#06d6a0);color:#04121f;padding:15px 30px;text-decoration:none;border-radius:12px;display:inline-block;font-weight:800;font-size:16px;">Télécharger</a></p>
      <p style="color:#64748b;font-size:12px;text-align:center;word-break:break-all;margin:14px 0 0;">${esc(link)}</p>`);
    const text = `${who.replace(/<[^>]+>/g, '')} : ${title}\n${t.message ? '\n« ' + t.message + ' »\n' : ''}\nTotal : ${bytes(t.totalSize)} — disponible jusqu'au ${exp}\n\nTélécharger : ${link}\n\n— TransferX`;
    return { subject: `📦 ${title} — ${bytes(t.totalSize)} vous attendent`, html, text };
  }

  /** E-mail à l'expéditeur : premier téléchargement */
  function downloadNotice({ t, manageLink, fileName, device }) {
    const title = t.title || (t.files.length === 1 ? t.files[0].name : `${t.files.length} fichiers`);
    const html = layout('Votre transfert a été téléchargé ✅', `
      <p style="color:#cbd5e1;font-size:15px;line-height:1.55;margin:0 0 18px;"><strong>${esc(fileName || title)}</strong> vient d'être téléchargé depuis un ${esc(device || 'appareil')}.</p>
      <p style="text-align:center;margin:0;"><a href="${esc(manageLink)}" style="background:#1e2a44;color:#e2e8f0;border:1px solid #334155;padding:12px 24px;text-decoration:none;border-radius:12px;display:inline-block;font-weight:700;">Voir le tableau de bord</a></p>`);
    return { subject: `✅ Téléchargé : ${title}`, html, text: `${fileName || title} vient d'être téléchargé.\nTableau de bord : ${manageLink}` };
  }

  /** Ancien format (mode P2P) */
  function p2pEmail({ link, fileName }) {
    const html = layout('Un fichier vous attend', `
      <p style="color:#cbd5e1;font-size:15px;margin:0 0 20px;">Le fichier <strong>${esc(fileName || 'sans nom')}</strong> vous a été envoyé en <strong>transfert direct</strong>.</p>
      <p style="text-align:center;margin:0 0 16px;"><a href="${esc(link)}" style="background:linear-gradient(90deg,#00b4d8,#06d6a0);color:#04121f;padding:15px 30px;text-decoration:none;border-radius:12px;display:inline-block;font-weight:800;">Récupérer le fichier</a></p>
      <p style="color:#94a3b8;font-size:13px;margin:0;">Transfert direct chiffré de bout en bout : le lien fonctionne tant que l'expéditeur garde TransferX ouvert.</p>`);
    return { subject: `Un fichier vous attend : ${fileName || 'sans nom'}`, html, text: `Un fichier vous attend : ${fileName}\n${link}\n\nLe lien fonctionne tant que l'expéditeur garde TransferX ouvert.` };
  }

  return { enabled, provider: sendgridOk ? 'sendgrid' : (smtp ? 'smtp' : null), send, transferEmail, downloadNotice, p2pEmail };
}

module.exports = { createMailer, bytes };
