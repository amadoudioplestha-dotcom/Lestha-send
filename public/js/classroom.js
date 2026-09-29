/* TransferX — salles de classe hébergées par BigBlueButton */
import { $, esc, icon, api, toast, copyText } from './core.js';

let root = null, id = null, hostToken = null, attendanceTimer = null;

export default {
  async render(r, { match }) {
    root = r;
    id = match[1] || null;
    clearInterval(attendanceTimer);
    attendanceTimer = null;
    if (!id) return renderCreate();

    const fragmentToken = location.hash.slice(1);
    if (fragmentToken) {
      hostToken = fragmentToken;
      try { sessionStorage.setItem('tx_class_host_' + id, hostToken); } catch (e) { /* Le lien privé reste utilisable dans l’URL. */ }
      history.replaceState(history.state, '', location.pathname + location.search);
    } else {
      try { hostToken = sessionStorage.getItem('tx_class_host_' + id); } catch (e) { hostToken = null; }
    }
    await renderJoin();
  },
  destroy() {
    clearInterval(attendanceTimer);
    attendanceTimer = null;
    root = null;
  }
};

function renderCreate() {
  root.innerHTML = `<section class="narrow stack">
    <div class="hero">
      <span class="eyebrow">${icon('users')}Classe virtuelle</span>
      <h1>Un espace de cours <span class="grad-text">en direct</span></h1>
      <p class="lead">Les réunions et leurs outils sont fournis par BigBlueButton. Caméra, micro, partage d’écran, chat, sondages, main levée et commandes de modération restent dans son interface native.</p>
    </div>
    <div class="card stack">
      <div class="card-title"><h3>${icon('video')}Créer une salle</h3></div>
      <form id="classCreate" class="stack">
        <label class="field"><span>Titre du cours</span><input class="input" name="title" maxlength="64" minlength="2" required placeholder="Ex. Mathématiques — chapitre 4"></label>
        <label class="field"><span>Nom de l’enseignant</span><input class="input" name="moderatorName" maxlength="64" minlength="2" required autocomplete="name" placeholder="Votre nom"></label>
        <label class="field"><span>Code de création fourni par l’établissement</span><input class="input" name="code" type="password" required autocomplete="off"></label>
        <label class="switch"><input type="checkbox" name="record"><span class="track"></span><span class="small">Enregistrer automatiquement le cours (les participants en seront avertis par BigBlueButton)</span></label>
        <p class="small faint">Limite configurée : 25 participants. La présence est conservée pour export pendant 30 jours et n’est relevée que lorsque la page enseignant est ouverte.</p>
        <button class="btn primary xl block" type="submit">${icon('plus')}Créer la classe</button>
      </form>
      <p id="classCreateError" class="small hidden" role="alert" style="color:var(--rose)"></p>
      <div id="classCreated" class="stack hidden"></div>
      <div id="classConfigNote" class="tip hidden"></div>
    </div>
    <div class="tip">${icon('shield')}<span>Le secret API BigBlueButton reste sur le serveur TransferX. Configurez une URL HTTPS et un secret BBB, puis un code réservé aux enseignants avant d’activer la création.</span></div>
  </section>`;

  const form = $('#classCreate', root);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const error = $('#classCreateError', root);
    error.classList.add('hidden');
    button.disabled = true;
    try {
      const result = await api('/api/classrooms', {
        method: 'POST',
        headers: { 'X-Classroom-Code': form.querySelector('[name="code"]').value },
        body: {
          title: form.querySelector('[name="title"]').value.trim(),
          moderatorName: form.querySelector('[name="moderatorName"]').value.trim(),
          record: form.querySelector('[name="record"]').checked
        }
      });
      $('#classCreated', root).classList.remove('hidden');
      $('#classCreated', root).innerHTML = `<div class="tip">${icon('check')}<span>La salle est créée. Partagez le lien participant; gardez le lien enseignant privé.</span></div>
        <label class="field"><span>Lien participant</span><span class="input-group"><input class="input mono" readonly value="${esc(result.participantLink)}"><button class="btn" type="button" data-copy="${esc(result.participantLink)}">Copier</button></span></label>
        <label class="field"><span>Lien privé enseignant</span><span class="input-group"><input class="input mono" readonly value="${esc(result.hostLink)}"><button class="btn" type="button" data-copy="${esc(result.hostLink)}">Copier</button></span></label>
        <a class="btn primary block" href="${esc(result.hostLink)}" target="_blank" rel="noopener">${icon('video')}Rejoindre comme enseignant</a>`;
      $('#classCreated', root).onclick = async (e) => {
        const button = e.target.closest('[data-copy]');
        if (button && await copyText(button.dataset.copy)) toast('Lien copié', 'success');
      };
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    } finally {
      button.disabled = false;
    }
  };

  api('/api/classrooms/config').then(config => {
    if (config.enabled && config.canCreate) return;
    const note = $('#classConfigNote', root);
    if (!note) return;
    note.classList.remove('hidden');
    note.innerHTML = `${icon('shield')}<span>${config.enabled ? 'Le service BigBlueButton est connecté, mais la création nécessite un CLASSROOM_CREATE_CODE d’au moins 16 caractères.' : 'Aucun serveur BigBlueButton n’est encore configuré. Définissez BBB_URL, BBB_SECRET et un CLASSROOM_CREATE_CODE aléatoire d’au moins 16 caractères sur le serveur.'}</span>`;
  }).catch(() => {});
}

