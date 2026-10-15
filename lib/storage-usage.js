'use strict';
/**
 * Suivi du stockage Cloudflare R2 (3.28).
 *
 * R2 est gratuit jusqu'à 10 Go stockés, puis environ 0,015 $ par Go et par mois. Le serveur fait
 * l'inventaire du bucket (toutes les 6 h, ou à la demande depuis la console) et le range par usage :
 * fichiers envoyés, aperçus, qualités vidéo, documents de réunion, données de l'application.
 * Alerte par e-mail (ADMIN_EMAIL) à 80 % et 100 % de R2_FREE_GB (10 par défaut), une fois par mois.
 * L'inventaire coûte peu : une requête de liste pour 1 000 objets (1 million gratuites par mois chez R2).
 */
const KEY = 'system/storage-usage.json';
const GROUPS = {
  fichiers: 'Fichiers envoyés',
  apercus: 'Aperçus et miniatures',
  videos: 'Qualités vidéo (480p, 720p…)',
  reunions: 'Documents de réunion',
  replays: 'Voix des replays',
  donnees: 'Données de l\'application'
};
const PRICE_PER_GB = 0.015;   // $ par Go et par mois au-delà de la part gratuite (tarif R2 standard)
const THRESHOLDS = [80, 100];

function groupOf(key) {
  if (key.startsWith('files/')) {
    const name = key.split('/').pop();
    if (/_r\d+$/.test(name)) return 'videos';
    if (/^voice_/.test(name)) return 'replays';
    if (/_(thumb|view|preview|pv|th|lq|sprite|pg\d+|doc)(\.\w+)?$/.test(name)) return 'apercus';
    return 'fichiers';
  }
  if (key.startsWith('meetdocs/')) return 'reunions';
  return 'donnees';
}

function createStorageUsage({ storage, mailer, env, now = Date.now }) {
  const free = (Number(env.R2_FREE_GB) || 10) * 1e9;
  let last = null, running = null;

  const ready = storage.getBuffer(KEY).then(b => { try { last = b ? JSON.parse(b.toString('utf8')) : null; } catch (e) { last = null; } }).catch(() => {});

  async function scan() {
    if (running) return running;
    running = (async () => {
      await ready;
      const t0 = now();
      const items = await storage.listSizes('');
      const groups = {}, transfers = new Map();
      let total = 0;
      for (const { key, size } of items) {
        total += size;
        const g = groupOf(key);
        const o = groups[g] || (groups[g] = { bytes: 0, count: 0 });
        o.bytes += size; o.count++;
        if (key.startsWith('files/')) { const id = key.split('/')[1]; transfers.set(id, (transfers.get(id) || 0) + size); }
      }
      const month = new Date(now()).toISOString().slice(0, 7);
      const alerts = last && last.alertsMonth === month ? last.alerts || [] : [];
      last = {
        at: now(), ms: now() - t0, total, objects: items.length, groups,
        biggest: [...transfers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, bytes]) => ({ id, bytes })),
        alertsMonth: month, alerts
      };
      await alert();
      await storage.putBuffer(KEY, Buffer.from(JSON.stringify(last)), 'application/json').catch(() => {});
      return summary();
    })().finally(() => { running = null; });
    return running;
  }

  async function alert() {
    const pct = last.total / free * 100;
    const hit = THRESHOLDS.filter(t => pct >= t && !last.alerts.includes(t));
    if (!hit.length) return;
    last.alerts.push(...hit);
    const t = Math.max(...hit), s = summary();
    console.warn(`⚠️ Stockage R2 : ${t} % de la part gratuite (${(last.total / 1e9).toFixed(2)} Go)`);
    if (!env.ADMIN_EMAIL || !mailer || !mailer.enabled) return;
    const paragraphs = [
      `Le stockage Cloudflare R2 contient <b>${(s.total / 1e9).toFixed(2)} Go</b>, soit <b>${Math.round(s.percent)} %</b> de la part gratuite de ${(free / 1e9).toFixed(0)} Go.`,
      s.cost > 0 ? `Coût estimé : environ ${s.cost.toFixed(2)} $ par mois.` : 'Au-delà, Cloudflare facture environ 0,015 $ par Go et par mois.',
      'Ce qui prend le plus de place : ' + s.groups.slice(0, 3).map(g => `${g.label} ${(g.bytes / 1e9).toFixed(2)} Go`).join(' · ') + '.',
      'Les liens expirés sont supprimés automatiquement. Pour libérer de la place tout de suite : console › Transferts, triés par taille.'
    ];
    try {
      const html = mailer.simple ? mailer.simple({ title: `Stockage R2 : ${t} %`, paragraphs }) : paragraphs.map(p => `<p>${p}</p>`).join('');
      await mailer.send({ to: env.ADMIN_EMAIL, subject: `Lestha Send — stockage Cloudflare à ${t} %`, html, text: paragraphs.join('\n\n').replace(/<[^>]+>/g, '') });
    } catch (e) { console.error('alerte stockage', e.message); }
  }

  function summary() {
    if (!last) return { free, scanned: false };
    return {
      scanned: true, at: last.at, total: last.total, objects: last.objects, free,
      percent: last.total / free * 100,
      cost: Math.max(0, (last.total - free) / 1e9) * PRICE_PER_GB,
      groups: Object.entries(last.groups).map(([k, v]) => ({ key: k, label: GROUPS[k] || k, bytes: v.bytes, count: v.count })).sort((a, b) => b.bytes - a.bytes),
      biggest: last.biggest || []
    };
  }

  /** Inventaire 2 min après le démarrage, puis toutes les 6 h */
  function start() {
    const run = () => scan().catch(e => console.error('inventaire stockage', e.message));
    const t1 = setTimeout(run, 120e3); if (t1.unref) t1.unref();
    const t2 = setInterval(run, 6 * 3600e3); if (t2.unref) t2.unref();
  }

  return { ready, scan, summary, start, _groupOf: groupOf };
}

module.exports = { createStorageUsage, groupOf };
