/* Idea Vault — Offline-first, IndexedDB, PWA-ready
   Vanilla JS. No backend. No external DB.
*/

const APP = {
  dbName: "idea_vault_db",
  dbVersion: 1,
  stores: {
    ideas: "ideas",
    images: "images",
    settings: "settings",
  },
  state: {
    bucket: "active", // active | parked | long_term | sparks
    view: null,       // daily | export | settings
    ideas: [],
    selectedId: null,
    search: "",
    filters: { venture: "", priority: "", tag: "" },
    sort: "updatedAt_desc",
    autosaveTimer: null,
    lastSavedAt: 0
  },
  ui: {}
};

// ---------- Utilities ----------
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const now = () => Date.now();

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  // fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random()*16)|0, v = c === "x" ? r : (r&0x3)|0x8;
    return v.toString(16);
  });
}

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { year:"numeric", month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit" });
}

function todayBounds() {
  const d = new Date();
  d.setHours(0,0,0,0);
  const start = d.getTime();
  const end = start + 24*60*60*1000;
  return { start, end };
}

function clampText(str, n=140) {
  const s = (str || "").trim();
  if (s.length <= n) return s;
  return s.slice(0, n-1) + "…";
}

function normalizeTag(t) {
  return (t || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function priorityRank(p) {
  if (p === "high") return 3;
  if (p === "medium") return 2;
  return 1;
}

function setSaveStatus(mode, text) {
  const el = APP.ui.saveStatus;
  el.classList.remove("saving","offline");
  if (mode === "saving") el.classList.add("saving");
  if (mode === "offline") el.classList.add("offline");
  el.textContent = text;
}

function safeUrl(url) {
  const u = (url || "").trim();
  if (!u) return "";
  // Allow http(s). If missing scheme, default to https.
  if (!/^https?:\/\//i.test(u)) return "https://" + u;
  return u;
}

// ---------- IndexedDB Wrapper ----------
const IDB = {
  db: null,

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(APP.dbName, APP.dbVersion);

      req.onupgradeneeded = () => {
        const db = req.result;

        // ideas store
        if (!db.objectStoreNames.contains(APP.stores.ideas)) {
          const ideas = db.createObjectStore(APP.stores.ideas, { keyPath: "id" });
          ideas.createIndex("bucket", "bucket", { unique: false });
          ideas.createIndex("updatedAt", "updatedAt", { unique: false });
          ideas.createIndex("createdAt", "createdAt", { unique: false });
        }

        // images store
        if (!db.objectStoreNames.contains(APP.stores.images)) {
          const images = db.createObjectStore(APP.stores.images, { keyPath: "id" });
          images.createIndex("ideaId", "ideaId", { unique: false });
          images.createIndex("createdAt", "createdAt", { unique: false });
        }

        // settings store
        if (!db.objectStoreNames.contains(APP.stores.settings)) {
          db.createObjectStore(APP.stores.settings, { keyPath: "key" });
        }
      };

      req.onsuccess = () => {
        IDB.db = req.result;
        resolve(IDB.db);
      };
      req.onerror = () => reject(req.error);
    });
  },

  tx(store, mode="readonly") {
    const t = IDB.db.transaction(store, mode);
    return t.objectStore(store);
  },

  get(store, key) {
    return new Promise((resolve, reject) => {
      const req = IDB.tx(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  put(store, value) {
    return new Promise((resolve, reject) => {
      const req = IDB.tx(store, "readwrite").put(value);
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
    });
  },

  delete(store, key) {
    return new Promise((resolve, reject) => {
      const req = IDB.tx(store, "readwrite").delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },

  clear(store) {
    return new Promise((resolve, reject) => {
      const req = IDB.tx(store, "readwrite").clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },

  getAll(store) {
    return new Promise((resolve, reject) => {
      const req = IDB.tx(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  getAllByIndex(store, indexName, query) {
    return new Promise((resolve, reject) => {
      const os = IDB.tx(store);
      const idx = os.index(indexName);
      const req = idx.getAll(query);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async getSetting(key, fallback=null) {
    const row = await IDB.get(APP.stores.settings, key);
    return row ? row.value : fallback;
  },

  async setSetting(key, value) {
    return IDB.put(APP.stores.settings, { key, value, updatedAt: now() });
  }
};

// ---------- Data model helpers ----------
function newIdea(partial={}) {
  const t = now();
  return {
    id: uuid(),
    bucket: "parked",
    title: "",
    ventureCategory: "",
    description: "",
    keyNotes: "",
    links: [],
    tags: [],
    priority: "medium",
    nextAction: "",
    status: "draft",
    createdAt: t,
    updatedAt: t,
    imageIds: [],
    ...partial
  };
}

async function getActiveIdea() {
  const all = await IDB.getAllByIndex(APP.stores.ideas, "bucket", "active");
  return all.length ? all[0] : null;
}

async function demoteExistingActive(exceptId, demoteTo="parked") {
  const active = await getActiveIdea();
  if (active && active.id !== exceptId) {
    active.bucket = demoteTo;
    active.updatedAt = now();
    await IDB.put(APP.stores.ideas, active);
  }
}

async function deleteIdeaAndImages(ideaId) {
  const images = await IDB.getAllByIndex(APP.stores.images, "ideaId", ideaId);
  for (const img of images) {
    await IDB.delete(APP.stores.images, img.id);
  }
  await IDB.delete(APP.stores.ideas, ideaId);
}

// ---------- Dialog ----------
function showDialog({ title, body, actions }) {
  const overlay = APP.ui.dialogOverlay;
  $("#dialogTitle").textContent = title || "Dialog";
  const bodyEl = $("#dialogBody");
  bodyEl.innerHTML = "";
  if (typeof body === "string") {
    bodyEl.innerHTML = body;
  } else if (body instanceof HTMLElement) {
    bodyEl.appendChild(body);
  }

  const actionsEl = $("#dialogActions");
  actionsEl.innerHTML = "";
  (actions || []).forEach(a => {
    const btn = document.createElement("button");
    btn.className = `btn ${a.kind || "btn-ghost"}`;
    btn.textContent = a.label;
    btn.addEventListener("click", async () => {
      hideDialog();
      await a.onClick?.();
    });
    actionsEl.appendChild(btn);
  });

  overlay.classList.remove("hidden");
}

function hideDialog() {
  APP.ui.dialogOverlay.classList.add("hidden");
}

// ---------- Views Overlay (Export / Settings / Daily) ----------
function showView(title, node) {
  $("#viewTitle").textContent = title;
  const body = $("#viewBody");
  body.innerHTML = "";
  body.appendChild(node);
  APP.ui.viewOverlay.classList.remove("hidden");
}

function hideView() {
  APP.ui.viewOverlay.classList.add("hidden");
}

// ---------- Rendering ----------
function setPanelTitle() {
  const map = {
    active: "Active Project",
    parked: "Parked Ideas",
    long_term: "Long-Term Concepts",
    sparks: "Random Sparks"
  };
  APP.ui.panelTitle.textContent = map[APP.state.bucket] || "Ideas";
}

function renderCounts(allIdeas) {
  const counts = { active:0, parked:0, long_term:0, sparks:0 };
  for (const i of allIdeas) counts[i.bucket] = (counts[i.bucket]||0) + 1;
  APP.ui.countActive.textContent = counts.active || 0;
  APP.ui.countParked.textContent = counts.parked || 0;
  APP.ui.countLong.textContent = counts.long_term || 0;
  APP.ui.countSparks.textContent = counts.sparks || 0;
}

function applySearchFilterSort(ideas) {
  const s = (APP.state.search || "").trim().toLowerCase();
  const fV = APP.state.filters.venture;
  const fP = APP.state.filters.priority;
  const fT = (APP.state.filters.tag || "").trim().toLowerCase();

  let out = ideas.filter(i => i.bucket === APP.state.bucket);

  if (s) {
    out = out.filter(i => {
      const hay = [
        i.title, i.description, i.keyNotes,
        (i.tags || []).join(" "),
        (i.ventureCategory || ""),
        (i.links || []).map(x => `${x.label} ${x.url}`).join(" ")
      ].join(" ").toLowerCase();
      return hay.includes(s);
    });
  }

  if (fV) out = out.filter(i => (i.ventureCategory || "") === fV);
  if (fP) out = out.filter(i => i.priority === fP);
  if (fT) out = out.filter(i => (i.tags || []).some(t => t.toLowerCase().includes(fT)));

  const sort = APP.state.sort;
  out.sort((a,b) => {
    if (sort === "updatedAt_desc") return (b.updatedAt||0) - (a.updatedAt||0);
    if (sort === "createdAt_desc") return (b.createdAt||0) - (a.createdAt||0);
    if (sort === "createdAt_asc") return (a.createdAt||0) - (b.createdAt||0);
    if (sort === "priority_desc") return priorityRank(b.priority) - priorityRank(a.priority) || (b.updatedAt||0)-(a.updatedAt||0);
    return (b.updatedAt||0)-(a.updatedAt||0);
  });

  return out;
}

function renderIdeaList() {
  const list = APP.ui.ideaList;
  list.innerHTML = "";

  const ideas = applySearchFilterSort(APP.state.ideas);

  APP.ui.emptyState.style.display = ideas.length ? "none" : "block";

  for (const idea of ideas) {
    const card = document.createElement("div");
    card.className = "idea-card";
    card.setAttribute("role","listitem");
    if (idea.id === APP.state.selectedId) card.classList.add("selected");

    const top = document.createElement("div");
    top.className = "idea-top";

    const titleWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "idea-title";
    title.textContent = idea.title || "(Untitled)";
    const sub = document.createElement("div");
    sub.className = "idea-sub";

    const b1 = document.createElement("span");
    b1.className = "badge";
    b1.textContent = idea.ventureCategory || "Other";

    const b2 = document.createElement("span");
    b2.className = "badge";
    b2.textContent = idea.status;

    const pri = document.createElement("span");
    pri.className = "badge " + (idea.priority === "high" ? "pri-high" : idea.priority === "medium" ? "pri-med" : "pri-low");
    pri.textContent = `pri:${idea.priority}`;

    const upd = document.createElement("span");
    upd.className = "badge";
    upd.textContent = `upd:${new Date(idea.updatedAt).toLocaleDateString()}`;

    sub.appendChild(b1);
    sub.appendChild(b2);
    sub.appendChild(pri);
    sub.appendChild(upd);

    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "8px";
    right.style.alignItems = "center";

    const act = document.createElement("span");
    act.className = "badge" + (idea.bucket === "active" ? " active" : "");
    act.textContent = idea.bucket === "active" ? "ACTIVE" : "";

    if (idea.bucket === "active") right.appendChild(act);

    top.appendChild(titleWrap);
    top.appendChild(right);

    const snippet = document.createElement("div");
    snippet.className = "idea-snippet";
    snippet.textContent = clampText(idea.description || idea.keyNotes || "", 160) || "—";

    card.appendChild(top);
    card.appendChild(snippet);

    card.addEventListener("click", () => selectIdea(idea.id));

    list.appendChild(card);
  }
}

function ensureDetailOpenMobile(open=true) {
  const isMobile = window.matchMedia("(max-width: 980px)").matches;
  if (!isMobile) return;

  if (open) {
    APP.ui.detailPanel.classList.add("open");
    APP.ui.drawerOverlay.classList.remove("hidden");
  } else {
    APP.ui.detailPanel.classList.remove("open");
    APP.ui.drawerOverlay.classList.add("hidden");
  }
}

async function renderIdeaDetail(idea) {
  const form = APP.ui.ideaForm;
  const empty = APP.ui.detailEmpty;

  if (!idea) {
    form.classList.add("hidden");
    empty.classList.remove("hidden");
    APP.ui.btnPromote.disabled = true;
    APP.ui.btnParkActive.disabled = true;
    APP.ui.btnDelete.disabled = true;
    return;
  }

  empty.classList.add("hidden");
  form.classList.remove("hidden");

  APP.ui.btnDelete.disabled = false;
  APP.ui.btnPromote.disabled = false;
  APP.ui.btnParkActive.disabled = false;

  // Buttons based on bucket
  APP.ui.btnPromote.style.display = (idea.bucket === "active") ? "none" : "inline-flex";
  APP.ui.btnParkActive.style.display = (idea.bucket === "active") ? "inline-flex" : "none";

  $("#ideaId").value = idea.id;
  $("#title").value = idea.title || "";
  $("#bucket").value = idea.bucket;
  $("#ventureCategory").value = idea.ventureCategory || "";
  $("#status").value = idea.status || "draft";
  $("#priority").value = idea.priority || "medium";
  $("#nextAction").value = idea.nextAction || "";
  $("#description").value = idea.description || "";
  $("#keyNotes").value = idea.keyNotes || "";

  $("#createdMeta").textContent = `Created: ${fmtDate(idea.createdAt)}`;
  $("#updatedMeta").textContent = `Updated: ${fmtDate(idea.updatedAt)}`;

  renderTags(idea.tags || []);
  renderLinks(idea.links || []);
  await renderImages(idea);

  // Ensure mobile drawer open when selecting
  ensureDetailOpenMobile(true);
}

function renderTags(tags) {
  const chips = APP.ui.tagChips;
  chips.innerHTML = "";
  for (const t of tags) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span>${t}</span>`;
    const x = document.createElement("button");
    x.type = "button";
    x.title = "Remove tag";
    x.textContent = "✕";
    x.addEventListener("click", () => {
      const idea = currentIdea();
      if (!idea) return;
      idea.tags = (idea.tags || []).filter(z => z !== t);
      scheduleAutosave(idea);
      renderTags(idea.tags);
      renderIdeaList();
    });
    chip.appendChild(x);
    chips.appendChild(chip);
  }
}

function renderLinks(links) {
  const list = APP.ui.linksList;
  list.innerHTML = "";

  links.forEach((l, idx) => {
    const row = document.createElement("div");
    row.className = "link-row";

    const label = document.createElement("input");
    label.type = "text";
    label.placeholder = "Label";
    label.value = l.label || "";

    const url = document.createElement("input");
    url.type = "url";
    url.placeholder = "URL";
    url.value = l.url || "";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-ghost";
    del.textContent = "Remove";

    function onChange() {
      const idea = currentIdea();
      if (!idea) return;
      idea.links = idea.links || [];
      idea.links[idx] = { label: label.value.trim(), url: safeUrl(url.value) };
      scheduleAutosave(idea);
      renderIdeaList();
    }

    label.addEventListener("input", onChange);
    url.addEventListener("input", onChange);

    del.addEventListener("click", () => {
      const idea = currentIdea();
      if (!idea) return;
      idea.links = (idea.links || []).filter((_, i) => i !== idx);
      scheduleAutosave(idea);
      renderLinks(idea.links);
    });

    row.appendChild(label);
    row.appendChild(url);
    row.appendChild(del);
    list.appendChild(row);
  });
}

async function renderImages(idea) {
  const grid = APP.ui.imageGrid;
  grid.innerHTML = "";

  const ids = idea.imageIds || [];
  if (!ids.length) return;

  for (const imageId of ids) {
    const rec = await IDB.get(APP.stores.images, imageId);
    if (!rec) continue;

    const wrap = document.createElement("div");
    wrap.className = "thumb";

    const img = document.createElement("img");
    const url = URL.createObjectURL(rec.blob);
    img.src = url;
    img.alt = rec.filename || "Image";

    img.addEventListener("load", () => {
      // cleanup happens when we rerender; keep it alive while displayed
    });

    img.addEventListener("click", () => {
      showDialog({
        title: rec.filename || "Image",
        body: `<img src="${img.src}" style="max-width:100%;border-radius:14px;border:1px solid rgba(255,255,255,.12)" />`,
        actions: [
          { label: "Close", kind: "btn-primary", onClick: () => {} }
        ]
      });
    });

    const actions = document.createElement("div");
    actions.className = "thumb-actions";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = "View";
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      img.click();
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cur = currentIdea();
      if (!cur) return;
      // Remove from idea + delete record
      cur.imageIds = (cur.imageIds || []).filter(x => x !== imageId);
      await IDB.delete(APP.stores.images, imageId);
      await saveIdea(cur, { skipActiveRuleCheck: false });
      await renderIdeaDetail(cur);
      renderIdeaList();
    });

    actions.appendChild(openBtn);
    actions.appendChild(delBtn);

    wrap.appendChild(img);
    wrap.appendChild(actions);
    grid.appendChild(wrap);
  }
}

function currentIdea() {
  const id = APP.state.selectedId;
  if (!id) return null;
  return APP.state.ideas.find(i => i.id === id) || null;
}

// ---------- App logic ----------
async function loadAllIdeas() {
  const ideas = await IDB.getAll(APP.stores.ideas);
  // Ensure shape
  APP.state.ideas = ideas.map(i => ({ ...newIdea(), ...i }));
}

async function refreshUI() {
  setPanelTitle();
  renderCounts(APP.state.ideas);
  renderIdeaList();

  const sel = currentIdea();
  await renderIdeaDetail(sel);
}

async function selectIdea(id) {
  APP.state.selectedId = id;
  renderIdeaList();
  const idea = currentIdea();
  await renderIdeaDetail(idea);
}

async function createAndSelectIdea(partial={}) {
  const idea = newIdea(partial);
  await saveIdea(idea, { skipActiveRuleCheck: false });
  APP.state.ideas.push(idea);
  APP.state.selectedId = idea.id;
  await refreshUI();
}

function scheduleAutosave(idea) {
  setSaveStatus("saving", "Saving…");
  clearTimeout(APP.state.autosaveTimer);
  APP.state.autosaveTimer = setTimeout(async () => {
    await saveIdea(idea, { skipActiveRuleCheck: false });
    await loadAllIdeas();
    setSaveStatus(navigator.onLine ? "ok" : "offline", navigator.onLine ? "Saved" : "Saved (offline)");
    await refreshUI();
  }, 350);
}

async function saveIdea(idea, { skipActiveRuleCheck=false } = {}) {
  // Enforce required shape
  const t = now();
  if (!idea.createdAt) idea.createdAt = t;
  idea.updatedAt = t;

  // Active rule: only one active
  if (!skipActiveRuleCheck && idea.bucket === "active") {
    const active = await getActiveIdea();
    if (active && active.id !== idea.id) {
      // Ask where to demote the previous active
      const choice = await askDemoteDestination(active);
      await demoteExistingActive(idea.id, choice);
      // also update in-memory list
      const idx = APP.state.ideas.findIndex(x => x.id === active.id);
      if (idx >= 0) {
        APP.state.ideas[idx].bucket = choice;
        APP.state.ideas[idx].updatedAt = now();
      }
    }
  }

  await IDB.put(APP.stores.ideas, idea);
  APP.state.lastSavedAt = t;
}

function askDemoteDestination(activeIdea) {
  return new Promise((resolve) => {
    showDialog({
      title: "Only one Active Project",
      body: `
        <div style="color:rgba(234,241,255,.92);line-height:1.5">
          You already have an Active Project:
          <div style="margin-top:10px;padding:10px;border:1px solid rgba(255,255,255,.10);border-radius:14px;background:rgba(255,255,255,.02)">
            <b>${escapeHtml(activeIdea.title || "(Untitled)")}</b><br/>
            <span style="color:rgba(142,160,181,.95);font-size:12px">Where should it be demoted?</span>
          </div>
        </div>
      `,
      actions: [
        { label: "Demote to Parked", kind: "btn-primary", onClick: () => resolve("parked") },
        { label: "Demote to Long-Term", kind: "btn-ghost", onClick: () => resolve("long_term") }
      ]
    });
  });
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

// ---------- Form bindings ----------
function bindForm() {
  const map = [
    ["title","title"],
    ["bucket","bucket"],
    ["ventureCategory","ventureCategory"],
    ["status","status"],
    ["priority","priority"],
    ["nextAction","nextAction"],
    ["description","description"],
    ["keyNotes","keyNotes"]
  ];

  map.forEach(([id, key]) => {
    const el = $("#" + id);
    el.addEventListener("input", async () => {
      const idea = currentIdea();
      if (!idea) return;
      idea[key] = el.value;
      scheduleAutosave(idea);
      renderIdeaList();
      if (key === "bucket") {
        // if moved out of current bucket, select stays but list changes
        // keep selection and rerender
      }
    });
    el.addEventListener("change", async () => {
      const idea = currentIdea();
      if (!idea) return;
      idea[key] = el.value;
      scheduleAutosave(idea);
      renderIdeaList();
    });
  });

  // Tag entry
  APP.ui.tagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = normalizeTag(APP.ui.tagInput.value);
      if (!val) return;
      const idea = currentIdea();
      if (!idea) return;
      idea.tags = idea.tags || [];
      if (!idea.tags.includes(val)) idea.tags.push(val);
      APP.ui.tagInput.value = "";
      scheduleAutosave(idea);
      renderTags(idea.tags);
      renderIdeaList();
    }
  });

  // Add link
  APP.ui.btnAddLink.addEventListener("click", () => {
    const idea = currentIdea();
    if (!idea) return;
    idea.links = idea.links || [];
    idea.links.push({ label:"", url:"" });
    scheduleAutosave(idea);
    renderLinks(idea.links);
  });

  // Images picker
  APP.ui.imagePicker.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const idea = currentIdea();
    if (!idea) return;

    for (const f of files) {
      const rec = {
        id: uuid(),
        ideaId: idea.id,
        blob: f,
        filename: f.name,
        type: f.type,
        createdAt: now()
      };
      await IDB.put(APP.stores.images, rec);
      idea.imageIds = idea.imageIds || [];
      idea.imageIds.push(rec.id);
    }

    await saveIdea(idea, { skipActiveRuleCheck: false });
    await loadAllIdeas();
    await renderIdeaDetail(currentIdea());
    renderIdeaList();

    // reset picker so re-adding same file works
    APP.ui.imagePicker.value = "";
  });

  // Promote to Active
  APP.ui.btnPromote.addEventListener("click", async () => {
    const idea = currentIdea();
    if (!idea) return;
    idea.bucket = "active";
    await saveIdea(idea, { skipActiveRuleCheck: false });
    await loadAllIdeas();
    APP.state.bucket = "active";
    activateNavBucket("active");
    APP.state.selectedId = idea.id;
    await refreshUI();
  });

  // Park it (from Active)
  APP.ui.btnParkActive.addEventListener("click", async () => {
    const idea = currentIdea();
    if (!idea) return;
    idea.bucket = "parked";
    await saveIdea(idea, { skipActiveRuleCheck: true });
    await loadAllIdeas();
    APP.state.bucket = "parked";
    activateNavBucket("parked");
    await refreshUI();
  });

  // Delete
  APP.ui.btnDelete.addEventListener("click", async () => {
    const idea = currentIdea();
    if (!idea) return;

    showDialog({
      title: "Delete idea?",
      body: `<div style="color:rgba(234,241,255,.92);line-height:1.5">
        This will delete the idea <b>${escapeHtml(idea.title || "(Untitled)")}</b> and all attached images.
      </div>`,
      actions: [
        { label: "Cancel", kind: "btn-ghost", onClick: () => {} },
        { label: "Delete", kind: "btn-danger", onClick: async () => {
          await deleteIdeaAndImages(idea.id);
          APP.state.selectedId = null;
          await loadAllIdeas();
          await refreshUI();
          ensureDetailOpenMobile(false);
        }}
      ]
    });
  });
}

// ---------- Navigation / List controls ----------
function activateNavBucket(bucket) {
  APP.state.view = null;
  APP.state.bucket = bucket;
  $$(".nav-item").forEach(b => b.classList.remove("active"));
  const btn = $(`.nav-item[data-bucket="${bucket}"]`);
  if (btn) btn.classList.add("active");
  // Clear view actives
  $$(".nav-item[data-view]").forEach(b => b.classList.remove("active"));
  setPanelTitle();
}

function activateNavView(view) {
  APP.state.view = view;
  $$(".nav-item").forEach(b => b.classList.remove("active"));
  const btn = $(`.nav-item[data-view="${view}"]`);
  if (btn) btn.classList.add("active");
}

function bindNav() {
  // bucket buttons
  $$(".nav-item[data-bucket]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const b = btn.getAttribute("data-bucket");
      activateNavBucket(b);
      await refreshUI();
      ensureDetailOpenMobile(false);
    });
  });

  // view buttons
  $$(".nav-item[data-view]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const v = btn.getAttribute("data-view");
      activateNavView(v);
      if (v === "daily") {
        showDailySweep();
      } else if (v === "export") {
        showExportImport();
      } else if (v === "settings") {
        showSettings();
      }
    });
  });

  // Search + filters + sort
  APP.ui.searchInput.addEventListener("input", () => {
    APP.state.search = APP.ui.searchInput.value;
    renderIdeaList();
  });
  APP.ui.btnClearSearch.addEventListener("click", () => {
    APP.ui.searchInput.value = "";
    APP.state.search = "";
    renderIdeaList();
  });

  APP.ui.filterVenture.addEventListener("change", () => {
    APP.state.filters.venture = APP.ui.filterVenture.value;
    renderIdeaList();
  });
  APP.ui.filterPriority.addEventListener("change", () => {
    APP.state.filters.priority = APP.ui.filterPriority.value;
    renderIdeaList();
  });
  APP.ui.filterTag.addEventListener("input", () => {
    APP.state.filters.tag = APP.ui.filterTag.value;
    renderIdeaList();
  });
  APP.ui.sortSelect.addEventListener("change", () => {
    APP.state.sort = APP.ui.sortSelect.value;
    renderIdeaList();
  });

  // Quick dump
  APP.ui.btnQuickDumpToggle.addEventListener("click", () => {
    APP.ui.quickDump.classList.toggle("hidden");
    if (!APP.ui.quickDump.classList.contains("hidden")) {
      APP.ui.qdTitle.focus();
    }
  });

  APP.ui.btnQuickAdd.addEventListener("click", async () => {
    const title = APP.ui.qdTitle.value.trim();
    const notes = APP.ui.qdNotes.value.trim();
    const bucket = APP.ui.qdBucket.value;

    if (!title && !notes) return;

    const idea = newIdea({
      title: title || "(Quick dump)",
      keyNotes: notes,
      bucket: bucket || "parked",
      ventureCategory: "Other",
      status: "draft",
      priority: "medium",
      nextAction: ""
    });

    await saveIdea(idea, { skipActiveRuleCheck: false });
    await loadAllIdeas();

    APP.ui.qdTitle.value = "";
    APP.ui.qdNotes.value = "";

    // Switch to target bucket and select it
    activateNavBucket(idea.bucket);
    APP.state.selectedId = idea.id;
    await refreshUI();
  });

  // New idea buttons
  APP.ui.btnNewIdea.addEventListener("click", async () => {
    await createAndSelectIdea({ bucket: "parked", title: "New idea", ventureCategory: "Other" });
  });
  APP.ui.btnEmptyNew.addEventListener("click", async () => {
    await createAndSelectIdea({ bucket: "parked", title: "New idea", ventureCategory: "Other" });
  });

  // Help
  APP.ui.btnHelp.addEventListener("click", () => {
    APP.ui.helpOverlay.classList.remove("hidden");
  });
  APP.ui.btnHelpClose.addEventListener("click", () => {
    APP.ui.helpOverlay.classList.add("hidden");
  });
  APP.ui.helpOverlay.addEventListener("click", (e) => {
    if (e.target === APP.ui.helpOverlay) APP.ui.helpOverlay.classList.add("hidden");
  });

  // Drawer overlay closes detail on mobile
  APP.ui.drawerOverlay.addEventListener("click", () => ensureDetailOpenMobile(false));

  // View overlay close
  APP.ui.btnViewClose.addEventListener("click", () => {
    hideView();
  });
  APP.ui.viewOverlay.addEventListener("click", (e) => {
    if (e.target === APP.ui.viewOverlay) hideView();
  });

  // Dialog close by clicking backdrop
  APP.ui.dialogOverlay.addEventListener("click", (e) => {
    if (e.target === APP.ui.dialogOverlay) hideDialog();
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", async (e) => {
    if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // avoid when typing in inputs
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (["input","textarea","select"].includes(tag)) return;
      await createAndSelectIdea({ bucket: "parked", title: "New idea", ventureCategory: "Other" });
    }
    if (e.key === "Escape") {
      // close overlays
      APP.ui.helpOverlay.classList.add("hidden");
      hideDialog();
      hideView();
      ensureDetailOpenMobile(false);
    }
  });
}

// ---------- Daily Sweep ----------
function showDailySweep() {
  const { start, end } = todayBounds();
  const updatedToday = APP.state.ideas
    .filter(i => i.updatedAt >= start && i.updatedAt < end)
    .sort((a,b) => b.updatedAt - a.updatedAt);

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="muted">Ideas updated today (${updatedToday.length}). Quick re-bucket them to keep the vault clean.</div>
    <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px"></div>
  `;
  const list = wrap.querySelector("div[style*='flex-direction']");

  for (const i of updatedToday) {
    const row = document.createElement("div");
    row.style.border = "1px solid rgba(255,255,255,.10)";
    row.style.borderRadius = "14px";
    row.style.padding = "12px";
    row.style.background = "rgba(255,255,255,.02)";

    row.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div>
          <div style="font-weight:900">${escapeHtml(i.title || "(Untitled)")}</div>
          <div style="margin-top:6px;color:rgba(142,160,181,.95);font-size:12px">
            Bucket: <b>${escapeHtml(i.bucket)}</b> · Updated: ${fmtDate(i.updatedAt)}
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-ghost" data-act="active">Active</button>
          <button class="btn btn-ghost" data-act="parked">Parked</button>
          <button class="btn btn-ghost" data-act="long_term">Long-Term</button>
          <button class="btn btn-ghost" data-act="sparks">Sparks</button>
        </div>
      </div>
      <div style="margin-top:10px;color:rgba(234,241,255,.92)">${escapeHtml(clampText(i.description || i.keyNotes || "—", 220))}</div>
    `;

    row.querySelectorAll("button[data-act]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const to = btn.getAttribute("data-act");
        const idea = APP.state.ideas.find(x => x.id === i.id);
        if (!idea) return;
        idea.bucket = to;
        await saveIdea(idea, { skipActiveRuleCheck: false });
        await loadAllIdeas();
        showDailySweep(); // refresh view
        renderCounts(APP.state.ideas);
        renderIdeaList();
      });
    });

    list.appendChild(row);
  }

  showView("Daily Sweep", wrap);
}

// ---------- Export / Import ----------
async function getExportBundle({ includeImages=true, hardLimitBytes=25*1024*1024 } = {}) {
  const ideas = await IDB.getAll(APP.stores.ideas);
  const images = includeImages ? await IDB.getAll(APP.stores.images) : [];

  let imageMap = {};
  let approxBytes = 0;

  if (includeImages) {
    for (const img of images) {
      // Convert to base64 data URL (safe JSON embed)
      const dataUrl = await blobToDataUrl(img.blob);
      approxBytes += dataUrl.length;
      imageMap[img.id] = {
        id: img.id,
        ideaId: img.ideaId,
        filename: img.filename,
        type: img.type,
        createdAt: img.createdAt,
        dataUrl
      };

      if (approxBytes > hardLimitBytes) {
        return { tooLarge: true, approxBytes, ideas, imageMap: null };
      }
    }
  }

  return {
    tooLarge: false,
    approxBytes,
    bundle: {
      meta: {
        app: "Idea Vault",
        version: 1,
        exportedAt: now(),
        includeImages
      },
      ideas,
      images: includeImages ? Object.values(imageMap) : []
    }
  };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  // data:[<mime>];base64,<data>
  const [meta, b64] = dataUrl.split(",");
  const mime = (meta.match(/data:(.*?);base64/) || [])[1] || "application/octet-stream";
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i=0;i<len;i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function showExportImport() {
  const wrap = document.createElement("div");

  const reminder = await IDB.getSetting("autoExportReminder", true);

  wrap.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="muted">
        Backup your vault. Everything lives locally in your browser (IndexedDB). Export gives you a portable file.
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;margin-bottom:8px">Export</div>
        <div class="muted small" style="margin-bottom:10px">
          Full export includes images (bigger). Light export is ideas-only (smaller).
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary" id="btnExportFull">Full Export (with images)</button>
          <button class="btn btn-ghost" id="btnExportLight">Light Export (ideas only)</button>
          <button class="btn btn-ghost" id="btnExportImagesLoose">Download images (loose)</button>
        </div>
        <div class="muted small" id="exportHint" style="margin-top:10px"></div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;margin-bottom:8px">Import</div>
        <div class="muted small" style="margin-bottom:10px">
          Import a previously exported JSON. This will merge by ID; if IDs collide, imported version wins.
        </div>
        <input type="file" id="importPicker" accept="application/json" />
        <div class="muted small" id="importHint" style="margin-top:10px"></div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;margin-bottom:8px">Reminder</div>
        <label style="display:flex;align-items:center;gap:10px;margin:0">
          <input type="checkbox" id="autoExportToggle" ${reminder ? "checked" : ""} />
          <span class="muted">Show a gentle “export reminder” hint in Settings</span>
        </label>
      </div>
    </div>
  `;

  const hint = wrap.querySelector("#exportHint");
  const importHint = wrap.querySelector("#importHint");

  wrap.querySelector("#btnExportFull").addEventListener("click", async () => {
    hint.textContent = "Preparing full export…";
    const res = await getExportBundle({ includeImages:true, hardLimitBytes: 25*1024*1024 });
    if (res.tooLarge) {
      hint.textContent = `Too large for a single JSON (estimated image data > ${(res.approxBytes/1024/1024).toFixed(1)}MB). Use Light Export + Download images (loose).`;
      return;
    }
    const filename = `idea-vault-full-${new Date().toISOString().slice(0,10)}.json`;
    downloadJson(res.bundle, filename);
    hint.textContent = "Downloaded.";
  });

  wrap.querySelector("#btnExportLight").addEventListener("click", async () => {
    hint.textContent = "Preparing light export…";
    const ideas = await IDB.getAll(APP.stores.ideas);
    const bundle = {
      meta: { app:"Idea Vault", version:1, exportedAt: now(), includeImages:false },
      ideas,
      images: []
    };
    const filename = `idea-vault-light-${new Date().toISOString().slice(0,10)}.json`;
    downloadJson(bundle, filename);
    hint.textContent = "Downloaded.";
  });

  wrap.querySelector("#btnExportImagesLoose").addEventListener("click", async () => {
    hint.textContent = "Preparing image downloads…";
    const images = await IDB.getAll(APP.stores.images);
    if (!images.length) {
      hint.textContent = "No images stored.";
      return;
    }
    // Download each image as a file (loose). (No zip to keep zero-deps.)
    for (const img of images) {
      const url = URL.createObjectURL(img.blob);
      const a = document.createElement("a");
      a.href = url;
      const base = (img.filename || `image-${img.id}`).replace(/[^\w.\-]+/g, "_");
      a.download = `${img.ideaId}-${base}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      await new Promise(r => setTimeout(r, 120)); // small stagger
    }
    hint.textContent = "Downloaded images (loose).";
  });

  wrap.querySelector("#autoExportToggle").addEventListener("change", async (e) => {
    await IDB.setSetting("autoExportReminder", !!e.target.checked);
  });

  wrap.querySelector("#importPicker").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      importHint.textContent = "Reading file…";
      const txt = await file.text();
      const data = JSON.parse(txt);

      if (!data || !Array.isArray(data.ideas) || !Array.isArray(data.images)) {
        importHint.textContent = "Invalid export format.";
        return;
      }

      // Put ideas
      for (const idea of data.ideas) {
        await IDB.put(APP.stores.ideas, { ...newIdea(), ...idea });
      }

      // Put images
      for (const img of data.images) {
        if (!img.dataUrl) continue;
        const blob = dataUrlToBlob(img.dataUrl);
        await IDB.put(APP.stores.images, {
          id: img.id,
          ideaId: img.ideaId,
          blob,
          filename: img.filename,
          type: img.type,
          createdAt: img.createdAt || now()
        });
      }

      // Active enforcement sanity: if import creates multiple actives, keep the most recently updated as active, demote others to parked
      const all = await IDB.getAllByIndex(APP.stores.ideas, "bucket", "active");
      if (all.length > 1) {
        all.sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));
        const keep = all[0];
        for (let i=1;i<all.length;i++) {
          all[i].bucket = "parked";
          all[i].updatedAt = now();
          await IDB.put(APP.stores.ideas, all[i]);
        }
        // keep remains active
        await IDB.put(APP.stores.ideas, keep);
      }

      await loadAllIdeas();
      await refreshUI();
      importHint.textContent = "Import complete.";
    } catch (err) {
      importHint.textContent = "Import failed: " + (err?.message || String(err));
    } finally {
      e.target.value = "";
    }
  });

  showView("Export / Import", wrap);
}

// ---------- Settings ----------
async function estimateStorageUsage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

async function updateStorageUI() {
  const est = await estimateStorageUsage();
  if (!est) {
    APP.ui.storageUsage.textContent = "Storage: —";
    return;
  }
  const used = est.usage || 0;
  const quota = est.quota || 0;
  const usedMB = used / 1024 / 1024;
  const quotaMB = quota / 1024 / 1024;
  APP.ui.storageUsage.textContent = `Storage: ${usedMB.toFixed(1)}MB / ${quotaMB.toFixed(0)}MB`;
}

async function showSettings() {
  const wrap = document.createElement("div");
  const reminder = await IDB.getSetting("autoExportReminder", true);

  wrap.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;margin-bottom:8px">Safety</div>
        <div class="muted small" style="margin-bottom:10px">
          Reset clears <b>everything</b> in IndexedDB (ideas + images + settings).
        </div>
        <button class="btn btn-danger" id="btnReset">Reset Vault</button>
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;margin-bottom:8px">Offline</div>
        <div class="muted small" id="offlineState"></div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;margin-bottom:8px">Export reminder</div>
        <div class="muted small">
          ${reminder ? "Reminder is ON. Consider exporting weekly or before big changes." : "Reminder is OFF."}
        </div>
      </div>
    </div>
  `;

  const off = wrap.querySelector("#offlineState");
  off.textContent = navigator.onLine
    ? "You are online. App is still offline-capable after first load."
    : "You are offline. App should continue working if previously loaded.";

  wrap.querySelector("#btnReset").addEventListener("click", async () => {
    showDialog({
      title: "Reset Vault",
      body: `<div style="color:rgba(234,241,255,.92);line-height:1.5">
        This will permanently clear <b>all ideas</b>, <b>all images</b>, and <b>settings</b> from this device/browser.
        <div style="margin-top:10px" class="muted small">Tip: Export first.</div>
      </div>`,
      actions: [
        { label: "Cancel", kind: "btn-ghost", onClick: () => {} },
        { label: "Reset", kind: "btn-danger", onClick: async () => {
          await IDB.clear(APP.stores.images);
          await IDB.clear(APP.stores.ideas);
          await IDB.clear(APP.stores.settings);
          APP.state.selectedId = null;
          await loadAllIdeas();
          await refreshUI();
          await updateStorageUI();
        }}
      ]
    });
  });

  showView("Settings", wrap);
}

// ---------- Boot ----------
function bindUIRefs() {
  APP.ui = {
    // Top
    btnNewIdea: $("#btnNewIdea"),
    btnHelp: $("#btnHelp"),
    saveStatus: $("#saveStatus"),

    // Sidebar counts
    countActive: $("#countActive"),
    countParked: $("#countParked"),
    countLong: $("#countLong"),
    countSparks: $("#countSparks"),
    offlineIndicator: $("#offlineIndicator"),
    storageUsage: $("#storageUsage"),

    // List panel
    panelTitle: $("#panelTitle"),
    ideaList: $("#ideaList"),
    emptyState: $("#emptyState"),
    btnEmptyNew: $("#btnEmptyNew"),

    searchInput: $("#searchInput"),
    btnClearSearch: $("#btnClearSearch"),
    filterVenture: $("#filterVenture"),
    filterPriority: $("#filterPriority"),
    filterTag: $("#filterTag"),
    sortSelect: $("#sortSelect"),

    btnQuickDumpToggle: $("#btnQuickDumpToggle"),
    quickDump: $("#quickDump"),
    qdTitle: $("#qdTitle"),
    qdNotes: $("#qdNotes"),
    qdBucket: $("#qdBucket"),
    btnQuickAdd: $("#btnQuickAdd"),

    // Detail panel
    detailPanel: $("#detailPanel"),
    detailEmpty: $("#detailEmpty"),
    ideaForm: $("#ideaForm"),
    tagInput: $("#tagInput"),
    tagChips: $("#tagChips"),
    linksList: $("#linksList"),
    btnAddLink: $("#btnAddLink"),
    imagePicker: $("#imagePicker"),
    imageGrid: $("#imageGrid"),

    btnPromote: $("#btnPromote"),
    btnParkActive: $("#btnParkActive"),
    btnDelete: $("#btnDelete"),

    // overlays
    drawerOverlay: $("#drawerOverlay"),
    dialogOverlay: $("#dialogOverlay"),
    helpOverlay: $("#helpOverlay"),
    btnHelpClose: $("#btnHelpClose"),
    viewOverlay: $("#viewOverlay"),
    btnViewClose: $("#btnViewClose")
  };
}

async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  } catch (e) {
    // If SW fails, app still works online but not offline-first
    console.warn("Service worker registration failed:", e);
  }
}

function watchOnline() {
  function update() {
    if (navigator.onLine) {
      APP.ui.offlineIndicator.textContent = "Offline-ready";
      setSaveStatus("ok", "Saved");
    } else {
      APP.ui.offlineIndicator.textContent = "Offline";
      setSaveStatus("offline", "Saved (offline)");
    }
  }
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

async function maybeShowExportReminderInSettings() {
  const reminder = await IDB.getSetting("autoExportReminder", true);
  if (!reminder) return;
  // lightweight: just a subtle hint in console + status pill timing
  // (No notifications / no nagging modals.)
}

async function init() {
  bindUIRefs();
  await IDB.open();
  await registerSW();
  watchOnline();

  bindNav();
  bindForm();

  // Load data
  await loadAllIdeas();

  // If nothing exists, create a clean starter idea so the UI feels alive (Parked).
  if (!APP.state.ideas.length) {
    const starter = newIdea({
      bucket: "parked",
      title: "Welcome: dump ideas here",
      ventureCategory: "Other",
      description: "Use Quick Dump or New Idea. Keep ONE Active Project. Everything else goes Parked/Long-Term/Sparks.",
      status: "ready",
      priority: "low",
      nextAction: "Add your first real idea."
    });
    await saveIdea(starter, { skipActiveRuleCheck: true });
    await loadAllIdeas();
  }

  // Default bucket view: active
  activateNavBucket("active");

  // Auto-select active if exists, else nothing selected
  const active = await getActiveIdea();
  if (active) APP.state.selectedId = active.id;

  await refreshUI();
  await updateStorageUI();
  await maybeShowExportReminderInSettings();

  // Keep storage usage updated occasionally
  setInterval(updateStorageUI, 15000);
}

// Start
init();