async function renderJoin() {
  try {
    const meeting = await api(`/api/classrooms/${encodeURIComponent(id)}`);
    root.innerHTML = `<section class="narrow stack">
      <div class="hero"><span class="eyebrow">${icon('users')}Classe virtuelle · ${meeting.maxParticipants} places max.</span><h1><span class="grad-text">${esc(meeting.title)}</span></h1><p class="lead">${hostToken ? 'Vous avez le lien privé enseignant.' : 'Saisissez le nom sous lequel vous apparaîtrez dans la réunion.'}${meeting.record ? ' L’enregistrement automatique est activé et sera signalé par BigBlueButton.' : ''}</p></div>
      <div class="card stack">
        <form id="classJoin" class="stack">
          <label class="field"><span>Nom affiché</span><input class="input" name="name" maxlength="64" minlength="2" required autocomplete="name" placeholder="Votre nom"></label>
          <button class="btn primary xl block" type="submit">${icon('video')}Rejoindre le cours</button>
        </form>
        <p id="classJoinError" class="small hidden" role="alert" style="color:var(--rose)"></p>
        ${hostToken ? `<div class="row wrap">
          <button class="btn sm" id="refreshAttendance" type="button">${icon('refresh', 'sm')}Actualiser les présences</button>
          <button class="btn sm" id="exportAttendance" type="button">${icon('download', 'sm')}Exporter CSV</button>
          <button class="btn sm" id="loadRecordings" type="button">${icon('film', 'sm')}Enregistrements</button>
          <button class="btn sm danger" id="endClass" type="button">${icon('power', 'sm')}Terminer le cours</button>
        </div><p id="attendanceStatus" class="small muted" aria-live="polite"></p><div id="attendanceList" class="stack" style="gap:6px"></div><div id="recordingsList" class="stack" style="gap:6px"></div>` : ''}
        <p class="small faint">La réunion s’ouvre sur le serveur BigBlueButton dans un nouvel onglet. Utilisez son interface pour caméra, microphone, partage d’écran, chat, sondages, main levée et outils de cours. Votre nom et des relevés de première/dernière présence peuvent être consultés et exportés par l’enseignant pendant 30 jours; le relevé est effectué toutes les 30 secondes tant que sa page TransferX est ouverte.</p>
      </div></section>`;

    $('#classJoin', root).onsubmit = async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      const error = $('#classJoinError', root);
      const opened = window.open('about:blank', '_blank');
      if (opened) opened.opener = null;
      error.classList.add('hidden');
      button.disabled = true;
      try {
        const headers = hostToken ? { 'X-Classroom-Host': hostToken } : {};
        const result = await api(`/api/classrooms/${encodeURIComponent(id)}/join`, {
          method: 'POST', headers, body: { name: event.currentTarget.querySelector('[name="name"]').value.trim() }
        });
        if (opened) opened.location.href = result.joinUrl;
        else window.location.assign(result.joinUrl);
        if (hostToken) {
          refreshAttendance();
          if (!attendanceTimer) attendanceTimer = setInterval(refreshAttendance, 30000);
        }
      } catch (err) {
        if (opened) opened.close();
        error.textContent = err.message;
        error.classList.remove('hidden');
      } finally {
        button.disabled = false;
      }
    };

    if (hostToken) {
      $('#refreshAttendance', root).onclick = refreshAttendance;
      $('#exportAttendance', root).onclick = exportAttendance;
      $('#loadRecordings', root).onclick = loadRecordings;
      $('#endClass', root).onclick = endClass;
    }
  } catch (err) {
    root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon warn">${icon('film')}</div><h2>Salle indisponible</h2><p class="muted">${esc(err.message)}</p><a class="btn" href="/classe" data-link>Créer une classe</a></div></div></section>`;
  }
}

