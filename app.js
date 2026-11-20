// app.js — CRM Multi-Klinik PWA (Supabase + Edge Functions). UI sama; lapisan data memakai supabase-js.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app'), nav = $('#bottomnav');
const sb = window.supabase.createClient(window.CRM_CONFIG.supabaseUrl, window.CRM_CONFIG.supabaseAnonKey);

const S = {
  get token() { return localStorage.getItem('crm_token'); },
  set token(v) { v ? localStorage.setItem('crm_token', v) : localStorage.removeItem('crm_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('crm_user')); } catch { return null; } },
  set user(v) { v ? localStorage.setItem('crm_user', JSON.stringify(v)) : localStorage.removeItem('crm_user'); },
  get memberships() { try { return JSON.parse(localStorage.getItem('crm_memberships')) || []; } catch { return []; } },
  set memberships(v) { localStorage.setItem('crm_memberships', JSON.stringify(v)); },
  get orgId() { return localStorage.getItem('crm_org'); },
  set orgId(v) { v ? localStorage.setItem('crm_org', v) : localStorage.removeItem('crm_org'); },
  get facId() { return localStorage.getItem('crm_fac'); },
  set facId(v) { v ? localStorage.setItem('crm_fac', v) : localStorage.removeItem('crm_fac'); },
};
let role = null, online = navigator.onLine;

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- compat layer: REST-style api() di atas Supabase ----------
async function fn(name, body) {
  const res = await fetch(`${window.CRM_CONFIG.supabaseUrl}/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${S.token}`, apikey: window.CRM_CONFIG.supabaseAnonKey, 'Content-Type': 'application/json', 'x-organization-id': S.orgId || '' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const body = opts.body || {};
  const q = path.includes('?') ? Object.fromEntries(new URLSearchParams(path.split('?')[1])) : {};
  const p = path.split('?')[0];
  const facFilter = (q) => { let b = sb.from(q.table).select(q.select || '*').eq('organization_id', S.orgId); if (S.facId && q.facCol) b = b.eq(q.facCol, S.facId); return b; };

  // ---- auth ----
  if (p === '/api/auth/login') {
    const { data, error } = await sb.auth.signInWithPassword({ email: body.username, password: body.password });
    if (error) throw new Error('username atau password salah');
    S.token = data.session.access_token;
    S.user = { id: data.user.id, email: data.user.email, full_name: data.user.user_metadata?.full_name || body.username };
    const { data: mems } = await sb.from('memberships').select('*, organizations(name)').eq('user_id', data.user.id);
    S.memberships = (mems || []).map(m => ({ organization_id: m.organization_id, org_name: m.organizations.name, role: m.role, facility_scope: m.facility_scope }));
    return { token: S.token, user: S.user, memberships: S.memberships };
  }
  if (p === '/api/orgs') return S.memberships;
  if (p === '/api/auth/me') return { user: S.user, memberships: S.memberships, active: { role } };

  // ---- master ----
  if (p === '/api/facilities' && method === 'GET') return (await facFilter({ table: 'facilities' }).order('name')).data || [];
  if (p === '/api/services' && method === 'GET') { let b = sb.from('services').select('*').eq('organization_id', S.orgId); if (q.facility_id) b = b.eq('facility_id', q.facility_id); return (await b.order('name')).data || []; }
  if (p === '/api/services' && method === 'POST') { const { error } = await sb.from('services').insert({ organization_id: S.orgId, facility_id: body.facility_id || S.facId, name: body.name, description: body.description }); if (error) throw new Error(error.message); return { id: 'ok' }; }
  if (p === '/api/doctors' && method === 'GET') { let b = sb.from('doctors').select('*').eq('organization_id', S.orgId); if (q.facility_id) b = b.eq('facility_id', q.facility_id); return (await b.order('name')).data || []; }
  if (p === '/api/schedules' && method === 'GET') { let b = sb.from('schedules').select('*, services(name), doctors(name)').eq('organization_id', S.orgId); if (q.facility_id) b = b.eq('facility_id', q.facility_id); return (await b.order('day_of_week')).data || []; }
  if (p === '/api/slots') {
    let b = sb.from('schedules').select('*').eq('organization_id', S.orgId).eq('active', true);
    if (S.facId) b = b.eq('facility_id', S.facId); if (q.service_id) b = b.eq('service_id', q.service_id);
    const scheds = (await b).data || []; const out = []; const today = new Date();
    for (let i = 1; i <= 7; i++) {
      const d = new Date(today.getTime() + i * 86400000); const dateStr = d.toISOString().slice(0, 10);
      for (const sch of scheds) {
        if (d.getDay() !== sch.day_of_week) continue;
        const [sh, sm] = sch.start_time.split(':').map(Number); const [eh, em] = sch.end_time.split(':').map(Number);
        for (let t = sh * 60 + sm; t + sch.slot_minutes <= eh * 60 + em; t += sch.slot_minutes) {
          const start = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
          const { count } = await sb.from('registrations').select('*', { count: 'exact', head: true }).eq('schedule_id', sch.id).eq('slot_date', dateStr).eq('slot_start_time', start).in('status', ['awaiting_patient_confirmation', 'registered', 'completed']);
          if ((count || 0) < sch.quota_per_slot) out.push({ schedule_id: sch.id, date: dateStr, start, quota_left: sch.quota_per_slot - (count || 0), doctor_id: sch.doctor_id, service_id: sch.service_id });
        }
      }
    }
    return out.slice(0, 30);
  }

  // ---- pasien ----
  if (p === '/api/patients' && method === 'GET') {
    const s = `%${(q.search || '').toLowerCase()}%`;
    const { data } = await sb.from('patients').select('*').eq('organization_id', S.orgId).or(`full_name.ilike.${s},nik.ilike.${s},phone.ilike.${s}`).order('created_at', { ascending: false }).limit(50);
    return data || [];
  }
  if (p === '/api/patients' && method === 'POST') {
    const { data, error } = await sb.from('patients').insert({ organization_id: S.orgId, ...body }).select().single();
    if (error) { if (String(error.message).includes('duplicate')) { const e = new Error('NIK sudah terdaftar'); const ex = await sb.from('patients').select('*').eq('organization_id', S.orgId).eq('nik', body.nik).maybeSingle(); e.patient = ex.data; throw e; } throw new Error(error.message); }
    return { id: data.id };
  }

  // ---- pendaftaran ----
  if (p === '/api/registrations' && method === 'GET') {
    let b = sb.from('registrations').select('*, patients(full_name,nik), services(name), doctors(name)').eq('organization_id', S.orgId);
    if (S.facId) b = b.eq('facility_id', S.facId);
    if (q.status) b = b.eq('status', q.status);
    if (q.date) b = b.eq('slot_date', q.date);
    const { data } = await b.order('slot_date').limit(200);
    return (data || []).map(r => ({ ...r, patient_name: r.patients?.full_name, nik: r.patients?.nik, service_name: r.services?.name, doctor_name: r.doctors?.name }));
  }
  if (p === '/api/registrations' && method === 'POST') return fn('register-slot', body);
  const regCancel = p.match(/^\/api\/registrations\/([^/]+)\/cancel$/);
  if (regCancel) { await sb.from('registrations').update({ status: 'cancelled' }).eq('id', regCancel[1]); return { ok: true }; }

  // ---- percakapan ----
  if (p === '/api/conversations' && method === 'GET') {
    let b = sb.from('conversations').select('*, patients(full_name)').eq('organization_id', S.orgId);
    if (S.facId) b = b.eq('facility_id', S.facId);
    const convs = (await b.order('last_message_at', { ascending: false }).limit(100)).data || [];
    const ids = convs.map(c => c.id);
    const msgs = ids.length ? (await sb.from('messages').select('conversation_id,content,created_at').in('conversation_id', ids).order('created_at')).data || [] : [];
    const last = {}; for (const m of msgs) last[m.conversation_id] = m.content;
    return convs.map(c => ({ ...c, patient_name: c.patients?.full_name, last_message: last[c.id] || '-' }));
  }
  const convMsg = p.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (convMsg) {
    await sb.from('conversations').update({ unread: 0 }).eq('id', convMsg[1]);
    return (await sb.from('messages').select('*').eq('conversation_id', convMsg[1]).order('created_at').limit(500)).data || [];
  }
  const replyMatch = p.match(/^\/api\/conversations\/([^/]+)\/reply$/);
  if (replyMatch) return fn('gateway-action', { action: 'reply', conversation_id: replyMatch[1], content: body.content });
  const handoffMatch = p.match(/^\/api\/conversations\/([^/]+)\/(handoff|bot-on)$/);
  if (handoffMatch) {
    const on = handoffMatch[2] === 'bot-on';
    await sb.from('conversations').update({ needs_human: !on, status: on ? 'open' : 'human_handled' }).eq('id', handoffMatch[1]);
    if (on) await sb.from('bot_states').delete().eq('conversation_id', handoffMatch[1]);
    return { ok: true };
  }

  // ---- gateway ----
  if (p === '/api/wa-numbers') return (await sb.from('wa_numbers').select('*').eq('organization_id', S.orgId).order('created_at')).data || [];
  if (p === '/api/gateway/status') return fn('gateway-action', { action: 'status' });
  if (p === '/api/gateway/check-now') return fn('gateway-action', { action: 'check-now', wa_number_id: body.wa_number_id });
  if (p === '/api/gateway/switch') return fn('gateway-action', { action: 'switch-primary', wa_number_id: body.wa_number_id });
  if (p === '/api/gateway/switches') {
    const wa = (await sb.from('wa_numbers').select('id').eq('organization_id', S.orgId)).data || [];
    if (!wa.length) return [];
    return (await sb.from('gateway_switch_logs').select('*').in('wa_number_id', wa.map(w => w.id)).order('created_at', { ascending: false }).limit(50)).data || [];
  }
  if (p === '/api/outbox') { let b = sb.from('message_outbox').select('*').eq('organization_id', S.orgId); if (q.status) b = b.eq('status', q.status); return (await b.order('created_at', { ascending: false }).limit(100)).data || []; }

  // ---- bot & audit & dashboard ----
  if (p === '/api/bot/profile' && method === 'GET') {
    const profile = (await sb.from('bot_profiles').select('*').eq('organization_id', S.orgId).maybeSingle()).data;
    const knowledge_documents = (await sb.from('knowledge_documents').select('id,title,version,approved,created_at').eq('organization_id', S.orgId)).data || [];
    return { profile, knowledge_documents };
  }
  if (p === '/api/bot/profile' && method === 'PUT') { await sb.from('bot_profiles').upsert({ organization_id: S.orgId, name: body.name, language: body.language || 'id', tone: body.tone || 'ramah', greeting: body.greeting, enabled: body.enabled !== false }, { onConflict: 'organization_id' }); return { ok: true }; }
  if (p === '/api/bot/knowledge') { await sb.from('knowledge_documents').insert({ organization_id: S.orgId, title: body.title, content: body.content }); return { ok: true }; }
  if (p === '/api/audit') return (await sb.from('audit_logs').select('*').eq('organization_id', S.orgId).order('created_at', { ascending: false }).limit(Number(q.limit || 50))).data || [];
  if (p === '/api/dashboard') {
    const c = async (table, filters) => (await sb.from(table).select('*', { count: 'exact', head: true }).eq('organization_id', S.orgId).filter(filters || {})).count || 0;
    const upcoming = (await sb.from('registrations').select('*', { count: 'exact', head: true }).eq('organization_id', S.orgId).in('status', ['awaiting_patient_confirmation', 'registered']).gte('slot_date', new Date().toISOString().slice(0, 10))).count || 0;
    const unread = (await sb.from('conversations').select('*', { count: 'exact', head: true }).eq('organization_id', S.orgId).gt('unread', 0)).count || 0;
    const failed = (await sb.from('message_outbox').select('*', { count: 'exact', head: true }).eq('organization_id', S.orgId).in('status', ['failed', 'unknown'])).count || 0;
    const handoff = (await sb.from('conversations').select('*', { count: 'exact', head: true }).eq('organization_id', S.orgId).eq('needs_human', true).neq('status', 'closed')).count || 0;
    const wa_numbers = (await sb.from('wa_numbers').select('*').eq('organization_id', S.orgId)).data || [];
    return { upcoming_registrations: upcoming, unread_conversations: unread, failed_outbox: failed, pending_handoff: handoff, wa_numbers };
  }
  throw new Error('api tidak dikenali: ' + p);
}

function logout() { sb.auth.signOut(); S.token = null; S.user = null; S.memberships = null; S.orgId = null; S.facId = null; location.hash = '#/login'; }

// ---------- IndexedDB draft (sama seperti MVP) ----------
let idb = null;
function openIDB() { return new Promise((res, rej) => { const r = indexedDB.open('crm-drafts', 1); r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('drafts')) r.result.createObjectStore('drafts', { keyPath: 'id' }); }; r.onsuccess = () => { idb = r.result; res(idb); }; r.onerror = () => rej(r.error); }); }
async function draftAdd(d) { await openIDB(); return new Promise((res) => { const tx = idb.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put({ ...d, status: 'pending', created_at: new Date().toISOString() }); tx.oncomplete = res; }); }
async function draftAll() { await openIDB(); return new Promise((res) => { const tx = idb.transaction('drafts', 'readonly'); const q = tx.objectStore('drafts').getAll(); q.onsuccess = () => res(q.result || []); }); }
async function draftDel(id) { await openIDB(); return new Promise((res) => { const tx = idb.transaction('drafts', 'readwrite'); tx.objectStore('drafts').delete(id); tx.oncomplete = res; }); }
async function draftCount() { return (await draftAll()).filter(d => d.status === 'pending').length; }

// ---------- Header + nav (SAMA dengan MVP) ----------
function activeMembership() { return S.memberships.find(m => m.organization_id === S.orgId); }
function orgName() { return activeMembership()?.org_name || '-'; }
function headerHtml(extra = '') { return `<header class="app"><div class="org">${esc(orgName())} <span class="dot ${online ? 'on' : 'off'}"></span>${extra}</div><div class="sub"><span id="fac-label">…</span><span id="sync-label"></span></div></header>`; }
async function refreshHeader() {
  const fl = $('#fac-label'); if (fl) { if (S.facId) { try { const f = (await api('/api/facilities')).find(x => x.id === S.facId); fl.textContent = f ? '🏥 ' + f.name : ''; } catch { fl.textContent = ''; } } else fl.textContent = '(semua cabang)'; }
  const sl = $('#sync-label'); if (sl) { const c = await draftCount(); sl.textContent = c ? `📥 ${c} draft tertunda` : ''; }
  try { const d = await api('/api/dashboard'); const b = $('#badge-conv'); if (b) b.textContent = d.unread_conversations || ''; } catch {}
}
function showNav(tab) { nav.classList.remove('hidden'); $$('#bottomnav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); }

// ---------- Views (identik dengan MVP; memakai api() compat) ----------
async function viewLogin() {
  nav.classList.add('hidden');
  app.innerHTML = `<div class="screen login-box"><div style="font-size:44px">🏥</div><h1>CRM Multi-Klinik</h1><p>GitHub Pages + Supabase + Home Lab WA Gateway.</p>
    <div class="card" style="text-align:left"><input id="u" placeholder="Email (mis. admin@klinik.local)"><input id="p" type="password" placeholder="Password"><button id="btn-login" style="width:100%">Masuk</button></div>
    <p class="muted">Buat akun staf di Supabase Authentication → Users, lalu daftarkan keanggotaan di tabel memberships.</p></div>`;
  $('#btn-login').onclick = async () => {
    try { await api('/api/auth/login', { method: 'POST', body: { username: $('#u').value.trim(), password: $('#p').value } }); location.hash = S.memberships.length === 1 ? '#/home' : '#/pick-org'; }
    catch (e) { toast(e.message); }
  };
}
async function viewPickOrg() {
  nav.classList.add('hidden');
  app.innerHTML = `<div class="screen"><h2 style="margin-bottom:12px">Pilih organisasi aktif</h2>` + S.memberships.map(m => `<div class="list-item" data-org="${m.organization_id}" style="cursor:pointer"><div><div class="title">${esc(m.org_name)}</div><div class="meta">Peran: ${esc(m.role)}</div></div><span class="pill teal">→</span></div>`).join('') + `</div>`;
  $$('.list-item[data-org]').forEach(el => el.onclick = () => { S.orgId = el.dataset.org; const m = activeMembership(); if (m?.facility_scope?.length) S.facId = m.facility_scope[0]; role = m.role; location.hash = '#/home'; });
}
async function viewHome() {
  showNav('home'); app.innerHTML = headerHtml() + `<div class="screen" id="home-body"><div class="empty">Memuat…</div></div>`; refreshHeader();
  try {
    const d = await api('/api/dashboard');
    $('#home-body').innerHTML = `<div class="stats">
      <div class="stat"><div class="num">${d.upcoming_registrations}</div><div class="lbl">Pendaftaran aktif</div></div>
      <div class="stat"><div class="num">${d.unread_conversations}</div><div class="lbl">Belum dibaca</div></div>
      <div class="stat"><div class="num" style="color:${d.failed_outbox ? 'var(--red)' : 'var(--teal)'}">${d.failed_outbox}</div><div class="lbl">Pesan gagal/unknown</div></div>
      <div class="stat"><div class="num" style="color:${d.pending_handoff ? 'var(--amber)' : 'var(--teal)'}">${d.pending_handoff}</div><div class="lbl">Butuh staf</div></div></div>
      <div class="card"><h3>Status Gateway</h3>${d.wa_numbers.length ? d.wa_numbers.map(w => `<div class="row-flex" style="margin:6px 0"><span>${esc(w.label || w.number)} <span class="muted">(${w.primary_gateway})</span></span><span class="pill ${w.healthy ? 'green' : 'red'}">${w.healthy ? 'sehat' : 'gangguan'}</span></div>`).join('') : '<p class="muted">Belum ada nomor WA.</p>'}<div class="btn-row" style="margin-top:10px"><button class="secondary" onclick="location.hash='#/gateway'">Kelola gateway</button></div></div>
      <div class="card"><h3>Sinkronisasi Offline</h3><p class="muted" id="draft-count">…</p><div class="btn-row" style="margin-top:10px"><button id="btn-sync">Sinkronkan sekarang</button></div></div>`;
    $('#draft-count').textContent = (await draftCount()) + ' draft tertunda';
    $('#btn-sync').onclick = syncDrafts;
  } catch (e) { $('#home-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function syncDrafts() {
  const drafts = await draftAll(); if (!drafts.length) { toast('Tidak ada draft'); return; }
  let ok = 0, fail = 0;
  for (const d of drafts) { try { const r = await api('/api/registrations', { method: 'POST', body: { ...d, source: 'offline_draft' } }); if (r.id) { await draftDel(d.id); ok++; } } catch (e) { fail++; if (e.message.includes('penuh')) toast(`Slot ${d.slot_date} ${d.slot_start_time} penuh`); } }
  toast(`Sinkron selesai: ${ok} berhasil, ${fail} perlu ditinjau`); refreshHeader(); viewHome();
}
async function viewConversations() {
  showNav('conversations'); app.innerHTML = headerHtml() + `<div class="screen" id="conv-body"><div class="empty">Memuat…</div></div>`; refreshHeader();
  try {
    const rows = await api('/api/conversations');
    $('#conv-body').innerHTML = rows.length ? rows.map(c => `<div class="list-item" data-cid="${c.id}" style="cursor:pointer"><div style="flex:1;min-width:0"><div class="title">${esc(c.patient_name || c.from_number)} ${c.unread ? `<span class="pill teal">${c.unread}</span>` : ''}</div><div class="meta" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.last_message || '-')}</div></div><span class="pill ${c.needs_human ? 'amber' : 'gray'}">${c.needs_human ? 'petugas' : 'bot'}</span></div>`).join('') : '<div class="empty">Belum ada percakapan. Arahkan webhook Baileys/Fonnte ke /functions/v1/wa-webhook.</div>';
    $$('.list-item[data-cid]').forEach(el => el.onclick = () => location.hash = '#/conv/' + el.dataset.cid);
  } catch (e) { $('#conv-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function viewConvDetail(id) {
  showNav('conversations');
  app.innerHTML = headerHtml() + `<div class="chat-head"><button class="secondary" onclick="location.hash='#/conversations'">←</button><div style="flex:1"><div class="title" id="conv-title">…</div><div class="muted" id="conv-status"></div></div><button class="secondary" id="btn-toggle-bot" style="padding:6px 10px;font-size:12px">…</button></div><div class="bubbles" id="bubbles"></div><div class="chat-input"><input id="chat-text" placeholder="Ketik balasan…"><button id="btn-send">Kirim</button></div>`;
  try {
    const msgs = await api(`/api/conversations/${id}/messages`);
    $('#bubbles').innerHTML = msgs.map(m => `<div class="bubble ${m.direction}">${esc(m.content)}${m.direction === 'out' ? `<div class="st">${esc(m.status || '')}</div>` : ''}</div>`).join('') || '<div class="empty">Belum ada pesan</div>';
    const convs = await api('/api/conversations'); const c = convs.find(x => x.id === id);
    if (c) { $('#conv-title').textContent = c.patient_name || c.from_number; $('#conv-status').textContent = c.needs_human ? 'menunggu tanggapan staf' : 'bot aktif'; $('#btn-toggle-bot').textContent = c.needs_human ? 'Aktifkan bot' : 'Alihkan ke staf'; }
    $('#btn-toggle-bot').onclick = async () => { const c2 = (await api('/api/conversations')).find(x => x.id === id); await api(`/api/conversations/${id}/${c2.needs_human ? 'bot-on' : 'handoff'}`, { method: 'POST' }); toast(c2.needs_human ? 'Bot diaktifkan' : 'Dialihkan ke staf'); viewConvDetail(id); };
    $('#btn-send').onclick = async () => { const t = $('#chat-text').value.trim(); if (!t) return; await api(`/api/conversations/${id}/reply`, { method: 'POST', body: { content: t } }); $('#chat-text').value = ''; viewConvDetail(id); };
  } catch (e) { toast(e.message); }
}
async function viewRegistrations() {
  showNav('registrations'); app.innerHTML = headerHtml() + `<div class="screen"><div class="btn-row" style="margin-bottom:12px"><button id="btn-new-reg">+ Pendaftaran Baru</button><button class="secondary" id="btn-sync2">Sinkron draft</button></div><div id="reg-body"><div class="empty">Memuat…</div></div></div>`; refreshHeader();
  $('#btn-new-reg').onclick = () => location.hash = '#/reg-new'; $('#btn-sync2').onclick = syncDrafts;
  try {
    const rows = await api('/api/registrations');
    const stPill = s => ({ registered: 'green', awaiting_patient_confirmation: 'amber', completed: 'teal', cancelled: 'gray', draft: 'gray', need_reschedule: 'red' }[s] || 'gray');
    $('#reg-body').innerHTML = rows.length ? rows.map(r => `<div class="list-item"><div><div class="title">${esc(r.patient_name || '-')}</div><div class="meta">${esc(r.service_name || '')} · ${r.slot_date} ${r.slot_start_time} · ${esc(r.doctor_name || '')}</div></div><span class="pill ${stPill(r.status)}">${r.status}</span></div>`).join('') : '<div class="empty">Belum ada pendaftaran.</div>';
  } catch (e) { $('#reg-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
let regDraft = {};
async function viewRegNew() {
  showNav('registrations');
  app.innerHTML = headerHtml() + `<div class="screen"><h3 style="margin-bottom:10px">Pendaftaran Baru</h3>
    <div class="card"><h3>1. Pasien</h3><input id="r-search" placeholder="Cari nama / NIK / HP…"><div id="r-patients"></div>
      <div class="muted" style="margin:6px 0">Atau isi data baru:</div>
      <input id="r-nik" placeholder="NIK (16 digit)"><input id="r-name" placeholder="Nama lengkap"><input id="r-bp" placeholder="Tempat lahir"><input id="r-bd" type="date"><input id="r-phone" placeholder="No HP (notifikasi WA)">
      <button class="secondary" id="r-save-pasien">Simpan pasien</button></div>
    <div class="card"><h3>2. Layanan & Jadwal</h3><select id="r-service"><option value="">Pilih layanan…</option></select><div id="r-slots"><p class="muted">Pilih layanan untuk melihat slot.</p></div></div>
    <button id="r-submit" style="width:100%" disabled>Daftarkan (simpan draft jika offline)</button>
    <p class="muted" style="margin-top:8px;text-align:center">Saat offline, disimpan sebagai draft dan divalidasi ulang backend saat sinkron.</p></div>`;
  refreshHeader(); regDraft = {};
  try { const svcs = await api('/api/services'); $('#r-service').innerHTML = '<option value="">Pilih layanan…</option>' + svcs.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join(''); } catch {}
  $('#r-search').oninput = async () => { const q = $('#r-search').value.trim(); if (q.length < 3) return; try { const ps = await api('/api/patients?search=' + encodeURIComponent(q)); $('#r-patients').innerHTML = ps.map(p => `<div class="list-item" data-pid="${p.id}" style="cursor:pointer;padding:8px 10px"><div><div class="title">${esc(p.full_name)}</div><div class="meta">${esc(p.nik || '')} · ${esc(p.phone || '')}</div></div><span class="pill teal">pilih</span></div>`).join('') || '<p class="muted">Tidak ditemukan</p>'; $$('#r-patients .list-item').forEach(el => el.onclick = () => { regDraft.patient_id = el.dataset.pid; toast('Pasien dipilih'); checkRegReady(); }); } catch {} };
  $('#r-save-pasien').onclick = async () => { const body = { nik: $('#r-nik').value.trim(), full_name: $('#r-name').value.trim(), birth_place: $('#r-bp').value.trim(), birth_date: $('#r-bd').value, phone: $('#r-phone').value.trim() }; if (!body.full_name) return toast('Nama lengkap wajib'); if (!navigator.onLine) { regDraft.newPatient = body; toast('Disimpan di draft'); checkRegReady(); return; } try { const r = await api('/api/patients', { method: 'POST', body }); regDraft.patient_id = r.id; toast('Pasien tersimpan'); checkRegReady(); } catch (e) { if (e.patient) { regDraft.patient_id = e.patient.id; toast('Pasien sudah ada'); checkRegReady(); } else toast(e.message); } };
  $('#r-service').onchange = async () => { const sid = $('#r-service').value; if (!sid) return; try { const slots = await api('/api/slots?service_id=' + sid); $('#r-slots').innerHTML = slots.length ? slots.map((s, i) => `<div class="list-item" data-idx="${i}" style="cursor:pointer;padding:8px 10px"><div><div class="title">${s.date} ${s.start}</div><div class="meta">sisa kuota ${s.quota_left}</div></div><span class="pill green">pilih</span></div>`).join('') : '<p class="muted">Tidak ada slot 7 hari ke depan.</p>'; $$('#r-slots .list-item').forEach((el, i) => el.onclick = () => { const s = slots[i]; regDraft.schedule_id = s.schedule_id; regDraft.slot_date = s.date; regDraft.slot_start_time = s.start; regDraft.service_id = s.service_id; regDraft.doctor_id = s.doctor_id; toast('Slot dipilih'); checkRegReady(); }); } catch (e) { $('#r-slots').innerHTML = `<p class="muted">${esc(e.message)}</p>`; } };
  $('#r-submit').onclick = submitReg;
}
function checkRegReady() { $('#r-submit').disabled = !(regDraft.patient_id && regDraft.schedule_id); }
async function submitReg() {
  const body = { patient_id: regDraft.patient_id, service_id: regDraft.service_id, doctor_id: regDraft.doctor_id, schedule_id: regDraft.schedule_id, slot_date: regDraft.slot_date, slot_start_time: regDraft.slot_start_time, facility_id: S.facId };
  if (!navigator.onLine) { await draftAdd({ id: 'draft-' + Date.now(), ...body, newPatient: regDraft.newPatient }); toast('Disimpan sebagai draft offline'); location.hash = '#/registrations'; return; }
  try { if (regDraft.newPatient && !regDraft.patient_id) { try { const p = await api('/api/patients', { method: 'POST', body: regDraft.newPatient }); body.patient_id = p.id; } catch (e) { if (e.patient) body.patient_id = e.patient.id; else throw e; } } const r = await api('/api/registrations', { method: 'POST', body }); toast('Pendaftaran berhasil'); location.hash = '#/registrations'; }
  catch (e) { toast(e.message.includes('penuh') ? 'Slot penuh, pilih jadwal lain' : e.message); }
}
async function viewMore() { showNav('more'); app.innerHTML = headerHtml() + `<div class="screen"><div class="section-title">Data</div><div class="list-item" data-go="#/patients" style="cursor:pointer"><div class="title">👤 Pasien</div><span class="pill gray">→</span></div><div class="section-title">Operasional</div><div class="list-item" data-go="#/gateway" style="cursor:pointer"><div class="title">📡 Gateway & Failover</div><span class="pill gray">→</span></div><div class="list-item" data-go="#/bot" style="cursor:pointer"><div class="title">🤖 Konfigurasi Bot</div><span class="pill gray">→</span></div><div class="list-item" data-go="#/audit" style="cursor:pointer"><div class="title">📜 Audit Log</div><span class="pill gray">→</span></div><div class="section-title">Akun</div><div class="list-item" data-go="#/settings" style="cursor:pointer"><div class="title">⚙️ Pengaturan (org/cabang)</div><span class="pill gray">→</span></div></div>`; refreshHeader(); $$('.list-item[data-go]').forEach(el => el.onclick = () => location.hash = el.dataset.go); }
async function viewPatients() { showNav('more'); app.innerHTML = headerHtml() + `<div class="screen"><input id="p-search" placeholder="Cari pasien…"><div id="p-list"><div class="empty">Ketik untuk mencari.</div></div></div>`; refreshHeader(); $('#p-search').oninput = async () => { const q = $('#p-search').value.trim(); if (q.length < 2) return; try { const ps = await api('/api/patients?search=' + encodeURIComponent(q)); $('#p-list').innerHTML = ps.map(p => `<div class="list-item"><div><div class="title">${esc(p.full_name)}</div><div class="meta">NIK ${esc(p.nik || '-')} · HP ${esc(p.phone || '-')}</div></div></div>`).join('') || '<div class="empty">Tidak ditemukan.</div>'; } catch (e) { $('#p-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; } }; }
async function viewGateway() {
  showNav('more'); app.innerHTML = headerHtml() + `<div class="screen" id="gw-body"><div class="empty">Memuat…</div></div>`; refreshHeader();
  try {
    const d = await api('/api/gateway/status'); const sw = await api('/api/gateway/switches').catch(() => []);
    $('#gw-body').innerHTML = (d.numbers || []).map(w => `<div class="card"><h3>${esc(w.label || w.number)}</h3>
      <div class="row-flex" style="margin:6px 0"><span>Gateway utama</span><span class="pill teal">${esc(w.primary_gateway)}</span></div>
      <div class="row-flex" style="margin:6px 0"><span>Kesehatan</span><span class="pill ${w.healthy ? 'green' : 'red'}">${w.healthy ? 'sehat' : 'gangguan'}</span></div>
      <div class="row-flex" style="margin:6px 0"><span>Gagal berturut</span><span>${w.consecutive_failures || 0}</span></div>
      <div class="btn-row" style="margin-top:10px"><button class="secondary" data-check="${w.id}">Cek sekarang</button><button class="secondary" data-switch="${w.id}">Ganti ke ${w.primary_gateway === 'baileys' ? 'Fonnte' : 'Baileys'}</button></div></div>`).join('') +
      `<div class="card"><h3>Riwayat perpindahan</h3>${sw.length ? sw.map(s => `<div class="meta" style="margin:4px 0">${s.created_at}: ${esc(s.from_gateway)} → ${esc(s.to_gateway)} (${esc(s.reason || '')})</div>`).join('') : '<p class="muted">Belum ada.</p>'}</div>`;
    $$('[data-check]').forEach(b => b.onclick = async () => { const r = await api('/api/gateway/check-now', { method: 'POST', body: { wa_number_id: b.dataset.check } }); toast('Status: ' + JSON.stringify(r).slice(0, 80)); viewGateway(); });
    $$('[data-switch]').forEach(b => b.onclick = async () => { await api('/api/gateway/switch', { method: 'POST', body: { wa_number_id: b.dataset.switch } }); toast('Gateway diganti'); viewGateway(); });
  } catch (e) { $('#gw-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function viewBot() {
  showNav('more'); app.innerHTML = headerHtml() + `<div class="screen" id="bot-body"><div class="empty">Memuat…</div></div>`; refreshHeader();
  try {
    const d = await api('/api/bot/profile'); const p = d.profile || {};
    $('#bot-body').innerHTML = `<div class="card"><h3>Profil Bot</h3><input id="b-name" value="${esc(p.name || '')}" placeholder="Nama bot"><input id="b-greet" value="${esc(p.greeting || '')}" placeholder="Sapaan"><label class="muted"><input type="checkbox" id="b-enabled" ${p.enabled ? 'checked' : ''} style="width:auto;margin-right:6px">Bot aktif</label><button id="b-save" style="width:100%;margin-top:8px">Simpan</button></div>
      <div class="card"><h3>Dokumen pengetahuan (FAQ)</h3>${(d.knowledge_documents || []).map(k => `<div class="meta" style="margin:4px 0">v${k.version} · ${esc(k.title)}</div>`).join('') || '<p class="muted">Belum ada.</p>'}<input id="k-title" placeholder="Judul" style="margin-top:8px"><textarea id="k-content" rows="3" placeholder="Isi informasi…"></textarea><button id="k-add" class="secondary" style="width:100%">Tambah dokumen</button></div>`;
    $('#b-save').onclick = async () => { await api('/api/bot/profile', { method: 'PUT', body: { name: $('#b-name').value, greeting: $('#b-greet').value, enabled: $('#b-enabled').checked } }); toast('Tersimpan'); };
    $('#k-add').onclick = async () => { await api('/api/bot/knowledge', { method: 'POST', body: { title: $('#k-title').value, content: $('#k-content').value } }); toast('Dokumen ditambahkan'); viewBot(); };
  } catch (e) { $('#bot-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function viewAudit() { showNav('more'); app.innerHTML = headerHtml() + `<div class="screen" id="audit-body"><div class="empty">Memuat…</div></div>`; try { const rows = await api('/api/audit?limit=80'); $('#audit-body').innerHTML = rows.map(a => `<div class="list-item" style="padding:8px 10px"><div><div class="title" style="font-size:13px">${esc(a.action)}</div><div class="meta">${esc(a.entity || '')} · ${a.created_at}</div></div></div>`).join('') || '<div class="empty">Belum ada log.</div>'; } catch (e) { $('#audit-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`; } }
async function viewSettings() {
  showNav('more'); app.innerHTML = headerHtml() + `<div class="screen"><div class="card"><h3>Organisasi & Cabang Aktif</h3><select id="s-org">${S.memberships.map(m => `<option value="${m.organization_id}" ${m.organization_id === S.orgId ? 'selected' : ''}>${esc(m.org_name)} (${esc(m.role)})</option>`).join('')}</select><select id="s-fac"><option value="">(semua cabang)</option></select><button id="s-apply" style="width:100%;margin-top:8px">Terapkan</button></div><div class="card"><h3>Akun</h3><p class="muted" style="margin-bottom:8px">${esc(S.user?.email || '')}</p><button class="danger" id="s-logout" style="width:100%">Keluar</button></div></div>`;
  try { const facs = await api('/api/facilities'); $('#s-fac').innerHTML = '<option value="">(semua cabang)</option>' + facs.map(f => `<option value="${f.id}" ${f.id === S.facId ? 'selected' : ''}>${esc(f.name)}</option>`).join(''); } catch {}
  $('#s-apply').onclick = () => { S.orgId = $('#s-org').value; S.facId = $('#s-fac').value || null; toast('Diterapkan'); location.hash = '#/home'; };
  $('#s-logout').onclick = () => { logout(); toast('Anda keluar'); };
}

const routes = { '#/login': viewLogin, '#/pick-org': viewPickOrg, '#/home': viewHome, '#/conversations': viewConversations, '#/registrations': viewRegistrations, '#/reg-new': viewRegNew, '#/more': viewMore, '#/patients': viewPatients, '#/gateway': viewGateway, '#/bot': viewBot, '#/audit': viewAudit, '#/settings': viewSettings };
async function route() {
  const h = location.hash || '#/home';
  if (!S.token) { location.hash = '#/login'; return viewLogin(); }
  if (!S.orgId && h !== '#/pick-org') { if (S.memberships.length === 1) { S.orgId = S.memberships[0].organization_id; role = S.memberships[0].role; } else { location.hash = '#/pick-org'; return; } }
  const conv = h.match(/^#\/conv\/(.+)$/); if (conv) return viewConvDetail(conv[1]);
  try { await (routes[h] || viewHome)(); } catch (e) { toast(e.message); }
}
window.addEventListener('hashchange', route);
window.addEventListener('online', () => { online = true; toast('Online — sinkronisasi draft'); syncDrafts(); route(); });
window.addEventListener('offline', () => { online = false; toast('Mode offline'); route(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
route();
