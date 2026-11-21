// app.js — WA CRM Klinik (Supabase + Edge Functions). Desktop sidebar + mobile bottom nav.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const CFG = window.CRM_CONFIG || {};
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);

const ST = {
  get org() { return localStorage.getItem('crm_org'); }, set org(v) { v ? localStorage.setItem('crm_org', v) : localStorage.removeItem('crm_org'); },
  get fac() { return localStorage.getItem('crm_fac'); }, set fac(v) { v ? localStorage.setItem('crm_fac', v) : localStorage.removeItem('crm_fac'); },
};
let user = null, memberships = [], role = null, route = 'dashboard', activeConv = null, online = navigator.onLine;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 2800); };

// ---------- data helpers ----------
const orgFilter = (q, facCol) => { let b = q.eq('organization_id', ST.org); if (ST.fac && facCol) b = b.eq(facCol, ST.fac); return b; };
async function fn(name, body) {
  const token = (await sb.auth.getSession()).data.session?.access_token;
  const res = await fetch(`${CFG.supabaseUrl}/functions/v1/${name}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: CFG.supabaseAnonKey, 'Content-Type': 'application/json', 'x-organization-id': ST.org || '' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const canWrite = () => ['org_admin', 'branch_admin', 'registration_officer'].includes(role);
const isAdmin = () => ['org_admin', 'branch_admin'].includes(role);

async function loadMemberships() {
  const { data } = await sb.from('memberships').select('*, organizations(name)').eq('user_id', user.id);
  memberships = (data || []).map(m => ({ organization_id: m.organization_id, org_name: m.organizations?.name, role: m.role, facility_scope: m.facility_scope }));
  if (!memberships.find(m => m.organization_id === ST.org)) { ST.org = memberships[0]?.organization_id; ST.fac = memberships[0]?.facility_scope?.[0] || null; }
  const am = memberships.find(m => m.organization_id === ST.org); role = am?.role;
}

// ---------- IndexedDB draft offline ----------
let idb = null;
const openIDB = () => new Promise((res, rej) => { const r = indexedDB.open('crm-drafts', 1); r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('drafts')) r.result.createObjectStore('drafts', { keyPath: 'id' }); }; r.onsuccess = () => { idb = r.result; res(); }; r.onerror = rej; });
const draftAll = async () => { await openIDB(); return new Promise(r => { const q = idb.transaction('drafts', 'readonly').objectStore('drafts').getAll(); q.onsuccess = () => r(q.result || []); }); };
const draftAdd = async d => { await openIDB(); return new Promise(r => { const tx = idb.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put({ ...d, status: 'pending', created_at: new Date().toISOString() }); tx.oncomplete = r; }); };
const draftDel = async id => { await openIDB(); return new Promise(r => { const tx = idb.transaction('drafts', 'readwrite'); tx.objectStore('drafts').delete(id); tx.oncomplete = r; }); };
const draftCount = async () => (await draftAll()).length;

async function syncDrafts() {
  const drafts = await draftAll(); if (!drafts.length) { toast('Tidak ada draft'); return; }
  let ok = 0, fail = 0;
  for (const d of drafts) {
    try { const r = await fn('register-slot', { ...d, source: 'offline_draft' }); if (r.id) { await draftDel(d.id); ok++; } }
    catch (e) { fail++; if (String(e.message).includes('penuh')) toast(`Slot ${d.slot_date} ${d.slot_start_time} penuh`); }
  }
  toast(`Sinkron: ${ok} berhasil, ${fail} perlu ditinjau`); render();
}

// ---------- shell render ----------
const NAV = [
  { id: 'dashboard', ico: '🏠', label: 'Dashboard' },
  { id: 'conversations', ico: '💬', label: 'Percakapan', badge: 'unread' },
  { id: 'registrations', ico: '📋', label: 'Pendaftaran' },
  { id: 'patients', ico: '👤', label: 'Pasien' },
  { id: 'gateway', ico: '📡', label: 'Gateway' },
  { id: 'bot', ico: '🤖', label: 'Bot & FAQ' },
  { id: 'audit', ico: '📜', label: 'Audit Log' },
  { id: 'settings', ico: '⚙️', label: 'Pengaturan' },
];
function renderShell() {
  $('#side-nav').innerHTML = NAV.map(n => `<button data-route="${n.id}" class="${route === n.id ? 'active' : ''}"><span class="sn-ico">${n.ico}</span>${n.label}${n.badge ? '<span class="sn-badge" id="sn-unread"></span>' : ''}</button>`).join('');
  $$('#side-nav button').forEach(b => b.onclick = () => go(b.dataset.route));
  $$('#bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.route === (['dashboard', 'conversations', 'registrations'].includes(route) ? route : 'more')));
  $('#page-title').textContent = NAV.find(n => n.id === route)?.label || 'Lainnya';
  $('#user-chip').innerHTML = `<div class="avatar">${(user?.email || '?')[0].toUpperCase()}</div><div><div class="u-name">${esc(user?.email || '')}</div><div class="u-role">${esc(role || '')}</div></div><button id="logout-btn">Keluar</button>`;
  $('#logout-btn').onclick = async () => { await sb.auth.signOut(); };
  $('#side-org').innerHTML = `<select id="org-select">${memberships.map(m => `<option value="${m.organization_id}" ${m.organization_id === ST.org ? 'selected' : ''}>${esc(m.org_name)}</option>`).join('')}</select>`;
  $('#org-select').onchange = e => { ST.org = e.target.value; const m = memberships.find(x => x.organization_id === ST.org); ST.fac = m?.facility_scope?.[0] || null; loadMemberships().then(render); };
  // facility select
  sb.from('facilities').select('*').eq('organization_id', ST.org).order('name').then(({ data }) => {
    const opts = '<option value="">Semua cabang</option>' + (data || []).map(f => `<option value="${f.id}" ${f.id === ST.fac ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
    $('#fac-select').innerHTML = opts;
  });
  $('#fac-select').onchange = e => { ST.fac = e.target.value || null; render(); };
  // online + sync
  $('#online-chip').classList.toggle('off', !online); $('#online-text').textContent = online ? 'online' : 'offline';
  draftCount().then(c => { $('#sync-chip').classList.toggle('hidden', !c); $('#sync-count').textContent = c; });
  $('#sync-chip').onclick = syncDrafts;
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
}
function go(r) { route = r; activeConv = null; $('#sidebar').classList.remove('open'); render(); }