async function refreshAttendance() {
  if (!root || !id || !hostToken) return;
  const status = $('#attendanceStatus', root);
  try {
    const result = await api(`/api/classrooms/${encodeURIComponent(id)}/attendance/refresh`, { method: 'POST', headers: { 'X-Classroom-Host': hostToken }, body: {} });
    status.textContent = `Présents maintenant : ${result.attendees.length} · ${result.attendance.length} personnes relevées · actualisé à ${new Date(result.updatedAt).toLocaleTimeString('fr-FR')}.`;
    $('#attendanceList', root).innerHTML = result.attendance.map(person => `<div class="dl-row"><div class="fmeta"><div class="fname">${esc(person.name)}</div><div class="fsub">${esc(person.role)} · première présence ${new Date(person.firstSeen).toLocaleString('fr-FR')} · dernier relevé ${new Date(person.lastSeen).toLocaleString('fr-FR')}</div></div></div>`).join('') || '<p class="small faint">Aucune présence relevée. Ouvrez la réunion et actualisez la liste.</p>';
  } catch (err) {
    status.textContent = `Présences non actualisées : ${err.message}`;
  }
}

async function exportAttendance() {
  if (!id || !hostToken) return;
  try {
    const result = await api(`/api/classrooms/${encodeURIComponent(id)}/attendance`, { headers: { 'X-Classroom-Host': hostToken } });
    const quote = value => {
      const text = String(value);
      const safe = /^[\s]*[=+\-@]/.test(text) ? "'" + text : text;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const rows = [['Nom', 'Rôle', 'Première présence', 'Dernier relevé'], ...result.attendance.map(person => [
      person.name, person.role, new Date(person.firstSeen).toISOString(), new Date(person.lastSeen).toISOString()
    ])];
    const csv = '\uFEFF' + rows.map(row => row.map(quote).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `transferx-presences-${id}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast('Export CSV téléchargé', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadRecordings() {
  if (!id || !hostToken) return;
  const box = $('#recordingsList', root);
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const result = await api(`/api/classrooms/${encodeURIComponent(id)}/recordings`, { headers: { 'X-Classroom-Host': hostToken } });
    box.innerHTML = result.recordings.length ? result.recordings.map(recording => `<a class="dl-row playlist-item" href="${esc(recording.url)}" target="_blank" rel="noopener noreferrer"><div class="ficon">${icon('film', 'sm')}</div><div class="fmeta"><div class="fname">${esc(recording.name || recording.id)}</div><div class="fsub">${recording.published ? 'Publié' : 'Non publié'} · lecture BigBlueButton</div></div>${icon('external', 'sm')}</a>`).join('') : '<p class="small faint">Aucun enregistrement disponible pour cette salle pour le moment.</p>';
  } catch (err) {
    box.textContent = err.message;
  }
}

async function endClass() {
  if (!id || !hostToken || !confirm('Terminer la réunion pour tous les participants ?')) return;
  try {
    await api(`/api/classrooms/${encodeURIComponent(id)}/end`, { method: 'POST', headers: { 'X-Classroom-Host': hostToken }, body: {} });
    clearInterval(attendanceTimer);
    attendanceTimer = null;
    toast('Cours terminé', 'success');
    await loadRecordings();
  } catch (err) {
    toast(err.message, 'error');
  }
}
