// Field Twin Violet v1
// RED PHONE: phone app for field-twin-violet-api. Built by Claude Code in the cloud session for Red Phone.
// RED PHONE: offline first. Every save goes into an IndexedDB queue on the phone and syncs to Supabase when signal returns.
// RED PHONE: counts are never typed in. Who holds what is worked out from the append only event log.
(() => {
  "use strict";

  const SUPABASE_URL = "https://zasyjjoypkpvyqdueums.supabase.co";
  const SUPABASE_KEY = "sb_publishable_iFsIWHo1XN6bO6S5z5vJEg_k6IRq94z";
  const BUCKET = "violet-photos";
  const LOW_CONFIDENCE = 0.8;
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  const TYPES = {
    received: "Received",
    moved: "Moved",
    installed: "Installed",
    pulled: "Pulled failed",
    returned: "Returned",
    written_off: "Written off",
  };
  const HOLDER_KINDS = { tech: "Tech", truck: "Truck", home: "Home stock", return: "Return shipment", other: "Other" };
  const ITEM_KINDS = { part: "Part", tool: "Tool", consumable: "Consumable" };
  const CONDITIONS = { good: "Good", damaged: "Damaged", failed: "Failed" };
  const SYMPTOMS = [
    "Dead, no power", "Intermittent", "Will not latch or unlatch", "Door sensor fault", "Display fault",
    "Touch not responding", "Scanner not reading", "Network or communication fault", "Physical damage",
    "Water or corrosion", "Burnt or overheated", "Noise or grinding", "Other",
  ];
  const CAUSES = [
    "Unknown", "Wear", "Power surge or bad power", "Heat", "Water or moisture", "Impact or abuse",
    "Manufacturing defect", "Installation error", "Firmware or software", "Other",
  ];

  // ---------- small helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (v) =>
    String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const uuid = () => crypto.randomUUID();
  const nowIso = () => new Date().toISOString();
  const norm = (s) => String(s || "").trim().toUpperCase();
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const localInput = (iso) => {
    const d = iso ? new Date(iso) : new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $("#toast");
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.display = "none"), ms);
  }

  // ---------- IndexedDB: queue of unsynced saves plus a cache of the last pull ----------
  const idb = (() => {
    let dbp;
    const open = () =>
      (dbp ||= new Promise((res, rej) => {
        const r = indexedDB.open("field-twin-violet", 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore("queue", { keyPath: "qid" });
          r.result.createObjectStore("kv");
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }));
    async function run(store, mode, fn) {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => res(req ? req.result : undefined);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    }
    return {
      get: (k) => run("kv", "readonly", (s) => s.get(k)),
      set: (k, v) => run("kv", "readwrite", (s) => s.put(v, k)),
      queueAll: () => run("queue", "readonly", (s) => s.getAll()),
      queuePut: (op) => run("queue", "readwrite", (s) => s.put(op)),
      queueDel: (qid) => run("queue", "readwrite", (s) => s.delete(qid)),
    };
  })();

  let qCounter = 0;
  const newQid = () => `${String(Date.now()).padStart(15, "0")}-${String(qCounter++).padStart(4, "0")}`;

  // ---------- state ----------
  const S = {
    user: null,
    demo: false,
    demoData: null,
    server: { violet_holders: [], violet_catalog: [], violet_events: [] },
    queue: [],
    tab: "stock",
    holderFilter: "",
    stockSearch: "",
    historySearch: "",
    historyLimit: 100,
    syncing: false,
    syncError: "",
    lastSync: "",
    settings: { api: "", token: "" },
    localPhotos: {},
    signedUrls: {},
    log: null,
  };

  function uid() {
    return S.demo ? "demo" : S.user && S.user.id;
  }

  function rows(table) {
    if (S.demo) return S.demoData[table];
    const byId = new Map(S.server[table].map((r) => [r.id, r]));
    for (const op of S.queue) if (op.table === table) byId.set(op.row.id, { ...op.row, _pending: true });
    return [...byId.values()];
  }
  const holders = () => rows("violet_holders").slice().sort((a, b) => a.name.localeCompare(b.name));
  const catalog = () => rows("violet_catalog");
  const events = () => rows("violet_events");
  const holderName = (id) => {
    const h = rows("violet_holders").find((x) => x.id === id);
    return h ? h.name : id ? "unknown holder" : "";
  };
  const catalogById = (id) => rows("violet_catalog").find((c) => c.id === id);
  const partLabel = (c) => (c ? [c.name, c.part_number].filter(Boolean).join(" · ") || "Unnamed part" : "Unknown part");

  // ---------- derive holdings and conflicts from the log ----------
  // Server timestamps and phone timestamps are formatted differently, so compare them as times, not text.
  const ms = (iso) => Date.parse(iso) || 0;
  function sortEvents(a, b) {
    return ms(a.happened_at) - ms(b.happened_at) || ms(a.created_at) - ms(b.created_at);
  }

  function derive() {
    const ev = events().slice().sort(sortEvents);
    const serials = new Map();
    const qty = new Map();
    const conflicts = [];
    const flag = (e, text) => conflicts.push({ event: e, text });
    for (const e of ev) {
      if (e.serial) {
        const key = norm(e.serial);
        const prev = serials.get(key);
        const where = prev ? prev.where : "";
        const at = prev ? (prev.where === "holder" ? holderName(prev.holder) : prev.where === "locker" ? `locker ${prev.locker_id || "?"}` : prev.where) : "";
        if (e.type === "received" && (where === "holder" || where === "locker")) {
          flag(e, `Serial ${e.serial} received by ${holderName(e.to_holder)} but already with ${at}`);
        } else if (e.type === "pulled") {
          if (where === "holder") flag(e, `Serial ${e.serial} pulled from a locker but last seen with ${at}`);
          else if (where === "locker" && prev.locker_id && e.locker_id && norm(prev.locker_id) !== norm(e.locker_id))
            flag(e, `Serial ${e.serial} pulled from locker ${e.locker_id} but was installed at locker ${prev.locker_id}`);
        } else if (["moved", "installed", "returned", "written_off"].includes(e.type)) {
          if (e.type === "installed" && where === "locker") flag(e, `Serial ${e.serial} installed twice, already at ${at}`);
          else if (where === "holder" && e.from_holder && prev.holder !== e.from_holder)
            flag(e, `Serial ${e.serial} logged from ${holderName(e.from_holder)} but last seen with ${at}`);
          else if (where === "locker" && e.type !== "installed") flag(e, `Serial ${e.serial} logged from a holder but is installed at ${at}`);
          else if (where === "written off") flag(e, `Serial ${e.serial} was already written off`);
        }
        const st = { serial: e.serial, catalog_id: e.catalog_id, last: e, holder: "", locker_id: "", site: "", where: "unknown" };
        if (e.type === "installed") Object.assign(st, { where: "locker", locker_id: e.locker_id, site: e.site });
        else if (e.type === "written_off") st.where = "written off";
        else if (e.to_holder) Object.assign(st, { where: "holder", holder: e.to_holder });
        else if (e.type === "returned") st.where = "returned";
        serials.set(key, st);
      } else {
        const n = Number(e.qty) || 0;
        const add = (h, d) => {
          if (!h) return;
          const k = h + "|" + e.catalog_id;
          qty.set(k, (qty.get(k) || 0) + d);
        };
        add(e.from_holder, -n);
        add(e.to_holder, n);
      }
    }
    const byHolder = new Map();
    const push = (h, item) => {
      if (!byHolder.has(h)) byHolder.set(h, []);
      byHolder.get(h).push(item);
    };
    for (const st of serials.values()) if (st.where === "holder") push(st.holder, { kind: "serial", catalog_id: st.catalog_id, serial: st.serial, qty: 1, last: st.last });
    for (const [k, n] of qty) {
      if (Math.abs(n) < 1e-9) continue;
      const [h, c] = k.split("|");
      push(h, { kind: "qty", catalog_id: c, qty: n });
    }
    const lockers = [...serials.values()].filter((s) => s.where === "locker");
    return { serials, byHolder, lockers, conflicts };
  }

  // ---------- Supabase pull and sync ----------
  async function fetchAll(table) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select("*").range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }

  async function pull() {
    if (S.demo || !S.user || !navigator.onLine) return;
    const [h, c, e] = await Promise.all(["violet_holders", "violet_catalog", "violet_events"].map(fetchAll));
    S.server = { violet_holders: h, violet_catalog: c, violet_events: e };
    S.lastSync = nowIso();
    await idb.set("data:" + S.user.id, { server: S.server, lastSync: S.lastSync });
  }

  async function loadQueue() {
    S.queue = (await idb.queueAll()).filter((op) => op.owner === uid());
    for (const op of S.queue)
      for (const p of op.photos || []) if (!S.localPhotos[p.path]) S.localPhotos[p.path] = URL.createObjectURL(p.blob);
  }

  async function sync() {
    if (S.demo || !S.user || S.syncing) return;
    if (!navigator.onLine) return renderStatus();
    S.syncing = true;
    S.syncError = "";
    renderStatus();
    try {
      const ops = (await idb.queueAll()).filter((op) => op.owner === S.user.id);
      for (const op of ops) {
        for (const p of op.photos || []) {
          const { error } = await sb.storage.from(BUCKET).upload(p.path, p.blob, { contentType: "image/jpeg", upsert: true });
          if (error) throw new Error("photo upload: " + error.message);
        }
        const { error } = await sb.from(op.table).upsert(op.row);
        if (error) throw new Error(error.message);
        await idb.queueDel(op.qid);
      }
      await pull();
    } catch (err) {
      S.syncError = err.message || String(err);
    } finally {
      S.syncing = false;
      await loadQueue();
      render();
    }
  }

  async function enqueue(table, row, photos = []) {
    if (S.demo) {
      const list = S.demoData[table];
      const i = list.findIndex((r) => r.id === row.id);
      if (i >= 0) list[i] = row;
      else list.push(row);
      for (const p of photos) S.localPhotos[p.path] = URL.createObjectURL(p.blob);
      return;
    }
    const op = { qid: newQid(), owner: S.user.id, table, row, photos };
    await idb.queuePut(op);
    S.queue.push(op);
    for (const p of photos) S.localPhotos[p.path] = URL.createObjectURL(p.blob);
  }

  // ---------- photos ----------
  async function hydratePhotos(root = document) {
    const imgs = [...root.querySelectorAll("img[data-photo]")];
    const need = [];
    for (const img of imgs) {
      const p = img.dataset.photo;
      const src = S.localPhotos[p] || (S.signedUrls[p] && S.signedUrls[p].exp > Date.now() ? S.signedUrls[p].url : "");
      if (src) img.src = src;
      else if (!need.includes(p)) need.push(p);
    }
    if (!need.length || S.demo || !navigator.onLine) return;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
    if (error || !data) return;
    for (const d of data) if (d.signedUrl) S.signedUrls[d.path] = { url: d.signedUrl, exp: Date.now() + 3500e3 };
    for (const img of imgs) {
      const s = S.signedUrls[img.dataset.photo];
      if (s && !img.src) img.src = s.url;
    }
  }

  function fileToImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("could not open that photo"));
      img.src = url;
    });
  }

  function drawScaled(img, max) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  // Redrawing on a canvas drops every EXIF field, including GPS location.
  const canvasBlob = (c, q) => new Promise((res) => c.toBlob(res, "image/jpeg", q));

  function readBarcodes(canvas) {
    const Z = window.ZXing;
    if (!Z) return [];
    const hints = new Map();
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    const reader = new Z.MultiFormatReader();
    reader.setHints(hints);
    const found = new Set();
    const tryCanvas = (c) => {
      try {
        const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c)));
        const r = reader.decode(bmp);
        if (r && r.getText()) found.add(r.getText().trim());
      } catch (e) { /* nothing found in this pass */ }
      reader.reset();
    };
    const crop = (src, x, y, w, h, scale, rotate) => {
      const c = document.createElement("canvas");
      c.width = Math.round((rotate ? h : w) * scale);
      c.height = Math.round((rotate ? w : h) * scale);
      const g = c.getContext("2d");
      if (rotate) {
        g.translate(c.width, 0);
        g.rotate(Math.PI / 2);
      }
      g.drawImage(src, x, y, w, h, 0, 0, rotate ? c.height : c.width, rotate ? c.width : c.height);
      return c;
    };
    const W = canvas.width, H = canvas.height;
    tryCanvas(canvas);
    tryCanvas(crop(canvas, 0, 0, W, H, 1, true));
    tryCanvas(crop(canvas, W * 0.2, H * 0.2, W * 0.6, H * 0.6, 1.6, false));
    tryCanvas(crop(canvas, W * 0.2, H * 0.2, W * 0.6, H * 0.6, 1.6, true));
    return [...found];
  }

  // ---------- render ----------
  function renderStatus() {
    const el = $("#status");
    if (!S.user && !S.demo) return (el.innerHTML = "");
    const bits = [];
    if (S.demo) bits.push('<span class="pill demo">Demo data</span>');
    if (!navigator.onLine) bits.push('<span class="pill off">Offline</span>');
    if (!S.demo && S.queue.length) bits.push(`<span class="pill">${S.queue.length} waiting</span>`);
    if (S.syncing) bits.push('<span class="pill">Syncing</span>');
    else if (S.syncError) bits.push('<span class="pill off">Sync error</span>');
    el.innerHTML = bits.join(" ");
  }

  function render() {
    renderStatus();
    const signedIn = S.user || S.demo;
    $("#nav").hidden = !signedIn;
    if (!signedIn) return renderLogin();
    for (const b of document.querySelectorAll("nav button")) b.classList.toggle("on", b.dataset.tab === S.tab);
    const view = { stock: renderStock, log: renderLog, history: renderHistory, failures: renderFailures, more: renderMore }[S.tab];
    $("#app").innerHTML = view();
    hydratePhotos($("#app"));
  }

  function renderLogin(err = "") {
    $("#app").innerHTML = `
      <div class="login card">
        <h2>Sign in</h2>
        <form id="loginForm">
          <label>Email</label><input name="email" type="email" autocomplete="username" required>
          <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
          ${err ? `<p class="err">${esc(err)}</p>` : ""}
          <button class="btn primary wide" type="submit">Sign in</button>
        </form>
        <button class="btn wide" data-act="demo-on">Look around with demo data</button>
        <p class="muted">Demo data is invented and stays on this phone. Nothing in it touches real records.</p>
      </div>`;
  }

  // ----- Stock -----
  function renderStock() {
    const d = derive();
    const hs = holders();
    if (!hs.length)
      return `<div class="card"><h2>No holders yet</h2><p>Add a holder such as yourself, your truck, or home stock under More, then log parts as you receive them.</p><button class="btn primary" data-tab-go="more">Go to More</button></div>`;
    const q = norm(S.stockSearch);
    const match = (it) => {
      if (!q) return true;
      const c = catalogById(it.catalog_id) || {};
      return [c.name, c.part_number, c.model, it.serial].some((v) => norm(v).includes(q));
    };
    const tiles = hs.map((h) => {
      const items = d.byHolder.get(h.id) || [];
      const n = items.reduce((a, it) => a + it.qty, 0);
      return `<div class="tile tap ${S.holderFilter === h.id ? "on" : ""}" data-holder="${h.id}"><span class="muted">${esc(HOLDER_KINDS[h.kind] || h.kind)}</span><b>${fmtNum(n)}</b>${esc(h.name)}</div>`;
    });
    tiles.push(`<div class="tile tap ${S.holderFilter === "@lockers" ? "on" : ""}" data-holder="@lockers"><span class="muted">Installed</span><b>${d.lockers.length}</b>At lockers</div>`);
    let body = "";
    if (S.holderFilter === "@lockers") {
      const ls = d.lockers.filter((s) => match({ catalog_id: s.catalog_id, serial: s.serial }));
      body = `<h2>Installed at lockers</h2><div class="card list">${ls.map((s) => `<div class="tap" data-serial="${esc(s.serial)}"><b>${esc(partLabel(catalogById(s.catalog_id)))}</b><br><span class="muted">SN ${esc(s.serial)} · locker ${esc(s.locker_id)} · ${esc(s.site)}</span></div>`).join("") || '<div class="muted">Nothing installed yet</div>'}</div>`;
    } else {
      const show = S.holderFilter ? hs.filter((h) => h.id === S.holderFilter) : hs;
      body = show
        .map((h) => {
          const items = (d.byHolder.get(h.id) || []).filter(match).sort((a, b) => partLabel(catalogById(a.catalog_id)).localeCompare(partLabel(catalogById(b.catalog_id))));
          return `<h2>${esc(h.name)}</h2><div class="card list">${items.map(stockRow).join("") || '<div class="muted">Holds nothing</div>'}</div>`;
        })
        .join("");
    }
    const conflictCard = d.conflicts.length
      ? `<div class="card conflict tap" data-act="conflicts"><b>${d.conflicts.length} conflict${d.conflicts.length > 1 ? "s" : ""}</b><br><span class="muted">A serial showed up in two places or was installed twice. Tap to see them.</span></div>`
      : "";
    return `${conflictCard}<div class="tiles">${tiles.join("")}</div>
      <label>Search part, part number, or serial</label><input id="stockSearch" value="${esc(S.stockSearch)}" placeholder="Search">
      ${body}`;
  }

  function stockRow(it) {
    const c = catalogById(it.catalog_id);
    const photo = c && c.ref_photo ? `<img class="thumb" data-photo="${esc(c.ref_photo)}" alt="">` : "";
    if (it.kind === "serial")
      return `<div class="tap row" data-serial="${esc(it.serial)}" style="align-items:center">${photo ? `<div style="flex:0 0 72px">${photo}</div>` : ""}<div><b>${esc(partLabel(c))}</b><br><span class="muted">SN ${esc(it.serial)} · since ${esc(fmtDate(it.last.happened_at))}</span></div></div>`;
    return `<div class="row tap" data-catalog="${it.catalog_id}" style="align-items:center">${photo ? `<div style="flex:0 0 72px">${photo}</div>` : ""}<div><b>${esc(partLabel(c))}</b><br><span class="muted">${fmtNum(it.qty)} ${esc((c && c.unit) || "each")}${it.qty < 0 ? " · more logged out than in" : ""}</span></div></div>`;
  }

  const fmtNum = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

  // ----- Log -----
  function blankItem() {
    return { include: true, name: "", kind: "part", part_number: "", serial: "", manufacturer: "", model: "", quantity: 1, unit: "each", other_ids: [], confidence: null };
  }

  function newLog(type = "received") {
    return {
      type,
      photo: null,
      barcodes: [],
      extracted: null,
      status: "",
      error: "",
      busy: false,
      items: [],
      f: { from_holder: "", to_holder: "", locker_id: "", site: "", symptom: "", cause: "", condition: type === "pulled" ? "failed" : "good", note: "", happened_at: localInput() },
    };
  }

  function needs(type) {
    return {
      from: ["moved", "installed", "returned", "written_off"].includes(type),
      fromRequired: ["moved", "installed", "written_off", "returned"].includes(type),
      to: ["received", "moved", "pulled", "returned"].includes(type),
      toRequired: ["received", "moved", "pulled"].includes(type),
      locker: ["installed", "pulled"].includes(type),
      failure: type === "pulled",
    };
  }

  function holderOptions(sel, filterKinds) {
    const hs = holders().filter((h) => !filterKinds || filterKinds.includes(h.kind));
    return `<option value="">Choose</option>` + hs.map((h) => `<option value="${h.id}" ${sel === h.id ? "selected" : ""}>${esc(h.name)} (${esc(HOLDER_KINDS[h.kind] || h.kind)})</option>`).join("");
  }

  function renderLog() {
    if (!S.log) S.log = newLog();
    const L = S.log;
    if (!holders().length)
      return `<div class="card"><h2>Add a holder first</h2><p>Every part has to be held by someone or something. Add yourself, your truck, or home stock under More.</p><button class="btn primary" data-tab-go="more">Go to More</button></div>`;
    const n = needs(L.type);
    const apiReady = S.settings.api && S.settings.token;
    const typeBtns = Object.entries(TYPES).map(([k, v]) => `<button class="btn ${L.type === k ? "on" : ""}" data-logtype="${k}">${v}</button>`).join("");
    const items = L.items.map((it, i) => itemCard(it, i)).join("");
    const lockerIds = [...new Set(events().map((e) => e.locker_id).filter(Boolean))];
    const sites = [...new Set(events().map((e) => e.site).filter(Boolean))];
    return `
      <div class="types">${typeBtns}</div>
      <div class="card">
        <div class="row">
          <label class="btn primary" style="display:flex;align-items:center;justify-content:center;margin:0;font-size:16px">Take photo<input id="photoInput" type="file" accept="image/*" capture="environment" hidden></label>
          <button class="btn" data-act="add-item">Enter by hand</button>
        </div>
        ${apiReady ? "" : '<p class="muted">Label reading is off until the API address and token are set under More. Barcodes still read on the phone.</p>'}
        ${L.photo ? `<img class="preview" src="${L.photo.url}" alt="">` : ""}
        ${L.status ? `<p class="muted">${esc(L.status)}</p>` : ""}
        ${L.barcodes.length ? `<p class="muted">Barcodes read: ${L.barcodes.map(esc).join(", ")}</p>` : ""}
        ${L.extracted && L.extracted.notes ? `<p class="muted">Reader note: ${esc(L.extracted.notes)}</p>` : ""}
      </div>
      ${L.items.length ? `<h2>Check every field before saving</h2><p class="muted">Yellow fields were hard to read. One wrong serial corrupts that part's whole history.</p>${items}<button class="btn small" data-act="add-item">Add another item</button>` : ""}
      ${L.items.length ? `
      <div class="card">
        <h3>${esc(TYPES[L.type])}</h3>
        ${n.from ? `<label>From holder${n.fromRequired ? "" : " (optional)"}</label><select data-f="from_holder">${holderOptions(L.f.from_holder)}</select>` : ""}
        ${n.to ? `<label>${L.type === "pulled" ? "Failed part goes to" : L.type === "returned" ? "Return shipment (optional)" : "To holder"}</label><select data-f="to_holder">${holderOptions(L.f.to_holder, L.type === "returned" ? ["return"] : null)}</select>` : ""}
        ${n.locker ? `<div class="row"><div><label>Locker ID</label><input data-f="locker_id" list="lockerList" value="${esc(L.f.locker_id)}"></div><div><label>Site</label><input data-f="site" list="siteList" value="${esc(L.f.site)}"></div></div>
          <datalist id="lockerList">${lockerIds.map((v) => `<option value="${esc(v)}">`).join("")}</datalist><datalist id="siteList">${sites.map((v) => `<option value="${esc(v)}">`).join("")}</datalist>` : ""}
        ${n.failure ? `<label>Symptom</label><select data-f="symptom"><option value="">Choose</option>${SYMPTOMS.map((s) => `<option ${L.f.symptom === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
          <label>Suspected cause</label><select data-f="cause"><option value="">Choose</option>${CAUSES.map((s) => `<option ${L.f.cause === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>` : ""}
        <label>Condition</label><select data-f="condition">${Object.entries(CONDITIONS).map(([k, v]) => `<option value="${k}" ${L.f.condition === k ? "selected" : ""}>${v}</option>`).join("")}</select>
        <label>When</label><input type="datetime-local" data-f="happened_at" value="${esc(L.f.happened_at)}">
        <label>Note (optional)</label><textarea data-f="note">${esc(L.f.note)}</textarea>
        ${L.error ? `<p class="err">${esc(L.error)}</p>` : ""}
        <button class="btn primary wide" data-act="save-log" ${L.busy ? "disabled" : ""}>Confirm and save</button>
        <button class="btn wide" data-act="clear-log">Start over</button>
      </div>` : ""}`;
  }

  function itemCard(it, i) {
    const c = it.confidence;
    const cls = (k) => (c && c[k] !== undefined && c[k] < LOW_CONFIDENCE ? "low" : "");
    const conf = (k) => (c && c[k] !== undefined ? `<span class="conf ${cls(k)}"> read ${Math.round(c[k] * 100)}%</span>` : "");
    const field = (k, label, type = "text") =>
      `<div><label>${label}${conf(k)}</label><input class="${cls(k)}" data-item="${i}" data-k="${k}" type="${type}" value="${esc(it[k])}" ${type === "number" ? 'step="any" min="0"' : ""} ${k === "part_number" ? 'list="pnList"' : ""}></div>`;
    const pns = [...new Set(catalog().map((x) => x.part_number).filter(Boolean))];
    const codeBtns = S.log.barcodes
      .map((b) => `<div class="chips" style="margin-top:6px"><span class="muted">${esc(b)}</span><button class="btn small" data-code="${esc(b)}" data-into="serial" data-item="${i}">Use as serial</button><button class="btn small" data-code="${esc(b)}" data-into="part_number" data-item="${i}">Use as part number</button></div>`)
      .join("");
    return `<div class="card">
      <label class="check"><input type="checkbox" data-item="${i}" data-k="include" ${it.include ? "checked" : ""}> Include this item</label>
      ${field("name", "Name")}
      <div class="row">${field("part_number", "Part number")}<div><label>Kind</label><select data-item="${i}" data-k="kind">${Object.entries(ITEM_KINDS).map(([k, v]) => `<option value="${k}" ${it.kind === k ? "selected" : ""}>${v}</option>`).join("")}</select></div></div>
      ${field("serial", "Serial (leave empty if none)")}
      <div class="row">${field("quantity", "Quantity", "number")}${field("unit", "Unit")}</div>
      <div class="row">${field("manufacturer", "Maker")}${field("model", "Model")}</div>
      ${it.other_ids && it.other_ids.length ? `<p class="muted">Other numbers: ${it.other_ids.map((o) => esc(`${o.label} ${o.value}`)).join(", ")}</p>` : ""}
      ${codeBtns}
      <datalist id="pnList">${pns.map((v) => `<option value="${esc(v)}">`).join("")}</datalist>
    </div>`;
  }

  async function handlePhoto(file) {
    const L = S.log;
    L.error = "";
    L.status = "Preparing photo";
    render();
    try {
      const img = await fileToImage(file);
      const big = drawScaled(img, 1600);
      const blob = await canvasBlob(big, 0.85);
      if (L.photo) URL.revokeObjectURL(L.photo.url);
      L.photo = { blob, url: URL.createObjectURL(blob) };
      L.status = "Looking for a barcode";
      render();
      await new Promise((r) => setTimeout(r, 30));
      L.barcodes = readBarcodes(big);
      L.extracted = null;
      if (S.settings.api && S.settings.token && navigator.onLine) {
        L.status = "Reading the label";
        render();
        const small = drawScaled(img, 1280);
        const dataUrl = small.toDataURL("image/jpeg", 0.8);
        const r = await fetch(S.settings.api.replace(/\/+$/, "") + "/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + S.settings.token },
          body: JSON.stringify({ image: dataUrl, barcodes: L.barcodes }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `label reader answered ${r.status}`);
        L.extracted = j.result;
        L.items = (j.result.items || []).map((it) => ({ ...blankItem(), ...it, include: true }));
        L.status = j.result.items.length ? `Read ${j.result.items.length} item${j.result.items.length > 1 ? "s" : ""}${j.cached ? " (saved reading)" : ""}` : "Nothing readable on the label. Fill it in by hand.";
      } else {
        L.status = L.barcodes.length ? "Barcode read on the phone. Fill in the rest." : navigator.onLine ? "No barcode found. Fill it in by hand." : "Offline, so the label was not read. Fill it in by hand, the photo still saves.";
      }
      if (!L.items.length) {
        const it = blankItem();
        if (L.barcodes.length === 1) it.serial = L.barcodes[0];
        L.items.push(it);
      }
    } catch (err) {
      L.status = "";
      L.error = err.message;
      if (!L.items.length) L.items.push(blankItem());
    }
    render();
  }

  function findCatalog(it) {
    const pn = norm(it.part_number);
    const list = catalog();
    if (pn) return list.find((c) => norm(c.part_number) === pn);
    const nm = norm(it.name);
    return nm ? list.find((c) => !c.part_number && norm(c.name) === nm) : null;
  }

  async function saveLog() {
    const L = S.log;
    const n = needs(L.type);
    const f = L.f;
    const fail = (m) => {
      L.error = m;
      render();
    };
    const items = L.items.filter((it) => it.include);
    if (!items.length) return fail("Include at least one item.");
    for (const it of items) {
      if (!String(it.part_number).trim() && !String(it.name).trim()) return fail("Every item needs a part number or a name.");
      if (!(Number(it.quantity) > 0)) return fail("Quantity must be more than zero.");
      if (String(it.serial).trim() && Number(it.quantity) !== 1) return fail("An item with a serial must have quantity 1.");
    }
    if (n.fromRequired && !f.from_holder) return fail("Choose who it comes from.");
    if (n.toRequired && !f.to_holder) return fail("Choose who it goes to.");
    if (L.type === "moved" && f.from_holder === f.to_holder) return fail("From and to are the same holder.");
    if (n.locker && (!f.locker_id.trim() || !f.site.trim())) return fail("Locker ID and site are needed.");
    if (n.failure && !f.symptom) return fail("Choose a symptom.");
    const happened = new Date(f.happened_at);
    if (isNaN(happened)) return fail("The date is not valid.");

    L.busy = true;
    render();
    try {
      const owner = uid();
      const photoPath = L.photo ? `${owner}/${uuid()}.jpg` : null;
      let photoPending = L.photo ? [{ path: photoPath, blob: L.photo.blob }] : [];
      const takePhoto = () => {
        const p = photoPending;
        photoPending = [];
        return p;
      };
      const usePhotoAsRef = photoPath && (!L.extracted || L.extracted.source !== "manifest");
      for (const it of items) {
        let c = findCatalog(it);
        if (!c) {
          c = {
            id: uuid(), owner, kind: it.kind, name: String(it.name).trim(), part_number: String(it.part_number).trim(),
            manufacturer: String(it.manufacturer || "").trim(), model: String(it.model || "").trim(), unit: String(it.unit || "each").trim() || "each",
            ref_photo: usePhotoAsRef ? photoPath : null, created_at: nowIso(),
          };
          await enqueue("violet_catalog", c, takePhoto());
        } else if (!c.ref_photo && usePhotoAsRef) {
          const { _pending, ...clean } = c;
          await enqueue("violet_catalog", { ...clean, ref_photo: photoPath }, takePhoto());
        }
        const e = {
          id: uuid(), owner, happened_at: happened.toISOString(), created_at: nowIso(), type: L.type, catalog_id: c.id,
          serial: String(it.serial || "").trim(), qty: Number(it.quantity), condition: f.condition,
          from_holder: n.from ? f.from_holder || null : null, to_holder: n.to ? f.to_holder || null : null,
          locker_id: n.locker ? f.locker_id.trim() : "", site: n.locker ? f.site.trim() : "",
          symptom: n.failure ? f.symptom : "", cause: n.failure ? f.cause : "", note: f.note.trim(),
          source: L.photo ? (L.extracted ? "photo read" : L.barcodes.length ? "barcode" : "photo") : "hand",
          extracted: L.extracted ? { source: L.extracted.source, shipment: L.extracted.shipment, item: { ...it, include: undefined } } : null,
          photos: photoPath ? [photoPath] : [],
        };
        await enqueue("violet_events", e, takePhoto());
      }
      const kept = { type: L.type, f: { ...f } };
      S.log = newLog(kept.type);
      Object.assign(S.log.f, { from_holder: kept.f.from_holder, to_holder: kept.f.to_holder, site: kept.f.site });
      toast(S.demo ? "Saved to demo data" : navigator.onLine ? "Saved, syncing" : "Saved on the phone, will sync when signal returns");
      render();
      sync();
    } catch (err) {
      L.busy = false;
      fail("Could not save: " + err.message);
    }
  }

  // ----- History -----
  function eventLine(e) {
    const c = catalogById(e.catalog_id);
    const moves = [e.from_holder && holderName(e.from_holder), e.to_holder && holderName(e.to_holder)].filter(Boolean).join(" to ");
    const where = e.locker_id ? `locker ${e.locker_id} · ${e.site}` : "";
    return `<div class="tap" data-event="${e.id}">
      <span class="badge b-${e.type}">${esc(TYPES[e.type] || e.type)}</span><b>${esc(partLabel(c))}</b>${e._pending ? ' <span class="pill">waiting to sync</span>' : ""}<br>
      <span class="muted">${esc(fmtDate(e.happened_at))}${e.serial ? " · SN " + esc(e.serial) : " · " + fmtNum(Number(e.qty)) + " " + esc((c && c.unit) || "")}${moves ? " · " + esc(moves) : ""}${where ? " · " + esc(where) : ""}${e.symptom ? " · " + esc(e.symptom) : ""}</span></div>`;
  }

  function renderHistory() {
    const q = norm(S.historySearch);
    const list = events()
      .slice()
      .sort(sortEvents)
      .reverse()
      .filter((e) => {
        if (!q) return true;
        const c = catalogById(e.catalog_id) || {};
        return [e.serial, e.locker_id, e.site, e.symptom, c.name, c.part_number, holderName(e.from_holder), holderName(e.to_holder)].some((v) => norm(v).includes(q));
      });
    return `<label>Search serial, part, locker, site, or holder</label><input id="historySearch" value="${esc(S.historySearch)}" placeholder="Search">
      <div class="card list">${list.slice(0, S.historyLimit).map(eventLine).join("") || '<div class="muted">No events yet</div>'}</div>
      ${list.length > S.historyLimit ? `<button class="btn wide" data-act="more-history">Show more (${list.length - S.historyLimit} left)</button>` : ""}`;
  }

  // ----- Failures -----
  function bars(title, counts) {
    const arr = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (!arr.length) return "";
    const max = arr[0][1];
    return `<h3>${esc(title)}</h3><div class="card"><table>${arr
      .slice(0, 15)
      .map(([k, v]) => `<tr><td>${esc(k)}<div class="bar" style="width:${Math.max(4, (v / max) * 100)}%"></div></td><td>${v}</td></tr>`)
      .join("")}</table></div>`;
  }

  function renderFailures() {
    const pulled = events().filter((e) => e.type === "pulled");
    if (!pulled.length) return `<div class="card"><h2>No failures logged</h2><p>Every part pulled as failed shows up here, counted by part, site, symptom, and cause.</p></div>`;
    const count = (fn) => {
      const m = new Map();
      for (const e of pulled) {
        const k = fn(e) || "Not given";
        m.set(k, (m.get(k) || 0) + 1);
      }
      return m;
    };
    const installs = new Map();
    for (const e of events()) if (e.type === "installed" && e.serial) installs.set(norm(e.serial), e.happened_at);
    const lifeDays = [];
    for (const e of pulled) {
      const at = e.serial && installs.get(norm(e.serial));
      if (at && ms(at) < ms(e.happened_at)) lifeDays.push({ e, days: (ms(e.happened_at) - ms(at)) / 864e5 });
    }
    const byPartLife = new Map();
    for (const { e, days } of lifeDays) {
      const k = partLabel(catalogById(e.catalog_id));
      const v = byPartLife.get(k) || { n: 0, sum: 0 };
      byPartLife.set(k, { n: v.n + 1, sum: v.sum + days });
    }
    const repeat = count((e) => e.serial && norm(e.serial));
    const repeats = new Map([...repeat].filter(([k, v]) => k !== "Not given" && v > 1).map(([k, v]) => ["SN " + k, v]));
    return `<div class="tiles"><div class="tile"><span class="muted">Pulled as failed</span><b>${pulled.length}</b>all time</div>
      <div class="tile"><span class="muted">Last 30 days</span><b>${pulled.filter((e) => new Date(e.happened_at) > Date.now() - 30 * 864e5).length}</b>pulled</div></div>
      ${bars("By part", count((e) => partLabel(catalogById(e.catalog_id))))}
      ${bars("By site", count((e) => e.site))}
      ${bars("By symptom", count((e) => e.symptom))}
      ${bars("By suspected cause", count((e) => e.cause))}
      ${repeats.size ? bars("Same serial failed more than once", repeats) : ""}
      ${byPartLife.size ? `<h3>Average days installed before failing</h3><div class="card"><table>${[...byPartLife].sort((a, b) => a[1].sum / a[1].n - b[1].sum / b[1].n).map(([k, v]) => `<tr><td>${esc(k)} <span class="muted">(${v.n})</span></td><td>${Math.round(v.sum / v.n)}</td></tr>`).join("")}</table></div>` : ""}`;
  }

  // ----- More -----
  function renderMore() {
    const hs = holders();
    const cat = catalog().slice().sort((a, b) => partLabel(a).localeCompare(partLabel(b)));
    return `
      <h2>Sync</h2>
      <div class="card">
        ${S.demo ? "<p>Demo data is on. Nothing is saved to your account.</p>" : `
        <p>${navigator.onLine ? "Online" : "Offline"} · ${S.queue.length} waiting to sync${S.lastSync ? " · last synced " + esc(fmtDate(S.lastSync)) : ""}</p>
        ${S.syncError ? `<p class="err">Last sync failed: ${esc(S.syncError)}</p>` : ""}
        <button class="btn" data-act="sync">Sync now</button>`}
      </div>
      <h2>Holders</h2>
      <div class="card list">${hs.map((h) => `<div>${esc(h.name)} <span class="muted">${esc(HOLDER_KINDS[h.kind] || h.kind)}</span>${h._pending ? ' <span class="pill">waiting to sync</span>' : ""}</div>`).join("") || '<div class="muted">None yet</div>'}</div>
      <form id="holderForm" class="card">
        <label>New holder name</label><input name="name" required maxlength="80">
        <label>Kind</label><select name="kind">${Object.entries(HOLDER_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        <button class="btn primary wide" type="submit">Add holder</button>
      </form>
      <h2>Parts catalog</h2>
      <div class="card list">${cat.map((c) => `<div class="tap row" data-catalog="${c.id}" style="align-items:center">${c.ref_photo ? `<div style="flex:0 0 72px"><img class="thumb" data-photo="${esc(c.ref_photo)}" alt=""></div>` : ""}<div><b>${esc(partLabel(c))}</b><br><span class="muted">${esc(ITEM_KINDS[c.kind] || c.kind)}${c.manufacturer ? " · " + esc(c.manufacturer) : ""}${c.model ? " · " + esc(c.model) : ""}</span></div></div>`).join("") || '<div class="muted">Parts appear here the first time you log them</div>'}</div>
      <h2>Export</h2>
      <div class="card row"><button class="btn" data-act="csv-stock">Stock CSV</button><button class="btn" data-act="csv-events">Event history CSV</button></div>
      <h2>Label reader</h2>
      <form id="settingsForm" class="card">
        <label>API address</label><input name="api" type="url" value="${esc(S.settings.api)}" placeholder="field-twin-violet-api address on Railway">
        <label>API token</label><input name="token" type="password" value="${esc(S.settings.token)}" autocomplete="off">
        <div class="row" style="margin-top:10px"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="test-api">Test</button></div>
        <p class="muted" id="apiResult"></p>
      </form>
      <h2>Demo</h2>
      <div class="card">${S.demo ? '<button class="btn wide" data-act="demo-off">Leave demo data</button>' : '<button class="btn wide" data-act="demo-on">Show invented demo data</button><p class="muted">Your real records are not touched.</p>'}</div>
      ${S.user ? `<div class="card"><p class="muted">Signed in as ${esc(S.user.email)}</p><button class="btn wide" data-act="signout">Sign out</button></div>` : ""}`;
  }

  // ---------- modals ----------
  function openModal(html) {
    $("#sheet").innerHTML = html + '<button class="btn wide" data-act="close">Close</button>';
    $("#modal").classList.add("open");
    hydratePhotos($("#sheet"));
  }
  const closeModal = () => $("#modal").classList.remove("open");

  function photoStrip(paths) {
    return paths && paths.length ? `<div>${paths.map((p) => `<img class="full" data-photo="${esc(p)}" alt="">`).join("")}</div>` : "";
  }

  function showEvent(id) {
    const e = events().find((x) => x.id === id);
    if (!e) return;
    const c = catalogById(e.catalog_id);
    const rowsHtml = [
      ["Type", TYPES[e.type] || e.type], ["Part", partLabel(c)], ["Serial", e.serial], ["Quantity", e.serial ? "" : fmtNum(Number(e.qty))],
      ["When", fmtDate(e.happened_at)], ["From", holderName(e.from_holder)], ["To", holderName(e.to_holder)], ["Locker", e.locker_id], ["Site", e.site],
      ["Condition", CONDITIONS[e.condition] || e.condition], ["Symptom", e.symptom], ["Cause", e.cause], ["Note", e.note], ["Logged by", e.source],
    ].filter(([, v]) => v);
    openModal(`<h2>${esc(TYPES[e.type] || e.type)}</h2><table>${rowsHtml.map(([k, v]) => `<tr><td class="muted">${k}</td><td>${esc(v)}</td></tr>`).join("")}</table>
      ${e.serial ? `<button class="btn small" data-serial="${esc(e.serial)}">Full history of this serial</button>` : ""}${photoStrip(e.photos)}`);
  }

  function showSerial(serial) {
    const list = events().filter((e) => norm(e.serial) === norm(serial)).sort(sortEvents).reverse();
    const c = list[0] && catalogById(list[0].catalog_id);
    openModal(`<h2>SN ${esc(serial)}</h2><p>${esc(partLabel(c))}</p><div class="card list">${list.map(eventLine).join("")}</div>`);
  }

  function showCatalog(id) {
    const c = catalogById(id);
    if (!c) return;
    const photos = [...new Set(events().filter((e) => e.catalog_id === id).flatMap((e) => e.photos || []))];
    const d = derive();
    const holding = [];
    for (const [h, items] of d.byHolder) {
      const n = items.filter((it) => it.catalog_id === id).reduce((a, it) => a + it.qty, 0);
      if (n) holding.push(`${holderName(h)}: ${fmtNum(n)}`);
    }
    openModal(`<h2>${esc(partLabel(c))}</h2>
      <p class="muted">${esc([ITEM_KINDS[c.kind], c.manufacturer, c.model, c.unit].filter(Boolean).join(" · "))}</p>
      <p>${holding.length ? esc(holding.join(", ")) : "Nobody holds this part right now."}</p>
      ${c.ref_photo ? `<h3>Reference photo</h3><img class="full" data-photo="${esc(c.ref_photo)}" alt="">` : "<p class=\"muted\">No reference photo yet.</p>"}
      ${photos.filter((p) => p !== c.ref_photo).length ? `<h3>Other photos of this part</h3><p class="muted">Tap one to make it the reference photo.</p><div class="photos">${photos.filter((p) => p !== c.ref_photo).map((p) => `<img class="thumb tap" data-photo="${esc(p)}" data-setref="${esc(p)}" data-cat="${c.id}" alt="">`).join("")}</div>` : ""}`);
  }

  function showConflicts() {
    const d = derive();
    openModal(`<h2>Conflicts</h2><p class="muted">These are where untracked inventory hides. Fix one by logging the move that was missed, then the flag clears on its own.</p>
      <div class="card list">${d.conflicts.slice().reverse().map((x) => `<div class="tap" data-event="${x.event.id}"><b>${esc(x.text)}</b><br><span class="muted">${esc(fmtDate(x.event.happened_at))} · ${esc(TYPES[x.event.type])}</span></div>`).join("")}</div>`);
  }

  // ---------- CSV ----------
  function csv(rowsArr) {
    return rowsArr.map((r) => r.map((v) => `"${String(v === null || v === undefined ? "" : v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }
  function exportStock() {
    const d = derive();
    const out = [["holder", "holder kind", "part name", "part number", "serial", "quantity", "unit"]];
    for (const h of holders())
      for (const it of d.byHolder.get(h.id) || []) {
        const c = catalogById(it.catalog_id) || {};
        out.push([h.name, HOLDER_KINDS[h.kind] || h.kind, c.name, c.part_number, it.serial || "", it.qty, c.unit]);
      }
    for (const s of d.lockers) {
      const c = catalogById(s.catalog_id) || {};
      out.push([`locker ${s.locker_id} at ${s.site}`, "installed", c.name, c.part_number, s.serial, 1, c.unit]);
    }
    download(`field-twin-violet-stock-${new Date().toISOString().slice(0, 10)}.csv`, csv(out));
  }
  function exportEvents() {
    const out = [["when", "type", "part name", "part number", "serial", "quantity", "from", "to", "locker", "site", "condition", "symptom", "cause", "note", "logged by", "photos", "event id"]];
    for (const e of events().slice().sort(sortEvents)) {
      const c = catalogById(e.catalog_id) || {};
      out.push([e.happened_at, TYPES[e.type] || e.type, c.name, c.part_number, e.serial, e.qty, holderName(e.from_holder), holderName(e.to_holder), e.locker_id, e.site, e.condition, e.symptom, e.cause, e.note, e.source, (e.photos || []).join(" "), e.id]);
    }
    download(`field-twin-violet-events-${new Date().toISOString().slice(0, 10)}.csv`, csv(out));
  }

  // ---------- demo data, invented ----------
  function buildDemo() {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const id = () => uuid();
    const H = [
      { id: id(), name: "Demo tech truck", kind: "truck" },
      { id: id(), name: "Demo home stock", kind: "home" },
      { id: id(), name: "Demo second tech", kind: "tech" },
      { id: id(), name: "Demo return box", kind: "return" },
    ].map((h) => ({ ...h, owner: "demo", created_at: nowIso() }));
    const C = [
      ["Door latch solenoid", "DL-200", "part"], ["Controller board rev C", "CB-7C", "part"], ["Touch display 10 inch", "TD-10", "part"],
      ["Scanner module", "SC-3", "part"], ["Power supply 24V", "PS-24", "part"], ["Door sensor", "DS-1", "part"], ["Zip ties 8 inch", "ZT-8", "consumable"],
    ].map(([name, pn, kind]) => ({ id: id(), owner: "demo", kind, name, part_number: pn, manufacturer: "Demo Parts Co", model: pn, unit: "each", ref_photo: null, created_at: nowIso() }));
    const sites = ["Demo Site North", "Demo Site Desert", "Demo Site Harbor"];
    const E = [];
    const day = 864e5;
    const start = Date.now() - 150 * day;
    let t = start;
    const ev = (o) => t <= Date.now() - 36e5 && E.push({ id: id(), owner: "demo", created_at: new Date(t).toISOString(), happened_at: new Date(t).toISOString(), serial: "", qty: 1, condition: "good", from_holder: null, to_holder: null, locker_id: "", site: "", symptom: "", cause: "", note: "", source: "demo", extracted: null, photos: [], ...o });
    let sn = 1000;
    for (let i = 0; i < 36; i++) {
      t += day * (1 + rnd() * 2.5);
      const c = pick(C.slice(0, 6));
      const serial = c.part_number + "-" + sn++;
      ev({ type: "received", catalog_id: c.id, serial, to_holder: H[1].id });
      if (rnd() < 0.85) {
        t += day * rnd();
        const tech = rnd() < 0.7 ? H[0] : H[2];
        ev({ type: "moved", catalog_id: c.id, serial, from_holder: H[1].id, to_holder: tech.id });
        if (rnd() < 0.7) {
          t += day * rnd() * 3;
          const site = c.part_number === "CB-7C" ? (rnd() < 0.7 ? sites[1] : pick(sites)) : pick(sites);
          const locker = "L-" + (100 + Math.floor(rnd() * 40));
          ev({ type: "installed", catalog_id: c.id, serial, from_holder: tech.id, locker_id: locker, site });
          const failChance = c.part_number === "CB-7C" ? 0.75 : site === sites[1] ? 0.4 : 0.2;
          if (rnd() < failChance) {
            const keep = t;
            t += day * (c.part_number === "CB-7C" ? 8 + rnd() * 15 : 20 + rnd() * 50);
            if (t < Date.now()) {
              const symptom = c.part_number === "CB-7C" ? pick(["Dead, no power", "Burnt or overheated", "Intermittent"]) : c.part_number === "DL-200" ? "Will not latch or unlatch" : pick(SYMPTOMS.slice(0, 12));
              const cause = site === sites[1] ? pick(["Heat", "Heat", "Power surge or bad power"]) : pick(CAUSES);
              ev({ type: "pulled", catalog_id: c.id, serial, to_holder: tech.id, locker_id: locker, site, condition: "failed", symptom, cause });
              if (rnd() < 0.6) {
                t += day * rnd() * 4;
                if (t < Date.now()) ev({ type: "returned", catalog_id: c.id, serial, from_holder: tech.id, to_holder: H[3].id, condition: "failed" });
              }
            }
            t = keep;
          }
        }
      }
    }
    t = start + 5 * day;
    ev({ type: "received", catalog_id: C[6].id, qty: 500, to_holder: H[1].id });
    t += 2 * day;
    ev({ type: "moved", catalog_id: C[6].id, qty: 200, from_holder: H[1].id, to_holder: H[0].id });
    t = Date.now() - 2 * day;
    const dup = E.find((e) => e.type === "installed");
    if (dup) ev({ type: "installed", catalog_id: dup.catalog_id, serial: dup.serial, from_holder: H[2].id, locker_id: "L-139", site: sites[2], note: "Demo conflict: this serial was already installed" });
    return { violet_holders: H, violet_catalog: C, violet_events: E };
  }

  // ---------- events ----------
  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest("[data-act],[data-tab],[data-tab-go],[data-logtype],[data-holder],[data-serial],[data-event],[data-catalog],[data-code],[data-setref]");
    if (!t) {
      if (ev.target.id === "modal") closeModal();
      return;
    }
    if (t.dataset.tab) {
      S.tab = t.dataset.tab;
      window.scrollTo(0, 0);
      return render();
    }
    if (t.dataset.tabGo) {
      closeModal();
      S.tab = t.dataset.tabGo;
      return render();
    }
    if (t.dataset.logtype) {
      S.log.type = t.dataset.logtype;
      S.log.error = "";
      S.log.f.condition = S.log.type === "pulled" ? "failed" : S.log.f.condition === "failed" ? "good" : S.log.f.condition;
      return render();
    }
    if (t.dataset.holder) {
      S.holderFilter = S.holderFilter === t.dataset.holder ? "" : t.dataset.holder;
      return render();
    }
    if (t.dataset.code) {
      const it = S.log.items[Number(t.dataset.item)];
      it[t.dataset.into] = t.dataset.code;
      if (it.confidence) it.confidence[t.dataset.into] = 1;
      return render();
    }
    if (t.dataset.setref) {
      const c = catalogById(t.dataset.cat);
      if (!c) return;
      const { _pending, ...clean } = c;
      await enqueue("violet_catalog", { ...clean, ref_photo: t.dataset.setref });
      toast("Reference photo changed");
      closeModal();
      render();
      return sync();
    }
    if (t.dataset.event) return showEvent(t.dataset.event);
    if (t.dataset.serial) return showSerial(t.dataset.serial);
    if (t.dataset.catalog) return showCatalog(t.dataset.catalog);
    switch (t.dataset.act) {
      case "close": return closeModal();
      case "conflicts": return showConflicts();
      case "add-item": S.log.items.push(blankItem()); return render();
      case "clear-log": S.log = newLog(S.log.type); return render();
      case "save-log": return saveLog();
      case "more-history": S.historyLimit += 100; return render();
      case "sync": return sync();
      case "csv-stock": return exportStock();
      case "csv-events": return exportEvents();
      case "demo-on":
        S.demo = true;
        S.demoData = buildDemo();
        S.log = null;
        S.tab = "stock";
        return render();
      case "demo-off":
        S.demo = false;
        S.demoData = null;
        S.log = null;
        return render();
      case "signout":
        await sb.auth.signOut();
        S.user = null;
        S.server = { violet_holders: [], violet_catalog: [], violet_events: [] };
        S.queue = [];
        return render();
      case "test-api": {
        const out = $("#apiResult");
        const form = $("#settingsForm");
        const api = form.api.value.trim().replace(/\/+$/, "");
        out.textContent = "Testing";
        try {
          const r = await fetch(api + "/extract", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + form.token.value.trim() }, body: JSON.stringify({ check: true }) });
          out.textContent = r.ok ? "Connected, token accepted" : r.status === 401 ? "The service answered but rejected the token" : `The service answered ${r.status}`;
        } catch (e) {
          out.textContent = "Could not reach that address";
        }
        return;
      }
    }
  });

  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.id === "stockSearch") {
      S.stockSearch = t.value;
      const pos = t.selectionStart;
      render();
      const n = $("#stockSearch");
      n.focus();
      n.setSelectionRange(pos, pos);
      return;
    }
    if (t.id === "historySearch") {
      S.historySearch = t.value;
      S.historyLimit = 100;
      const pos = t.selectionStart;
      render();
      const n = $("#historySearch");
      n.focus();
      n.setSelectionRange(pos, pos);
      return;
    }
    if (!S.log) return;
    if (t.dataset.f) S.log.f[t.dataset.f] = t.value;
    if (t.dataset.item !== undefined && t.dataset.k) {
      const it = S.log.items[Number(t.dataset.item)];
      if (t.dataset.k === "include") it.include = t.checked;
      else it[t.dataset.k] = t.value;
      if (it.confidence && it.confidence[t.dataset.k] !== undefined) {
        it.confidence[t.dataset.k] = 1;
        t.classList.remove("low");
      }
    }
  });

  document.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.id === "photoInput" && t.files && t.files[0]) return handlePhoto(t.files[0]);
    if (S.log && t.dataset.k === "part_number") {
      const it = S.log.items[Number(t.dataset.item)];
      const c = findCatalog(it);
      if (c) {
        if (!it.name) it.name = c.name;
        it.kind = c.kind;
        if (!it.unit || it.unit === "each") it.unit = c.unit;
        if (!it.manufacturer) it.manufacturer = c.manufacturer;
        if (!it.model) it.model = c.model;
        render();
      }
    }
  });

  document.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    if (f.id === "loginForm") {
      const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      if (error) return renderLogin(error.message);
      await startUser(data.user);
    } else if (f.id === "holderForm") {
      const name = f.name.value.trim();
      if (!name) return;
      await enqueue("violet_holders", { id: uuid(), owner: uid(), name, kind: f.kind.value, created_at: nowIso() });
      toast("Holder added");
      render();
      sync();
    } else if (f.id === "settingsForm") {
      S.settings = { api: f.api.value.trim().replace(/\/+$/, ""), token: f.token.value.trim() };
      await idb.set("settings", S.settings);
      toast("Saved");
    }
  });

  window.addEventListener("online", () => {
    renderStatus();
    sync();
  });
  window.addEventListener("offline", renderStatus);

  async function startUser(user) {
    S.user = user;
    const cached = await idb.get("data:" + user.id);
    if (cached) {
      S.server = cached.server;
      S.lastSync = cached.lastSync;
    }
    await loadQueue();
    render();
    sync();
  }

  async function boot() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/field-twin-violet-sw.js").catch(() => {});
    S.settings = (await idb.get("settings")) || S.settings;
    const { data } = await sb.auth.getSession();
    if (data && data.session) await startUser(data.session.user);
    else render();
    sb.auth.onAuthStateChange((evt, session) => {
      if (evt === "SIGNED_OUT") {
        S.user = null;
        render();
      }
    });
  }

  boot().catch((err) => {
    $("#app").innerHTML = `<div class="card"><p class="err">The app failed to start: ${esc(err.message)}</p></div>`;
  });
})();