// ---------- modal ----------
function openModal(html) { $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); }; }
function closeModal() { $('#modal').classList.add('hidden'); }

// ---------- views ----------
async function viewDashboard() {
  const v = $('#view');
  v.innerHTML = '<div class="card">Memuat…</div>';
  const [reg, unread, failed, handoff, wa] = await Promise.all([
    sb.from('registrations').select('*', { count: 'exact', head: true }).eq('organization_id', ST.org).in('status', ['awaiting_patient_confirmation', 'registered']).gte('slot_date', new Date().toISOString().slice(0, 10)),
    sb.from('conversations').select('*', { count: 'exact', head: true }).eq('organization_id', ST.org).gt('unread', 0),
    sb.from('message_outbox').select('*', { count: 'exact', head: true }).eq('organization_id', ST.org).in('status', ['failed', 'unknown']),
    sb.from('conversations').select('*', { count: 'exact', head: true }).eq('organization_id', ST.org).eq('needs_human', true).neq('status', 'closed'),
    sb.from('wa_numbers').select('*').eq('organization_id', ST.org),
  ]);
  $('#sn-unread') && ($('#sn-unread').textContent = unread.count || '');
  const bn = $('#bn-badge'); if (bn) { bn.textContent = unread.count || ''; bn.classList.toggle('hidden', !unread.count); }
  const stat = (n, lbl, ico, bg) => `<div class="stat-card"><div class="stat-ico ${bg}">${ico}</div><div><div class="num">${n || 0}</div><div class="lbl">${lbl}</div></div></div>`;
  v.innerHTML = `
    <div class="stats-grid">
      ${stat(reg.count, 'Pendaftaran aktif', '📋', 'bg-teal')}
      ${stat(unread.count, 'Percakapan belum dibaca', '💬', 'bg-blue')}
      ${stat(failed.count, 'Pesan gagal/unknown', '⚠️', 'bg-red')}
      ${stat(handoff.count, 'Butuh tanggapan staf', '🖐️', 'bg-amber')}
    </div>
    <div class="card"><h3>Status Gateway WhatsApp</h3>
      ${(wa.data || []).length ? wa.data.map(w => `<div class="list-row"><div><b>${esc(w.label || w.number)}</b> <span class="muted">· ${w.primary_gateway}</span></div><span class="pill ${w.healthy ? 'pill-green' : 'pill-red'}">${w.healthy ? 'sehat' : 'gangguan'}</span></div>`).join('') : '<p class="muted">Belum ada nomor WA. Tambahkan di tabel wa_numbers.</p>'}
      ${canWrite() ? `<div class="btn-row" style="margin-top:12px"><button class="btn btn-secondary" onclick="go('gateway')">Kelola gateway</button></div>` : ''}
    </div>
    <div class="card"><h3>Sinkronisasi Offline <button class="btn btn-primary" id="btn-sync" style="padding:6px 12px;font-size:12px">Sinkronkan sekarang</button></h3>
      <p class="muted" id="draft-info">… draft tertunda</p></div>`;
  $('#btn-sync').onclick = syncDrafts;
  draftCount().then(c => $('#draft-info').textContent = c + ' draft pendaftaran tertunda sinkronisasi');
}

