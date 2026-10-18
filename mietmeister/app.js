/* Mietmeister – gemeinsame Logik. Anmeldung und alle Daten (Angebote, Buchungen, Bewertungen) liegen in Supabase. */
(function () {
  'use strict';

  var CATS = ['Werkzeug', 'Garten', 'Foto & Video', 'Camping', 'Party & Event', 'Haushalt'];
  var STATUS = { angefragt: 'Angefragt', bestaetigt: 'Bestätigt', abgelehnt: 'Abgelehnt', storniert: 'Storniert', zurueck: 'Zurückgegeben' };
  var ICONS = { 'Werkzeug': '🔧', 'Garten': '🌿', 'Foto & Video': '📷', 'Camping': '⛺', 'Party & Event': '🎉', 'Haushalt': '🏠' };
  var DAY = 86400000;
  function catIdx(c) { return Math.max(0, CATS.indexOf(c)); }
  function regionOf(it) { var r = ((it.plz || '') + ' ' + (it.ort || '')).trim(); return r || 'Region nicht angegeben'; }

  /* Zwischenspeicher im Arbeitsspeicher: wird beim Seitenstart aus Supabase geladen und nach jeder Änderung erneuert */
  var C = { me: null, profiles: {}, items: [], bookings: [], addr: {}, contacts: {}, itemR: {}, userR: {}, extras: {}, loadError: '' };

  /* ---------- Helfer ---------- */
  var eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  var eur0 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function parse(v) { return new Date(v + 'T00:00:00'); }
  function addDays(n) { var d = new Date(); d.setDate(d.getDate() + n); return iso(d); }
  function fmtDate(v) { return parse(v).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }); }
  function km(d) { return d == null ? '' : d.toFixed(1).replace('.', ',') + ' km'; }
  function num1(r) { return r.toFixed(1).replace('.', ','); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  /* ---------- Supabase ---------- */
  var CFG = window.MM_CONFIG || {};
  var sb = null;
  function authProblem() {
    var u = String(CFG.SUPABASE_URL || ''), k = String(CFG.SUPABASE_ANON_KEY || '');
    if (!/^https:\/\//.test(u) || u.indexOf('DEIN-PROJEKT') !== -1 || k.length < 20 || k.indexOf('DEIN-') === 0) return 'Supabase ist noch nicht verbunden. Trage Project-URL und Key in die Datei config.js ein.';
    if (!window.supabase || !window.supabase.createClient) return 'Die Supabase-Bibliothek konnte nicht geladen werden. Bitte prüfe deine Internetverbindung.';
    return '';
  }
  function cacheProfile(u) {
    var p = { id: u.id, name: (u.user_metadata && u.user_metadata.name) || String(u.email || '').split('@')[0] || 'Nutzer', email: u.email || null };
    C.me = p; C.profiles[p.id] = { id: p.id, name: p.name };
    return p;
  }
  function client() {
    if (sb) return sb;
    if (authProblem()) return null;
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    sb.auth.onAuthStateChange(function (ev, session) {
      if (ev === 'SIGNED_OUT') C.me = null;
      else if (session && session.user) cacheProfile(session.user);
    });
    return sb;
  }
  function syncSession() {
    var c = client();
    if (!c) { C.me = null; return Promise.resolve(); }
    return c.auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session;
      if (s && s.user) cacheProfile(s.user); else C.me = null;
    }).catch(function () { C.me = null; });
  }
  function authError(e) {
    var m = String((e && e.message) || '').toLowerCase(), code = e && e.code;
    if (code === 'invalid_credentials' || m.indexOf('invalid login') !== -1) return 'E-Mail oder Passwort stimmt nicht.';
    if (code === 'email_not_confirmed' || m.indexOf('not confirmed') !== -1) return 'Bitte bestätige zuerst deine E-Mail-Adresse über den Link in der Bestätigungsmail.';
    if (code === 'user_already_exists' || m.indexOf('already registered') !== -1) return 'Mit dieser E-Mail gibt es schon ein Konto. Bitte melde dich an.';
    if (code === 'weak_password' || (m.indexOf('password') !== -1 && m.indexOf('least') !== -1)) return 'Das Passwort ist zu schwach. Nimm mindestens 8 Zeichen.';
    if (code === 'signup_disabled') return 'Registrierungen sind in Supabase derzeit deaktiviert.';
    if (code === 'over_email_send_rate_limit' || (e && e.status === 429) || m.indexOf('rate limit') !== -1) return 'Zu viele Versuche. Bitte warte kurz und versuche es erneut.';
    return 'Das hat nicht geklappt: ' + ((e && e.message) || 'Unbekannter Fehler');
  }
  function netError() { return { ok: false, error: 'Keine Verbindung zu Supabase. Bitte prüfe deine Internetverbindung.' }; }

  /* ---------- Daten aus Supabase ---------- */
  function num(v) { return v == null ? 0 : +v; }
  function ts(v) { return v ? Date.parse(v) : 0; }
  function mapItem(r) {
    return { id: r.id, ownerId: r.owner_id, name: r.name, cat: r.cat, plz: r.plz || '', ort: r.ort || '', street: C.addr[r.id] || '', price: num(r.price), dep: num(r.dep), desc: r.descr || '', created: ts(r.created_at) };
  }
  function mapBooking(r) {
    return {
      id: r.id, code: r.code, itemId: r.item_id, ownerId: r.owner_id, renterId: r.renter_id, start: r.start_date, end: r.end_date,
      days: num(r.days), ins: !!r.ins, base: num(r.base), disc: num(r.disc), service: num(r.service), insurance: num(r.insurance),
      total: num(r.total), payout: num(r.payout), dep: num(r.dep), status: r.status, msg: r.msg || '', created: ts(r.created_at),
      rating: num(r.rating), review: r.review || '', ratedAt: ts(r.rated_at),
      ownerRating: num(r.owner_rating), ownerReview: r.owner_review || '', ownerRatedAt: ts(r.owner_rated_at)
    };
  }
  function dbError(e) {
    if (!e) return 'Das hat nicht geklappt.';
    var m = String(e.message || '');
    if (e.code === '23P01') return 'Der Zeitraum überschneidet sich mit einer bestätigten Buchung.';
    if (e.code === 'PGRST116') return 'Diese Änderung ist nicht möglich.';
    if (e.code === '42501' || /row-level security|permission denied|JWT/i.test(m)) return 'Dafür fehlt dir die Berechtigung. Bitte melde dich neu an.';
    if (/[äöüß]|bitte|nicht|darf|kann|Zeitraum|Angebot|Buchung/i.test(m) && !/violates|relation|column|syntax/i.test(m)) return m;
    if (/fetch|network/i.test(m)) return 'Keine Verbindung zu Supabase. Bitte prüfe deine Internetverbindung.';
    return 'Das hat nicht geklappt. Bitte versuche es erneut.';
  }
  function loadAll() {
    var c = client(); if (!c) return Promise.resolve();
    var q = [
      c.from('items').select('*').order('created_at', { ascending: false }),
      c.from('profiles').select('id,name'),
      c.rpc('item_ratings'),
      c.rpc('user_ratings')
    ];
    if (C.me) q.push(c.from('bookings').select('*').order('created_at', { ascending: false }), c.from('item_addresses').select('*'), c.from('contacts').select('*'));
    return Promise.all(q).then(function (rs) {
      var bad = rs.filter(function (r) { return r.error; })[0];
      if (bad) { C.loadError = dbError(bad.error); return; }
      C.loadError = '';
      C.profiles = {}; (rs[1].data || []).forEach(function (p) { C.profiles[p.id] = { id: p.id, name: p.name }; });
      C.itemR = {}; (rs[2].data || []).forEach(function (r) { C.itemR[r.item_id] = { avg: num(r.avg_rating), n: num(r.n_ratings) }; });
      C.userR = {}; (rs[3].data || []).forEach(function (r) { C.userR[r.user_id] = r; });
      C.addr = {}; C.contacts = {}; C.bookings = [];
      if (C.me) {
        C.bookings = (rs[4].data || []).map(mapBooking);
        (rs[5].data || []).forEach(function (a) { C.addr[a.item_id] = a.street || ''; });
        (rs[6].data || []).forEach(function (k) { C.contacts[k.id] = k.email; });
      }
      C.items = (rs[0].data || []).map(mapItem);
    }).catch(function () { C.loadError = 'Keine Verbindung zu Supabase. Bitte prüfe deine Internetverbindung.'; });
  }
  function run(p) { return Promise.resolve(p).catch(function () { return { error: { message: 'network' } }; }); }
  function failed(e) { return { ok: false, error: dbError(e) }; }

  /* ---------- Zugriff ---------- */
  function items() { return C.items; }
  function bookings() { return C.bookings; }
  function me() { return C.me; }
  function userById(id) {
    var p = C.profiles[id]; if (!p) return null;
    return { id: p.id, name: p.name, email: C.contacts[id] || null };
  }
  function userName(id) { var u = userById(id); return u ? u.name : 'Unbekannt'; }
  function item(id) { return C.items.filter(function (i) { return i.id === id; })[0] || null; }
  function booking(id) { return C.bookings.filter(function (b) { return b.id === id; })[0] || null; }

  /* Belegung und Bewertungen eines Angebots (öffentlich, ohne persönliche Daten) */
  function loadItemExtras(id) {
    var c = client(); if (!c) return Promise.resolve();
    return Promise.all([run(c.rpc('item_occupancy', { p_item: id })), run(c.rpc('item_reviews', { p_item: id }))]).then(function (rs) {
      C.extras[id] = {
        occ: (rs[0].data || []).map(function (o) { return { start: o.start_date, end: o.end_date, status: o.status }; }),
        reviews: (rs[1].data || []).map(function (r) { return { rating: num(r.rating), review: r.review || '', ratedAt: ts(r.rated_at), name: r.renter_name || 'Mieter' }; })
      };
    });
  }
  /* Belegte Zeiträume: öffentliche Belegung plus eigene Anfragen */
  function occupancy(id) {
    var list = ((C.extras[id] && C.extras[id].occ) || []).slice(), seen = {};
    list.forEach(function (o) { seen[o.start + '|' + o.end + '|' + o.status] = 1; });
    C.bookings.forEach(function (b) {
      if (b.itemId !== id || (b.status !== 'bestaetigt' && b.status !== 'angefragt')) return;
      var k = b.start + '|' + b.end + '|' + b.status;
      if (!seen[k]) { seen[k] = 1; list.push({ id: b.id, start: b.start, end: b.end, status: b.status }); }
    });
    return list;
  }
  function reviews(id) { return (C.extras[id] && C.extras[id].reviews) || []; }

  /* ---------- Preisberechnung ---------- */
  function calc(it, s, e, ins) {
    var a = parse(s), b = parse(e);
    if (isNaN(a) || isNaN(b) || b < a) return null;
    var days = Math.round((b - a) / DAY) + 1;
    var base = it.price * days;
    var disc = days >= 7 ? base * 0.2 : 0;
    var service = (base - disc) * 0.08;
    var insurance = ins ? 2 * days : 0;
    return {
      days: days, base: base, disc: disc, service: service, insurance: insurance,
      total: base - disc + service + insurance,
      payout: (base - disc) * 0.9
    };
  }

  function overlap(itemId, s, e, statuses, exceptId) {
    return occupancy(itemId).filter(function (b) {
      return !(exceptId && b.id === exceptId) && statuses.indexOf(b.status) !== -1 && b.start <= e && s <= b.end;
    });
  }

  function ratingOf(it) { return C.itemR[it.id] || { avg: 0, n: 0 }; }

  /* ---------- Login (Supabase Auth) ---------- */
  function register(name, email, pw) {
    name = (name || '').trim(); email = (email || '').trim().toLowerCase(); pw = pw || '';
    if (name.length < 2) return Promise.resolve({ ok: false, error: 'Bitte gib deinen Namen an.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return Promise.resolve({ ok: false, error: 'Bitte gib eine gültige E-Mail-Adresse an.' });
    if (pw.length < 8) return Promise.resolve({ ok: false, error: 'Das Passwort braucht mindestens 8 Zeichen.' });
    var c = client(); if (!c) return Promise.resolve({ ok: false, error: authProblem() });
    var opts = { data: { name: name } };
    if (/^https?:$/.test(location.protocol)) opts.emailRedirectTo = location.origin + location.pathname.replace(/[^\/]*$/, '') + 'login.html';
    return c.auth.signUp({ email: email, password: pw, options: opts }).then(function (r) {
      if (r.error) return { ok: false, error: authError(r.error) };
      var u = r.data && r.data.user;
      if (u && u.identities && u.identities.length === 0) return { ok: false, error: 'Mit dieser E-Mail gibt es schon ein Konto. Bitte melde dich an.' };
      if (r.data && r.data.session && r.data.session.user) return { ok: true, user: cacheProfile(r.data.session.user) };
      return { ok: true, needsConfirm: true, email: email };
    }).catch(netError);
  }
  function login(email, pw) {
    email = (email || '').trim().toLowerCase();
    var c = client(); if (!c) return Promise.resolve({ ok: false, error: authProblem() });
    return c.auth.signInWithPassword({ email: email, password: pw || '' }).then(function (r) {
      if (r.error) return { ok: false, error: authError(r.error) };
      if (!r.data || !r.data.user) return { ok: false, error: 'Anmeldung fehlgeschlagen.' };
      return { ok: true, user: cacheProfile(r.data.user) };
    }).catch(netError);
  }
  function logout() {
    C.me = null; C.bookings = []; C.addr = {}; C.contacts = {};
    var c = client();
    return c ? c.auth.signOut().catch(function () { /* egal */ }) : Promise.resolve();
  }
  function requireLogin() {
    if (me()) return true;
    var here = location.pathname.split('/').pop() + location.search + location.hash;
    location.replace('login.html?next=' + encodeURIComponent(here));
    return false;
  }
  function safeNext(n) {
    return /^[a-z0-9\-]+\.html(\?[A-Za-z0-9=&_\-%.]*)?(#[\w\-]*)?$/i.test(n || '') ? n : 'index.html';
  }

  /* ---------- Angebote ---------- */
  function validItem(o) {
    if (!o.name || o.name.trim().length < 2) return 'Bitte gib eine Bezeichnung an.';
    if (CATS.indexOf(o.cat) === -1) return 'Bitte wähle eine Kategorie.';
    if (!/^\d{5}$/.test((o.plz || '').trim())) return 'Bitte gib eine gültige Postleitzahl mit 5 Ziffern an.';
    if (!o.ort || o.ort.trim().length < 2) return 'Bitte gib den Ort an, wo das Gerät abgeholt wird.';
    if (!(+o.price >= 1 && +o.price <= 500)) return 'Der Tagespreis muss zwischen 1 und 500 Euro liegen.';
    if (!(+o.dep >= 0 && +o.dep <= 2000)) return 'Die Kaution muss zwischen 0 und 2.000 Euro liegen.';
    if ((o.street || '').trim().length > 60) return 'Die Straße darf höchstens 60 Zeichen lang sein.';
    if ((o.desc || '').trim().length > 300) return 'Die Beschreibung darf höchstens 300 Zeichen lang sein.';
    return null;
  }
  function itemRow(o) {
    return { name: o.name.trim(), cat: o.cat, plz: o.plz.trim(), ort: o.ort.trim(), price: +o.price, dep: +o.dep, descr: (o.desc || '').trim() };
  }
  function saveStreet(c, itemId, street) {
    street = (street || '').trim();
    if (street) return run(c.from('item_addresses').upsert({ item_id: itemId, street: street }));
    return run(c.from('item_addresses').delete().eq('item_id', itemId));
  }
  function addItem(o) {
    var u = me(); if (!u) return Promise.resolve({ ok: false, error: 'Bitte melde dich an.' });
    var err = validItem(o); if (err) return Promise.resolve({ ok: false, error: err });
    var c = client(); if (!c) return Promise.resolve({ ok: false, error: authProblem() });
    return run(c.from('items').insert(itemRow(o)).select().single()).then(function (r) {
      if (r.error) return failed(r.error);
      var id = r.data.id;
      return saveStreet(c, id, o.street).then(function (a) {
        return loadAll().then(function () { return a.error ? { ok: true, item: item(id), warn: dbError(a.error) } : { ok: true, item: item(id) }; });
      });
    });
  }
  function updateItem(id, o) {
    var u = me(), it = item(id);
    if (!u || !it || it.ownerId !== u.id) return Promise.resolve({ ok: false, error: 'Du darfst dieses Angebot nicht ändern.' });
    var err = validItem(o); if (err) return Promise.resolve({ ok: false, error: err });
    var c = client(); if (!c) return Promise.resolve({ ok: false, error: authProblem() });
    return run(c.from('items').update(itemRow(o)).eq('id', id).select().single()).then(function (r) {
      if (r.error) return failed(r.error);
      return saveStreet(c, id, o.street).then(function () {
        return loadAll().then(function () { return { ok: true, item: item(id) }; });
      });
    });
  }
  function deleteItem(id) {
    var u = me(), it = item(id);
    if (!u || !it || it.ownerId !== u.id) return Promise.resolve({ ok: false, error: 'Du darfst dieses Angebot nicht löschen.' });
    var active = C.bookings.some(function (b) { return b.itemId === id && (b.status === 'angefragt' || b.status === 'bestaetigt'); });
    if (active) return Promise.resolve({ ok: false, error: 'Es gibt noch offene oder bestätigte Buchungen. Bitte bearbeite diese zuerst.' });
    var c = client(); if (!c) return Promise.resolve({ ok: false, error: authProblem() });
    return run(c.from('items').delete().eq('id', id)).then(function (r) {
      if (r.error) return failed(r.error);
      return loadAll().then(function () { return { ok: true }; });
    });
  }

  /* Straße ist nur für den Vermieter und für Mieter mit bestätigter Buchung sichtbar (die Datenbank liefert sie sonst gar nicht aus) */
  function canSeeAddress(it) {
    var u = me(); if (!u || !it) return false;
    if (it.ownerId === u.id) return true;
    return C.bookings.some(function (b) { return b.itemId === it.id && b.renterId === u.id && (b.status === 'bestaetigt' || b.status === 'zurueck'); });
  }

  /* ---------- Buchungen ---------- */
  function book(o) {
    var u = me(); if (!u) return Promise.resolve({ ok: false, error: 'Bitte melde dich an.' });
    var it = item(o.itemId); if (!it) return Promise.resolve({ ok: false, error: 'Angebot nicht gefunden.' });
    if (it.ownerId === u.id) return Promise.resolve({ ok: false, error: 'Du kannst dein eigenes Angebot nicht mieten.' });
    var cc = calc(it, o.start, o.end, o.ins);
    if (!cc) return Promise.resolve({ ok: false, error: 'Das Rückgabedatum liegt vor dem Abholdatum.' });
    if (o.start < iso(new Date())) return Promise.resolve({ ok: false, error: 'Die Abholung darf nicht in der Vergangenheit liegen.' });
    if (cc.days > 30) return Promise.resolve({ ok: false, error: 'Die maximale Mietdauer beträgt 30 Tage.' });
    if (overlap(it.id, o.start, o.end, ['bestaetigt']).length) return Promise.resolve({ ok: false, error: 'In diesem Zeitraum ist das Gerät bereits vergeben.' });
    var c = client(); if (!c) return Promise.resolve({ ok: false, error: authProblem() });
    /* Preise und Gebühren berechnet die Datenbank selbst, hier werden nur Wunschdaten gesendet */
    return run(c.from('bookings').insert({ item_id: it.id, start_date: o.start, end_date: o.end, ins: !!o.ins, msg: (o.msg || '').trim().slice(0, 500) }).select().single()).then(function (r) {
      if (r.error) return failed(r.error);
      var id = r.data.id;
      return loadAll().then(function () { return { ok: true, booking: booking(id) || mapBooking(r.data) }; });
    });
  }

  function setStatus(id, status) {
    var u = me(); if (!u) return Promise.resolve({ ok: false, error: 'Bitte melde dich an.' });
    var b = booking(id); if (!b) return Promise.resolve({ ok: false, error: 'Buchung nicht gefunden.' });
    var declined = 0;
    if (status === 'bestaetigt') {
      if (overlap(b.itemId, b.start, b.end, ['bestaetigt'], b.id).length) return Promise.resolve({ ok: false, error: 'Der Zeitraum überschneidet sich mit einer bestätigten Buchung.' });
      C.bookings.forEach(function (o) { if (o.id !== b.id && o.itemId === b.itemId && o.status === 'angefragt' && o.start <= b.end && b.start <= o.end) declined++; });
    }
    var c = client(); if (!c) return Promise.resolve({ ok: false, error: authProblem() });
    return run(c.from('bookings').update({ status: status }).eq('id', id).select().single()).then(function (r) {
      if (r.error) return failed(r.error);
      return loadAll().then(function () { return { ok: true, booking: booking(id), declined: declined }; });
    });
  }

  function sendRating(id, patch, stars) {
    stars = +stars; if (!(stars >= 1 && stars <= 5)) return Promise.resolve({ ok: false, error: 'Bitte wähle 1 bis 5 Sterne.' });
    var c = client(); if (!c) return Promise.resolve({ ok: false, error: authProblem() });
    return run(c.from('bookings').update(patch).eq('id', id).select().single()).then(function (r) {
      if (r.error) return failed(r.error);
      return loadAll().then(function () { return { ok: true }; });
    });
  }
  function rate(id, stars, review) {
    var u = me(), b = booking(id);
    if (!u || !b || b.renterId !== u.id || b.status !== 'zurueck' || b.rating) return Promise.resolve({ ok: false, error: 'Bewertung nicht möglich.' });
    return sendRating(id, { rating: +stars, review: (review || '').trim().slice(0, 300) }, stars);
  }
  /* Vermieter bewertet den Mieter nach der Rückgabe */
  function rateRenter(id, stars, review) {
    var u = me(), b = booking(id);
    if (!u || !b || b.ownerId !== u.id || b.status !== 'zurueck' || b.ownerRating) return Promise.resolve({ ok: false, error: 'Bewertung nicht möglich.' });
    return sendRating(id, { owner_rating: +stars, owner_review: (review || '').trim().slice(0, 300) }, stars);
  }

  /* Durchschnitt eines Nutzers: role 'owner' = Bewertungen als Vermieter, 'renter' = als Mieter */
  function userRating(userId, role) {
    var r = C.userR[userId]; if (!r) return { avg: 0, n: 0 };
    return role === 'owner' ? { avg: num(r.owner_avg), n: num(r.owner_n) } : { avg: num(r.renter_avg), n: num(r.renter_n) };
  }

  /* Verteilung der Sterne eines Angebots (nach loadItemExtras) */
  function ratingBreakdown(it) {
    var counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, total = 0;
    reviews(it.id).forEach(function (r) { if (counts[r.rating] !== undefined) { counts[r.rating]++; total++; } });
    return { counts: counts, total: total };
  }
  function starsText(n) { n = Math.round(n); return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n); }
  function rateFormHtml(id, act, label) {
    return '<div class="rate-form" data-id="' + esc(id) + '"><select class="field" aria-label="Sterne"><option value="5">★★★★★ (5)</option><option value="4">★★★★ (4)</option><option value="3">★★★ (3)</option><option value="2">★★ (2)</option><option value="1">★ (1)</option></select>' +
      '<input class="field" maxlength="300" placeholder="Kurzer Kommentar (optional)" aria-label="Kommentar"><button type="button" class="btn small" data-act="' + act + '">' + label + '</button></div>';
  }

/* ---------- Nachrichten pro Buchung ---------- */
  var openThreads = {}, pollTimer = null;
  function canChat(b) { return !!(b && b.ownerId && b.renterId && (b.status === 'angefragt' || b.status === 'bestaetigt' || b.status === 'zurueck')); }
  function loadMessages(id) {
    var c = client(); if (!c) return Promise.resolve([]);
    return run(c.from('messages').select('*').eq('booking_id', id).order('created_at', { ascending: true })).then(function (r) {
      return (r.data || []).map(function (m) { return { id: m.id, senderId: m.sender_id, body: m.body, created: ts(m.created_at) }; });
    });
  }
  function sendMessage(id, body) {
    body = (body || '').trim();
    if (!body) return Promise.resolve({ ok: false, error: 'Bitte schreibe eine Nachricht.' });
    if (body.length > 1000) return Promise.resolve({ ok: false, error: 'Die Nachricht darf höchstens 1.000 Zeichen lang sein.' });
    var c = client(); if (!c) return Promise.resolve({ ok: false, error: authProblem() });
    return run(c.from('messages').insert({ booking_id: id, body: body })).then(function (r) { return r.error ? failed(r.error) : { ok: true }; });
  }
  function msgButton(b) {
    if (!canChat(b)) return '';
    return '<button type="button" class="btn ghost small" data-msg="' + esc(b.id) + '" aria-expanded="' + (!!openThreads[b.id]) + '">Nachrichten</button>';
  }
  function threadHtml(b) {
    if (!canChat(b)) return '';
    return '<div class="thread" data-thread="' + esc(b.id) + '"' + (openThreads[b.id] ? '' : ' hidden') + '></div>';
  }
  function fmtTime(t) { return new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  function renderMsgs(el, list) {
    var u = me(), box = el.querySelector('.thread-msgs'); if (!box) return;
    var atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = list.length ? list.map(function (m) {
      var mine = u && m.senderId === u.id;
      return '<div class="msg-row' + (mine ? ' mine' : '') + '"><div class="bubble">' + esc(m.body).replace(/\n/g, '<br>') + '</div><small>' + (mine ? 'Du' : esc(userName(m.senderId))) + ' · ' + fmtTime(m.created) + '</small></div>';
    }).join('') : '<p class="note">Noch keine Nachrichten. Schreibe zum Beispiel, wann die Abholung passt.</p>';
    if (atEnd) box.scrollTop = box.scrollHeight;
  }
  function fillThread(el) {
    var id = el.getAttribute('data-thread');
    if (!el.firstChild) {
      el.innerHTML = '<div class="thread-msgs" aria-live="polite"></div><form class="thread-form"><textarea class="field" maxlength="1000" rows="2" placeholder="Nachricht schreiben" aria-label="Nachricht"></textarea><button type="submit" class="btn small">Senden</button></form><p class="err" role="alert"></p>';
    }
    return loadMessages(id).then(function (l) { renderMsgs(el, l); });
  }
  /* Nach jedem Neuzeichnen der Liste aufrufen: lädt die geöffneten Unterhaltungen */
  function hydrateThreads(root) {
    [].forEach.call(root.querySelectorAll('[data-thread]'), function (el) { if (openThreads[el.getAttribute('data-thread')]) fillThread(el); });
  }
  function bindThreads(root) {
    if (root.__threads) return; root.__threads = true;
    root.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-msg]'); if (!btn) return;
      var id = btn.getAttribute('data-msg'), el = root.querySelector('[data-thread="' + id + '"]'); if (!el) return;
      openThreads[id] = !openThreads[id]; el.hidden = !openThreads[id]; btn.setAttribute('aria-expanded', String(!!openThreads[id]));
      if (openThreads[id]) fillThread(el).then(function () { var t = el.querySelector('textarea'); if (t) t.focus(); });
    });
    root.addEventListener('submit', function (e) {
      var f = e.target.closest('.thread-form'); if (!f) return;
      e.preventDefault();
      var el = f.closest('[data-thread]'), ta = f.querySelector('textarea'), err = el.querySelector('.err'), btn = f.querySelector('button');
      err.textContent = ''; btn.disabled = true;
      sendMessage(el.getAttribute('data-thread'), ta.value).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { err.textContent = r.error; return; }
        ta.value = ''; fillThread(el).then(function () { var m = el.querySelector('.thread-msgs'); m.scrollTop = m.scrollHeight; });
      });
    });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('.thread-form textarea')) { e.preventDefault(); e.target.closest('form').requestSubmit(); }
    });
    if (!pollTimer) pollTimer = setInterval(function () {
      if (document.hidden) return;
      [].forEach.call(root.querySelectorAll('[data-thread]'), function (el) {
        if (openThreads[el.getAttribute('data-thread')] && el.firstChild && !el.contains(document.activeElement)) fillThread(el);
      });
    }, 20000);
  }

  /* ---------- Konto ---------- */
  function updateName(name) {
    name = (name || '').trim();
    if (name.length < 2 || name.length > 40) return Promise.resolve({ ok: false, error: 'Der Name muss 2 bis 40 Zeichen lang sein.' });
    var c = client(), u = me(); if (!c || !u) return Promise.resolve({ ok: false, error: 'Bitte melde dich an.' });
    return run(c.auth.updateUser({ data: { name: name } })).then(function (r) {
      if (r.error) return { ok: false, error: authError(r.error) };
      return run(c.from('profiles').update({ name: name }).eq('id', u.id)).then(function (p) {
        if (p.error) return failed(p.error);
        u.name = name; C.profiles[u.id] = { id: u.id, name: name };
        return { ok: true };
      });
    });
  }
  function updatePassword(pw) {
    if ((pw || '').length < 8) return Promise.resolve({ ok: false, error: 'Das Passwort braucht mindestens 8 Zeichen.' });
    var c = client(); if (!c || !me()) return Promise.resolve({ ok: false, error: 'Bitte melde dich an.' });
    return run(c.auth.updateUser({ password: pw })).then(function (r) { return r.error ? { ok: false, error: authError(r.error) } : { ok: true }; });
  }
  function resetPassword(email) {
    email = (email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return Promise.resolve({ ok: false, error: 'Bitte gib eine gültige E-Mail-Adresse an.' });
    var c = client(); if (!c) return Promise.resolve({ ok: false, error: authProblem() });
    var opts = {};
    if (/^https?:$/.test(location.protocol)) opts.redirectTo = location.origin + location.pathname.replace(/[^\/]*$/, '') + 'passwort-neu.html';
    return run(c.auth.resetPasswordForEmail(email, opts)).then(function (r) { return r.error ? { ok: false, error: authError(r.error) } : { ok: true }; });
  }
  function deleteAccount() {
    var c = client(); if (!c || !me()) return Promise.resolve({ ok: false, error: 'Bitte melde dich an.' });
    return run(c.functions.invoke('delete-account', { method: 'POST' })).then(function (r) {
      if (r.error) {
        var ctx = r.error.context;
        if (ctx && typeof ctx.json === 'function') return ctx.json().then(function (j) { return { ok: false, error: (j && j.error) || 'Das Konto konnte nicht gelöscht werden.' }; }, function () { return { ok: false, error: 'Das Konto konnte nicht gelöscht werden.' }; });
        return { ok: false, error: /network|fetch/i.test(String(r.error.message)) ? 'Keine Verbindung zu Supabase. Bitte prüfe deine Internetverbindung.' : 'Das Konto konnte nicht gelöscht werden.' };
      }
      if (r.data && r.data.error) return { ok: false, error: r.data.error };
      C.me = null; C.bookings = [];
      return run(c.auth.signOut()).then(function () { return { ok: true }; });
    });
  }

  /* ---------- Start ---------- */
  function start() {
    try { ['mm_users', 'mm_items', 'mm_bookings', 'mm_session', 'mm_seeded_v1', 'mm_clean_v3'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { /* egal */ }
    return syncSession().then(loadAll).then(function () { if (C.loadError) toast(C.loadError); });
  }

  /* ---------- Kopf- und Fußzeile ---------- */
  function renderHeader(active) {
    var u = me(), h = document.getElementById('siteHeader'), f = document.getElementById('siteFooter');
    if (h) {
      var open = u ? bookings().filter(function (b) { return b.ownerId === u.id && b.status === 'angefragt'; }).length : 0;
      var links = [['home', 'index.html', 'Angebote'], ['how', 'index.html#ablauf', 'So geht’s'], ['rent', 'vermieten.html', 'Vermieten']];
      if (u) {
        links.push(['trips', 'meine-mietungen.html', 'Meine Mietungen']);
        links.push(['mine', 'meine-angebote.html', 'Meine Angebote' + (open ? '<span class="nav-badge" title="Offene Anfragen">' + open + '</span>' : '')]);
      }
      h.innerHTML = '<a class="logo" href="index.html"><span class="logo-mark" aria-hidden="true">M</span>Mietmeister</a>' +
        '<nav aria-label="Hauptmenü">' + links.map(function (l) {
          return '<a href="' + l[1] + '"' + (active === l[0] ? ' aria-current="page"' : '') + '>' + l[2] + '</a>';
        }).join('') + '</nav>' +
        '<div class="hdr-r">' + (u
          ? '<a class="avatar" href="profil.html" title="Profil von ' + esc(u.name) + '" aria-label="Mein Profil">' + esc(u.name.charAt(0).toUpperCase()) + '</a><button type="button" class="btn ghost small" id="logoutBtn">Abmelden</button>'
          : '<a class="btn ghost small" href="login.html#registrieren">Registrieren</a><a class="btn small" href="login.html">Anmelden</a>') + '</div>';
      var lb = document.getElementById('logoutBtn');
      if (lb) lb.addEventListener('click', function () { logout().then(function () { location.href = 'index.html'; }); });
    }
    if (f) f.innerHTML = '<p>Prototyp ohne echte Zahlungen. Gebühren im Modell: 8 % Servicegebühr für Mieter, 10 % Provision für Vermieter, optionaler Schutz für 2 € pro Tag.</p>' +
      '<nav class="foot-links" aria-label="Rechtliches"><a href="impressum.html">Impressum</a><a href="datenschutz.html">Datenschutz</a><a href="agb.html">AGB</a></nav>';
  }

  window.MM = {
    CATS: CATS, STATUS: STATUS, ICONS: ICONS, catIdx: catIdx, regionOf: regionOf, canSeeAddress: canSeeAddress,
    ready: start(),
    esc: esc, eur: eur, eur0: eur0, iso: iso, addDays: addDays, fmtDate: fmtDate, km: km, num1: num1, plural: plural, toast: toast,
    me: me, userById: userById, userName: userName, register: register, login: login, logout: logout, requireLogin: requireLogin, safeNext: safeNext,
    items: items, item: item, booking: booking, loadItemExtras: loadItemExtras, occupancy: occupancy, reviews: reviews, addItem: addItem, updateItem: updateItem, deleteItem: deleteItem, ratingOf: ratingOf,
    bookings: bookings, calc: calc, overlap: overlap, book: book, setStatus: setStatus, rate: rate, rateRenter: rateRenter, userRating: userRating, ratingBreakdown: ratingBreakdown, starsText: starsText, rateFormHtml: rateFormHtml,
    renderHeader: renderHeader, authProblem: authProblem,
    msgButton: msgButton, threadHtml: threadHtml, bindThreads: bindThreads, hydrateThreads: hydrateThreads, updateName: updateName, updatePassword: updatePassword, resetPassword: resetPassword, deleteAccount: deleteAccount
  };
})();