let convCache = [];
async function viewConversations() {
  const v = $('#view');
  let q = sb.from('conversations').select('*, patients(full_name)').eq('organization_id', ST.org);
  if (ST.fac) q = q.eq('facility_id', ST.fac);
  const { data: convs } = await q.order('last_message_at', { ascending: false }).limit(100);
  convCache = convs || [];
  const ids = convCache.map(c => c.id);
  let lastMsg = {};
  if (ids.length) {
    const { data: msgs } = await sb.from('messages').select('conversation_id,content').in('conversation_id', ids).order('created_at');
    for (const m of msgs || []) lastMsg[m.conversation_id] = m.content;
  }
  const unreadTotal = convCache.reduce((s, c) => s + (c.unread || 0), 0);
  $('#sn-unread') && ($('#sn-unread').textContent = unreadTotal || '');
  const bn = $('#bn-badge'); if (bn) { bn.textContent = unreadTotal || ''; bn.classList.toggle('hidden', !unreadTotal); }
  v.innerHTML = `<div class="conv-layout ${activeConv ? 'chat-open' : ''}" id="conv-layout">
    <div class="conv-list">${convCache.length ? convCache.map(c => `<div class="conv-item ${activeConv === c.id ? 'active' : ''}" data-cid="${c.id}">
      <div class="c-avatar">${(c.patients?.full_name || c.from_number || '?')[0].toUpperCase()}</div>
      <div class="c-main"><div class="c-name">${esc(c.patients?.full_name || c.from_number)}<span class="c-time">${c.unread ? `<span class="c-unread">${c.unread}</span>` : ''}</span></div>
      <div class="c-last">${esc(lastMsg[c.id] || '-')}</div></div>
      <span class="pill ${c.needs_human ? 'pill-amber' : 'pill-gray'}">${c.needs_human ? 'petugas' : 'bot'}</span>
    </div>`).join('') : '<div class="empty">Belum ada percakapan.<br>Arahkan webhook Baileys/Fonnte ke wa-webhook.</div>'}</div>
    <div class="chat-pane" id="chat-pane"><div class="empty">Pilih percakapan</div></div>
  </div>`;
  $$('.conv-item').forEach(el => el.onclick = () => { activeConv = el.dataset.cid; viewConversations(); openChat(); });
  if (activeConv) openChat();
}
async function openChat() {
  await sb.from('conversations').update({ unread: 0 }).eq('id', activeConv);
  const { data: msgs } = await sb.from('messages').select('*').eq('conversation_id', activeConv).order('created_at');
  const conv = convCache.find(c => c.id === activeConv);
  $('#chat-pane').innerHTML = `
    <div class="chat-head"><button class="back-btn" id="chat-back">←</button>
      <div style="flex:1"><b>${esc(conv?.patients?.full_name || conv?.from_number || '')}</b><div class="muted">${conv?.needs_human ? 'menunggu tanggapan staf' : 'bot aktif'}</div></div>
      <button class="btn ${conv?.needs_human ? 'btn-primary' : 'btn-secondary'}" id="btn-handoff" style="padding:6px 12px;font-size:12px">${conv?.needs_human ? 'Aktifkan Bot' : 'Alihkan ke Staf'}</button>
    </div>
    <div class="chat-bubbles" id="bubbles">${(msgs || []).map(m => `<div class="bubble ${m.direction}">${esc(m.content)}${m.direction === 'out' ? `<div class="b-st">${esc(m.status || '')}</div>` : ''}</div>`).join('') || '<div class="empty">Belum ada pesan</div>'}</div>
    <div class="chat-input"><input id="chat-text" placeholder="Ketik balasan… (Enter untuk kirim)"><button class="btn btn-primary" id="btn-send">Kirim</button></div>`;
  $('#chat-back').onclick = () => { activeConv = null; viewConversations(); };
  $('#btn-handoff').onclick = async () => { const on = conv?.needs_human; await sb.from('conversations').update({ needs_human: !on, status: on ? 'open' : 'human_handled' }).eq('id', activeConv); if (on) await sb.from('bot_states').delete().eq('conversation_id', activeConv); toast(on ? 'Bot diaktifkan' : 'Dialihkan ke staf'); const c = convCache.find(x => x.id === activeConv); if (c) c.needs_human = !on; openChat(); };
  const send = async () => { const t = $('#chat-text').value.trim(); if (!t) return; try { await fn('gateway-action', { action: 'reply', conversation_id: activeConv, content: t }); $('#chat-text').value = ''; openChat(); } catch (e) { toast(e.message); } };
  $('#btn-send').onclick = send; $('#chat-text').onkeydown = e => { if (e.key === 'Enter') send(); };
  const b = $('#bubbles'); b.scrollTop = b.scrollHeight;
}

async function viewRegistrations() {
  const v = $('#view');
  let q = sb.from('registrations').select('*, patients(full_name,nik), services(name), doctors(name)').eq('organization_id', ST.org);
  if (ST.fac) q = q.eq('facility_id', ST.fac);
  const { data } = await q.order('slot_date').limit(200);
  const stPill = s => ({ registered: 'pill-green', awaiting_patient_confirmation: 'pill-amber', completed: 'pill-teal', cancelled: 'pill-gray', draft: 'pill-gray', need_reschedule: 'pill-red' }[s] || 'pill-gray');
  v.innerHTML = `<div class="card"><h3>Pendaftaran ${canWrite() ? '<button class="btn btn-primary" id="btn-new-reg" style="padding:7px 14px;font-size:12px">+ Pendaftaran Baru</button>' : ''}</h3>
    <div class="table-wrap"><table class="data"><thead><tr><th>Pasien</th><th>NIK</th><th>Layanan</th><th>Dokter</th><th>Jadwal</th><th>Status</th><th></th></tr></thead>
    <tbody>${(data || []).map(r => `<tr><td><b>${esc(r.patients?.full_name || '-')}</b></td><td>${esc(r.patients?.nik || '-')}</td><td>${esc(r.services?.name || '-')}</td><td>${esc(r.doctors?.name || '-')}</td><td>${r.slot_date} ${r.slot_start_time?.slice(0,5) || ''}</td><td><span class="pill ${stPill(r.status)}">${r.status}</span></td>
    <td>${r.status !== 'cancelled' && canWrite() ? `<button class="btn btn-danger" style="padding:4px 10px;font-size:11px" data-cancel="${r.id}">Batal</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Belum ada pendaftaran.</td></tr>'}</tbody></table></div></div>`;
  $('#btn-new-reg')?.addEventListener('click', openRegWizard);
  $$('[data-cancel]').forEach(b => b.onclick = async () => { await sb.from('registrations').update({ status: 'cancelled' }).eq('id', b.dataset.cancel); toast('Dibatalkan'); viewRegistrations(); });
}

// ---- wizard pendaftaran ----
let regWiz = { step: 1, patient_id: null, newPatient: null, service_id: null, slot: null };
async function openRegWizard() {
  regWiz = { step: 1, patient_id: null, newPatient: null, service_id: null, slot: null };
  renderWizard();
}
function renderWizard() {
  const steps = `<div class="wizard-steps">${[1, 2, 3].map(i => `<div class="step ${i <= regWiz.step ? 'done' : ''}"></div>`).join('')}</div>`;
  if (regWiz.step === 1) {
    openModal(`<div class="modal-head"><h3>1. Pilih / Buat Pasien</h3><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body">
      <div class="field"><input id="rz-search" placeholder="Cari nama / NIK / HP…"></div>
      <div id="rz-results"></div>
      <p class="muted" style="margin:10px 0">Atau isi data baru:</p>
      <div class="form-grid"><div class="field"><label>NIK</label><input id="rz-nik"></div><div class="field"><label>Nama lengkap</label><input id="rz-name"></div>
      <div class="field"><label>Tempat lahir</label><input id="rz-bp"></div><div class="field"><label>Tanggal lahir</label><input id="rz-bd" type="date"></div>
      <div class="field"><label>No HP (notifikasi WA)</label><input id="rz-phone"></div></div>
      <button class="btn btn-secondary" id="rz-save-pasien" style="width:100%">Simpan & lanjut</button></div>`);
    $('#rz-search').oninput = async () => { const q = $('#rz-search').value.trim(); if (q.length < 3) return; const { data } = await sb.from('patients').select('*').eq('organization_id', ST.org).or(`full_name.ilike.%${q}%,nik.ilike.%${q}%,phone.ilike.%${q}%`).limit(20); $('#rz-results').innerHTML = (data || []).map(p => `<div class="list-row" data-pid="${p.id}" style="cursor:pointer"><div><b>${esc(p.full_name)}</b> <span class="muted">${esc(p.nik || '')}</span></div><span class="pill pill-teal">pilih</span></div>`).join('') || '<p class="muted">Tidak ditemukan</p>'; $$('#rz-results .list-row').forEach(el => el.onclick = () => { regWiz.patient_id = el.dataset.pid; regWiz.step = 2; renderWizard(); }); };
    $('#rz-save-pasien').onclick = async () => { const body = { nik: $('#rz-nik').value.trim(), full_name: $('#rz-name').value.trim(), birth_place: $('#rz-bp').value.trim(), birth_date: $('#rz-bd').value, phone: $('#rz-phone').value.trim() }; if (!body.full_name && !regWiz.patient_id) return toast('Nama lengkap wajib'); if (!navigator.onLine && body.full_name) { regWiz.newPatient = body; regWiz.step = 2; return renderWizard(); } if (body.full_name) { try { const r = await sb.from('patients').insert({ organization_id: ST.org, ...body }).select().single(); regWiz.patient_id = r.data.id; } catch (e) { if (String(e.message).includes('duplicate') && body.nik) { const ex = await sb.from('patients').select('id').eq('organization_id', ST.org).eq('nik', body.nik).maybeSingle(); regWiz.patient_id = ex.data?.id; } else return toast(e.message); } } if (!regWiz.patient_id) return toast('Pilih atau buat pasien dulu'); regWiz.step = 2; renderWizard(); };
  } else if (regWiz.step === 2) {
    openModal(`<div class="modal-head"><h3>2. Pilih Layanan & Slot</h3><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body">
      <div class="field"><label>Layanan</label><select id="rz-service"><option value="">Memuat…</option></select></div>
      <div id="rz-slots"><p class="muted">Pilih layanan untuk melihat slot 7 hari ke depan.</p></div></div>`);
    sb.from('services').select('*').eq('organization_id', ST.org).then(({ data }) => { $('#rz-service').innerHTML = '<option value="">Pilih layanan…</option>' + (data || []).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join(''); });
    $('#rz-service').onchange = async () => { const sid = $('#rz-service').value; if (!sid) return; regWiz.service_id = sid;
      let q = sb.from('schedules').select('*').eq('organization_id', ST.org).eq('active', true).eq('service_id', sid); if (ST.fac) q = q.eq('facility_id', ST.fac);
      const { data: scheds } = await q; const out = []; const today = new Date();
      for (let i = 1; i <= 7; i++) { const d = new Date(today.getTime() + i * 86400000); const ds = d.toISOString().slice(0, 10); for (const sch of scheds || []) { if (d.getDay() !== sch.day_of_week) continue; const [sh, sm] = sch.start_time.split(':').map(Number); const [eh, em] = sch.end_time.split(':').map(Number); for (let t = sh * 60 + sm; t + sch.slot_minutes <= eh * 60 + em; t += sch.slot_minutes) { const start = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; const { count } = await sb.from('registrations').select('*', { count: 'exact', head: true }).eq('schedule_id', sch.id).eq('slot_date', ds).eq('slot_start_time', start).in('status', ['awaiting_patient_confirmation', 'registered', 'completed']); if ((count || 0) < sch.quota_per_slot) out.push({ schedule_id: sch.id, date: ds, start, doctor_id: sch.doctor_id, service_id: sch.service_id, left: sch.quota_per_slot - (count || 0) }); } } }
      $('#rz-slots').innerHTML = out.length ? out.map((s, i) => `<div class="list-row" data-slot="${i}" style="cursor:pointer"><div><b>${s.date} ${s.start}</b> <span class="muted">sisa ${s.left}</span></div><span class="pill pill-green">pilih</span></div>`).join('') : '<p class="muted">Tidak ada slot 7 hari ke depan.</p>';
      $$('#rz-slots .list-row').forEach((el, i) => el.onclick = () => { regWiz.slot = out[i]; regWiz.step = 3; renderWizard(); });
    };
  } else {
    const s = regWiz.slot;
    openModal(`<div class="modal-head"><h3>3. Konfirmasi</h3><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body">
      <p>Slot: <b>${s.date} ${s.start}</b></p><p style="margin:8px 0 16px" class="muted">Kuota akan dikunci atomik oleh backend. Jika offline, disimpan sebagai draft dan divalidasi saat sinkron.</p>
      <button class="btn btn-primary" id="rz-submit" style="width:100%">Daftarkan Pasien</button></div>`);
    $('#rz-submit').onclick = async () => {
      const body = { patient_id: regWiz.patient_id, service_id: regWiz.service_id, doctor_id: regWiz.slot.doctor_id, schedule_id: regWiz.slot.schedule_id, slot_date: regWiz.slot.date, slot_start_time: regWiz.slot.start, facility_id: ST.fac };
      if (!navigator.onLine) { await draftAdd({ id: 'draft-' + Date.now(), ...body, newPatient: regWiz.newPatient }); closeModal(); toast('Disimpan sebagai draft offline'); return go('registrations'); }
      try { if (regWiz.newPatient) { const r = await sb.from('patients').insert({ organization_id: ST.org, ...regWiz.newPatient }).select().single(); body.patient_id = r.data.id; } await fn('register-slot', body); closeModal(); toast('Pendaftaran berhasil'); go('registrations'); } catch (e) { toast(String(e.message).includes('penuh') ? 'Slot penuh, pilih lain' : e.message); }
    };
  }
}

async function viewPatients() {
  const v = $('#view');
  v.innerHTML = `<div class="card"><h3>Pasien ${canWrite() ? '<button class="btn btn-primary" id="btn-add-pasien" style="padding:7px 14px;font-size:12px">+ Tambah Pasien</button>' : ''}</h3>
    <div class="field" style="max-width:360px"><input id="p-search" placeholder="Cari nama / NIK / HP…"></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Nama</th><th>NIK</th><th>Tempat/Tgl Lahir</th><th>HP</th></tr></thead><tbody id="p-body"><tr><td colspan="4" class="empty">Ketik untuk mencari.</td></tr></tbody></table></div></div>`;
  $('#btn-add-pasien')?.addEventListener('click', () => openModal(`<div class="modal-head"><h3>Tambah Pasien</h3><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body">
    <div class="form-grid"><div class="field"><label>NIK</label><input id="np-nik"></div><div class="field"><label>Nama lengkap *</label><input id="np-name"></div>
    <div class="field"><label>Tempat lahir</label><input id="np-bp"></div><div class="field"><label>Tanggal lahir</label><input id="np-bd" type="date"></div>
    <div class="field"><label>No HP</label><input id="np-phone"></div><div class="field"><label>HP kontak (wali)</label><input id="np-cp"></div></div></div>
    <div class="modal-foot"><button class="btn btn-secondary" onclick="closeModal()">Batal</button><button class="btn btn-primary" onclick="savePatient()">Simpan</button></div>`));
  $('#p-search').oninput = async () => { const q = $('#p-search').value.trim(); if (q.length < 2) return; const { data } = await sb.from('patients').select('*').eq('organization_id', ST.org).or(`full_name.ilike.%${q}%,nik.ilike.%${q}%,phone.ilike.%${q}%`).order('created_at', { ascending: false }).limit(50); $('#p-body').innerHTML = (data || []).map(p => `<tr><td><b>${esc(p.full_name)}</b></td><td>${esc(p.nik || '-')}</td><td>${esc(p.birth_place || '')} ${esc(p.birth_date || '')}</td><td>${esc(p.phone || '-')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Tidak ditemukan.</td></tr>'; };
}
window.savePatient = async function () {
  const body = { nik: $('#np-nik').value.trim(), full_name: $('#np-name').value.trim(), birth_place: $('#np-bp').value.trim(), birth_date: $('#np-bd').value, phone: $('#np-phone').value.trim(), contact_phone: $('#np-cp').value.trim() };
  if (!body.full_name) return toast('Nama wajib');
  try { await sb.from('patients').insert({ organization_id: ST.org, ...body }); closeModal(); toast('Tersimpan'); viewPatients(); }
  catch (err) { toast(String(err.message).includes('duplicate') ? 'NIK sudah terdaftar' : err.message); }
};

async function viewGateway() {
  const v = $('#view'); v.innerHTML = '<div class="card">Memuat…</div>';
  try {
    const d = await fn('gateway-action', { action: 'status' });
    const { data: sw } = await sb.from('gateway_switch_logs').select('*').in('wa_number_id', (d.numbers || []).map(w => w.id)).order('created_at', { ascending: false }).limit(50);
    v.innerHTML = (d.numbers || []).map(w => `<div class="card"><h3>${esc(w.label || w.number)} <span class="pill pill-teal">${esc(w.primary_gateway)}</span></h3>
      <div class="list-row"><span>Kesehatan</span><span class="pill ${w.healthy ? 'pill-green' : 'pill-red'}">${w.healthy ? 'sehat' : 'gangguan'}</span></div>
      <div class="list-row"><span>Gagal berturut-turut</span><b>${w.consecutive_failures || 0}</b></div>
      <div class="list-row"><span>Live status</span><span class="muted">${esc(JSON.stringify(w.live_status || {}))}</span></div>
      ${canWrite() ? `<div class="btn-row" style="margin-top:12px"><button class="btn btn-secondary" data-check="${w.id}">Cek sekarang</button><button class="btn btn-secondary" data-switch="${w.id}">Ganti ke ${w.primary_gateway === 'baileys' ? 'Fonnte' : 'Baileys'}</button></div>` : ''}
    </div>`).join('') + `<div class="card"><h3>Riwayat Perpindahan Gateway</h3>${(sw || []).length ? sw.map(s => `<div class="list-row"><span>${esc(s.from_gateway)} → ${esc(s.to_gateway)} <span class="muted">${esc(s.reason || '')}</span></span><span class="muted">${s.created_at?.slice(0, 16).replace('T', ' ')}</span></div>`).join('') : '<p class="muted">Belum ada perpindahan.</p>'}</div>`;
    $$('[data-check]').forEach(b => b.onclick = async () => { try { const r = await fn('gateway-action', { action: 'check-now', wa_number_id: b.dataset.check }); toast('Status: ' + JSON.stringify(r).slice(0, 80)); viewGateway(); } catch (e) { toast(e.message); } });
    $$('[data-switch]').forEach(b => b.onclick = async () => { try { await fn('gateway-action', { action: 'switch-primary', wa_number_id: b.dataset.switch }); toast('Gateway diganti'); viewGateway(); } catch (e) { toast(e.message); } });
  } catch (e) { v.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}

async function viewBot() {
  const v = $('#view');
  const [{ data: profile }, { data: docs }] = await Promise.all([sb.from('bot_profiles').select('*').eq('organization_id', ST.org).maybeSingle(), sb.from('knowledge_documents').select('*').eq('organization_id', ST.org)]);
  const p = profile || {};
  v.innerHTML = `<div class="card"><h3>Profil Bot</h3>
    <div class="form-grid"><div class="field"><label>Nama bot</label><input id="b-name" value="${esc(p.name || '')}"></div>
    <div class="field"><label>Bahasa</label><select id="b-lang"><option value="id" ${p.language === 'id' ? 'selected' : ''}>Indonesia</option><option value="en">English</option></select></div></div>
    <div class="field"><label>Sapaan pembuka</label><textarea id="b-greet" rows="2">${esc(p.greeting || '')}</textarea></div>
    <div class="field"><label><input type="checkbox" id="b-enabled" ${p.enabled !== false ? 'checked' : ''} style="width:auto;margin-right:8px">Bot aktif (non-aktifkan untuk mode staf penuh)</label></div>
    ${isAdmin() ? `<button class="btn btn-primary" id="b-save">Simpan Profil</button>` : ''}</div>
    <div class="card"><h3>Dokumen Pengetahuan (FAQ) — hanya yang disetujui dipakai bot</h3>
      ${(docs || []).map(k => `<div class="list-row"><div><b>v${k.version}</b> ${esc(k.title)}</div><span class="pill ${k.approved ? 'pill-green' : 'pill-gray'}">${k.approved ? 'disetujui' : 'draft'}</span></div>`).join('') || '<p class="muted">Belum ada.</p>'}
      ${isAdmin() ? `<div style="margin-top:14px"><div class="field"><input id="k-title" placeholder="Judul (mis. Jam Operasional)"></div><div class="field"><textarea id="k-content" rows="3" placeholder="Isi informasi…"></textarea></div><button class="btn btn-secondary" id="k-add">Tambah Dokumen</button></div>` : ''}</div>`;
  $('#b-save')?.addEventListener('click', async () => { await sb.from('bot_profiles').upsert({ organization_id: ST.org, name: $('#b-name').value, language: $('#b-lang').value, greeting: $('#b-greet').value, enabled: $('#b-enabled').checked }, { onConflict: 'organization_id' }); toast('Tersimpan'); });
  $('#k-add')?.addEventListener('click', async () => { await sb.from('knowledge_documents').insert({ organization_id: ST.org, title: $('#k-title').value, content: $('#k-content').value }); toast('Ditambahkan'); viewBot(); });
}

async function viewAudit() {
  const v = $('#view');
  const { data } = await sb.from('audit_logs').select('*').eq('organization_id', ST.org).order('created_at', { ascending: false }).limit(100);
  v.innerHTML = `<div class="card"><h3>Audit Log</h3><div class="table-wrap"><table class="data"><thead><tr><th>Waktu</th><th>Aksi</th><th>Entitas</th><th>Detail</th></tr></thead><tbody>${(data || []).map(a => `<tr><td class="muted">${a.created_at?.slice(0, 16).replace('T', ' ')}</td><td><b>${esc(a.action)}</b></td><td>${esc(a.entity || '')}</td><td class="muted">${esc(JSON.stringify(a.detail || '').slice(0, 60))}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Belum ada log.</td></tr>'}</tbody></table></div></div>`;
}

function viewSettings() {
  const v = $('#view');
  v.innerHTML = `<div class="card"><h3>Organisasi & Cabang Aktif</h3>
    <div class="field"><label>Organisasi</label><select id="s-org">${memberships.map(m => `<option value="${m.organization_id}" ${m.organization_id === ST.org ? 'selected' : ''}>${esc(m.org_name)} (${esc(m.role)})</option>`).join('')}</select></div>
    <p class="muted">Cabang aktif dipilih dari dropdown di kanan atas.</p></div>
    <div class="card"><h3>Akun</h3><p><b>${esc(user?.email || '')}</b> · peran: ${esc(role || '')}</p><p class="muted" style="margin:8px 0">Versi cache PWA: v2. Jika tampilan tidak berubah setelah update, naikkan CACHE_VERSION di sw.js.</p>
    <button class="btn btn-danger" id="s-logout">Keluar</button></div>`;
  $('#s-org').onchange = e => { ST.org = e.target.value; const m = memberships.find(x => x.organization_id === ST.org); ST.fac = m?.facility_scope?.[0] || null; loadMemberships().then(render); };
  $('#s-logout').onclick = () => sb.auth.signOut();
}

function viewMore() { // mobile "Lainnya"
  const v = $('#view');
  const items = NAV.filter(n => !['dashboard', 'conversations', 'registrations'].includes(n.id));
  v.innerHTML = `<div class="card">${items.map(n => `<div class="list-row" data-route="${n.id}" style="cursor:pointer"><div><span style="margin-right:10px">${n.ico}</span><b>${n.label}</b></div><span class="pill pill-gray">→</span></div>`).join('')}</div>`;
  $$('[data-route]').forEach(el => el.onclick = () => go(el.dataset.route));
}

// ---------- render ----------
const VIEWS = { dashboard: viewDashboard, conversations: viewConversations, registrations: viewRegistrations, patients: viewPatients, gateway: viewGateway, bot: viewBot, audit: viewAudit, settings: viewSettings, more: viewMore };
async function render() {
  renderShell();
  try { await (VIEWS[route] || viewDashboard)(); } catch (e) { $('#view').innerHTML = `<div class="card">Error: ${esc(e.message)}</div>`; }
}

// ---------- login ----------
function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#login-screen').innerHTML = `<div class="login-box"><div style="font-size:44px;margin-bottom:8px">🏥</div><h1>WA CRM Klinik</h1><p>Multi-tenant · WhatsApp · Pendaftaran Otomatis</p>
    <div class="field" style="text-align:left"><label>Email</label><input id="login-email" placeholder="nama@klinik.local"></div>
    <div class="field" style="text-align:left"><label>Password</label><input id="login-pass" type="password"></div>
    <button class="btn btn-primary" id="login-btn" style="width:100%">Masuk</button>
    <p class="muted" style="margin-top:14px">Buat akun di Supabase Authentication → Users, lalu daftarkan ke tabel memberships.</p></div>`;
  const doLogin = async () => {
    const { error } = await sb.auth.signInWithPassword({ email: $('#login-email').value.trim(), password: $('#login-pass').value });
    if (error) toast(error.message);
  };
  $('#login-btn').onclick = doLogin; $('#login-pass').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
}

// ---------- auth state ----------
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT' || !session) { user = null; $('#login-screen').classList.remove('hidden'); $('#app').style.display = 'none'; return; }
  user = session.user; $('#login-screen').classList.add('hidden'); $('#app').style.display = 'flex';
  loadMemberships().then(render);
});
window.addEventListener('online', () => { online = true; toast('Online — sinkronisasi draft'); syncDrafts(); });
window.addEventListener('offline', () => { online = false; toast('Mode offline — draft disimpan lokal'); renderShell(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.closeModal = closeModal; window.go = go;
// init
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { showLogin(); } else { user = session.user; await loadMemberships(); $('#app').style.display = 'flex'; render(); }
})();
