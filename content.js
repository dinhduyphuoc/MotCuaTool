// ========================= MotCuaTool — ONLY from server latest =========================
(() => {
  // ---------- GUARD ----------
  if (!window.__MCT__) window.__MCT__ = {};
  if (window.__MCT__.booted) return;
  window.__MCT__.booted = true;

  // ---------- CONFIG ----------
  const CFG = {
    MOD: 4,
    RESIDUE: 0,
    XPATH: "",
    submitSelector: "button[jf-ext-button-ct='lưu lại'], button[jf-ext-button-ct='lưu lại']",
    errorTextRegex: "(mã hồ sơ|đã được sử dụng|trùng)",
    autoResubmit: true,
    redirectAfterSave: false,
    precomputeBeforeSubmit: true,
    allowLocalFallback: false,
  };
  const REDIRECT_URL = "https://motcua.mod.gov.vn/web/mot-cua-bo-quoc-phong/qlkdl#/all/them-moi-giay-to";

  // ---------- RUNTIME STATE ----------
  window.__MCT__.PAGE_CTX = window.__MCT__.PAGE_CTX || { token:"", groupId:"", companyId:"" };
  window.__MCT__.latestCache = window.__MCT__.latestCache || { value:null, ts:0, inflight:null };
  window.__MCT__.pos = window.__MCT__.pos || null;
  if (!window.__MCT__.applyGuard) window.__MCT__.applyGuard = { to:"", ts:0 };
  const APPLY_WINDOW = 1000; // ms

  // ---------- STORAGE ----------
  function loadCfg(){
    return new Promise(res => chrome.storage.sync.get(null, d => { Object.assign(CFG, d||{}); res(CFG); }));
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    Object.keys(changes).forEach(k => CFG[k] = changes[k].newValue);
    try { updatePanelHeader(); syncCheckboxes(); } catch {}
  });

  // ---------- UTILS ----------
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
  function waitFor(fnOrSel, timeout=15000, interval=200){
    const t0 = Date.now();
    return new Promise(async (resolve,reject)=>{
      while (Date.now()-t0 < timeout){
        try{
          const el = (typeof fnOrSel==="string") ? document.querySelector(fnOrSel) : fnOrSel();
          if (el) return resolve(el);
        }catch{}
        await sleep(interval);
      }
      reject(new Error("waitFor timeout"));
    });
  }
  function findByXPaths(xps){
    for (const xp of xps){
      try{
        const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (el) return el;
      }catch{}
    }
    return null;
  }

  // ---------- NUMBERING ----------
  const parseXXXX = (code)=> {
    const m = String(code||"").match(/(\d+)\s*$/);
    return m ? parseInt(m[1],10) : 0;
  };
  const replaceXXXX = (fullCode,newXXXX)=>
    String(fullCode||"").replace(/(\d+)\s*$/, String(newXXXX).padStart(4,"0"));

  // 🔁 CHỈ SỬA HÀM NÀY
  function nextByMod(x, mod, residue){
    // trả về số nhỏ nhất y > x sao cho y ≡ residue (mod mod)
    if (!Number.isFinite(x)) x = 0;
    if (!Number.isFinite(mod) || mod < 1) mod = 1;
    if (!Number.isFinite(residue)) residue = 0;

    // chuẩn hóa residue về [0, mod-1]
    residue = ((residue % mod) + mod) % mod;

    // k = floor((x - residue)/mod) + 1  => y = k*mod + residue  (> x và đúng residue)
    const k = Math.floor((x - residue) / mod) + 1;
    return k * mod + residue;
  }
  // ---------- /NUMBERING ----------

  // ---------- INPUT FIELD ----------
  function getCodeInput(){
    const defaults = [
      "//*[@id='app_user_profile']/div[11]/main/div/div/div[2]/form/div[3]/div[2]/div[2]/div/div[2]/div/div/input",
      "//*[@id='app_user_profile']/div[11]/main/div/div/div[2]/form/div[4]/div[2]/div[2]/div/div[1]/div/input",
      "//input[@jf-ext-cache-id='10']"
    ];
    const xps = (CFG.XPATH && CFG.XPATH.trim()) ? [CFG.XPATH.trim(), ...defaults] : defaults;
    const el = findByXPaths(xps);
    return (el && el.tagName === "INPUT") ? el : null;
  }

  // ---------- PANEL UI ----------
  let panel, header, bodyWrap, btnMin, lblLatest, lblUpdated, cbRedirect, cbPrecompute, btnUpdate; // FIX: khai báo btnUpdate
  function applySavedPos(box){
    const pos = window.__MCT__.pos; if (!pos) return;
    Object.assign(box.style, { left:pos.left, top:pos.top, right:"auto", position:"fixed" });
  }
  function buildPanel(){
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "mct-panel";
    Object.assign(panel.style, {
      position:"fixed", top:"12px", right:"12px", zIndex:2147483647,
      background:"#111", color:"#fff", padding:"10px 12px",
      borderRadius:"10px", boxShadow:"0 10px 30px rgba(0,0,0,.35)",
      width:"320px", font:"13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      userSelect:"none"
    });
    panel.innerHTML = `
      <div id="mct-header" style="display:flex;align-items:center;justify-content:space-between;font-weight:700;margin-bottom:6px;cursor:move">
        <span>MotCuaTool by Duy Phước</span>
        <button id="mct-min" title="Thu gọn / Mở rộng" style="cursor:pointer;border:none;background:#222;color:#fff;padding:2px 8px;border-radius:6px;font-weight:700">–</button>
      </div>

      <div id="mct-body">
        <div id="mct-sub" style="opacity:.85;margin-bottom:6px"></div>

        <div class="mct-row">
          <span class="mct-label">Mới nhất:</span>
          <code id="mct-latest" class="mct-pill mct-pill-warn">-</code>
        </div>
        <div class="mct-row">
          <span class="mct-label">Đã cập nhật:</span>
          <code id="mct-updated" class="mct-pill mct-pill-ok">-</code>
        </div>

        <div style="margin-top:8px;display:flex;gap:10px">
          <button id="mct-step" class="mct-btn">Cập nhật</button>
        </div>

        <div style="margin-top:10px;padding-top:8px;border-top:1px dashed #444;display:grid;gap:6px">
          <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
            <input id="mct-cb-redirect" type="checkbox" />
            <span>Sau khi “Lưu lại” → Redirect về danh sách</span>
          </label>
          <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
            <input id="mct-cb-precompute" type="checkbox" />
            <span>Tự cập nhật mã hồ sơ ngay trước khi lưu</span>
          </label>
        </div>
      </div>
    `;
    const styleEl = document.createElement("style");
    styleEl.textContent = `
      .mct-btn{flex:1;background:#2563eb;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-weight:600;font-size:13px;transition:background .2s,transform .1s}
      .mct-btn:hover{background:#1d4ed8}.mct-btn:active{transform:scale(.96)}

      .mct-row{display:flex;align-items:center;gap:8px;margin:4px 0;flex-wrap:nowrap}
      .mct-label{min-width:90px;color:#e5e7eb}
      .mct-pill{padding:2px 8px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}
      .mct-pill-warn{background:#fff3cd;color:#7a5500}
      .mct-pill-ok{background:#d1e7dd;color:#0a3622}
    `;
    panel.appendChild(styleEl);
    document.body.appendChild(panel);

    header       = panel.querySelector("#mct-header");
    bodyWrap     = panel.querySelector("#mct-body");
    btnMin       = panel.querySelector("#mct-min");
    lblLatest    = panel.querySelector("#mct-latest");
    lblUpdated   = panel.querySelector("#mct-updated");
    cbRedirect   = panel.querySelector("#mct-cb-redirect");
    cbPrecompute = panel.querySelector("#mct-cb-precompute");
    btnUpdate    = panel.querySelector("#mct-step");

    applySavedPos(panel);

    btnMin.addEventListener("click", (e)=>{
      e.stopPropagation();
      const hidden = bodyWrap.style.display === "none";
      bodyWrap.style.display = hidden ? "" : "none";
      btnMin.textContent = hidden ? "–" : "+";
    });

    btnUpdate.addEventListener("click", async ()=>{
      btnUpdate.disabled = true;
      btnUpdate.textContent = "Đang cập nhật...";
      try { await applyLatestToField(true); } catch {}
      btnUpdate.textContent = "Cập nhật";
      btnUpdate.disabled = false;
    });

    cbRedirect.checked = !!CFG.redirectAfterSave;
    cbPrecompute.checked = !!CFG.precomputeBeforeSubmit;
    cbRedirect.addEventListener("change", ()=> chrome.storage.sync.set({ redirectAfterSave: !!cbRedirect.checked }));
    cbPrecompute.addEventListener("change", ()=> chrome.storage.sync.set({ precomputeBeforeSubmit: !!cbPrecompute.checked }));

    updatePanelHeader();
    makeDraggable(panel, header);
    return panel;
  }
  function updatePanelHeader(){
    const sub = panel?.querySelector("#mct-sub"); if (!sub) return;
    sub.textContent = `MOD=${CFG.MOD}, Residue=${CFG.RESIDUE} | AutoSubmit:${CFG.autoResubmit?'ON':'OFF'} | Redirect:${CFG.redirectAfterSave?'ON':'OFF'} | PreSubmit:${CFG.precomputeBeforeSubmit?'ON':'OFF'}`;
  }
  function syncCheckboxes(){
    if (cbRedirect)   cbRedirect.checked   = !!CFG.redirectAfterSave;
    if (cbPrecompute) cbPrecompute.checked = !!CFG.precomputeBeforeSubmit;
  }
  function makeDraggable(box, handle){
    let isDown = false, relX=0, relY=0;
    handle.style.cursor = "move";
    handle.addEventListener("mousedown", (e)=>{
      const minBtn = box.querySelector("#mct-min");
      if (minBtn && (e.target === minBtn || minBtn.contains(e.target))) return;

      if (e.button !== 0) return;
      isDown = true;
      const r = box.getBoundingClientRect();
      relX = e.clientX - r.left;
      relY = e.clientY - r.top;
      Object.assign(box.style, { right:"auto", position:"fixed" });
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener("mousemove", (e)=>{
      if (!isDown) return;
      box.style.left = (e.clientX - relX) + "px";
      box.style.top  = (e.clientY - relY) + "px";
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener("mouseup", (e)=>{
      if (e.button !== 0) return;
      if (isDown){
        isDown = false;
        window.__MCT__.pos = { left:box.style.left, top:box.style.top };
        chrome.storage.sync.set({ panelPos: window.__MCT__.pos });
        e.preventDefault(); e.stopPropagation();
      }
    });
  }

  function setLabels(latest, updated){
    if (lblLatest)  lblLatest.textContent  = latest  || "-";
    if (lblUpdated) lblUpdated.textContent = updated || "-";
  }

  // ---------- SERVER CTX + API ----------
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("injected.js");
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch(e){ console.warn("[MCT] inject failed:", e); }

  addEventListener("message", (ev)=>{
    if (ev?.data?.type !== "MCT_PAGE_CONTEXT") return;
    window.__MCT__.PAGE_CTX = ev.data.payload || window.__MCT__.PAGE_CTX;
  });

  async function callSuggest({ token, groupId, companyId }){
    const res = await fetch(`/o/rest/v2/filestoregov/suggest-dossierno`, {
      method: "GET",
      credentials: "include",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "Token": token || "",
        "Groupid": groupId || "",
        ...(companyId ? { "CompanyId": companyId } : {}),
      }
    });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok){
      const body = ct.includes("application/json") ? await res.json().catch(()=>null) : await res.text().catch(()=> "");
      throw new Error(`HTTP ${res.status} ${res.statusText} | Body: ${
        typeof body === "string" ? body.slice(0,200) : JSON.stringify(body).slice(0,200)
      }`);
    }
    if (!ct.includes("application/json")){
      const html = await res.text().catch(()=> "");
      throw new Error(`Unexpected content-type: ${ct} | Body: ${html.slice(0,200)}`);
    }
    return res.json();
  }
  function waitPageCtx(timeout=2000){
    const t0 = Date.now();
    return new Promise((resolve,reject)=>{
      if (window.__MCT__.PAGE_CTX?.groupId && window.__MCT__.PAGE_CTX?.token) return resolve(window.__MCT__.PAGE_CTX);
      (function poll(){
        const c = window.__MCT__.PAGE_CTX;
        if (c?.groupId && c?.token) return resolve(c);
        if (Date.now()-t0 > timeout) return reject(new Error("Timeout PAGE_CTX"));
        setTimeout(poll, 100);
      })();
    });
  }
  async function MCT_getServerLatest(force=false){
    const cache = window.__MCT__.latestCache;
    const now = Date.now();
    if (!force && cache.value && now-cache.ts < 5000) return cache.value;
    if (cache.inflight) return cache.inflight;
    const run = (async ()=>{
      const ctx = await waitPageCtx();
      const data = await callSuggest(ctx);
      const latest = data?.generateDossierNo || "";
      if (!latest) throw new Error("Không nhận được generateDossierNo");
      cache.value = latest; cache.ts = Date.now(); cache.inflight = null;
      return latest;
    })();
    cache.inflight = run;
    try { return await run; } finally { cache.inflight = null; }
  }

  // ---------- SINGLE SOURCE OF TRUTH ----------
  function safeApplyToInput(latest, mod, residue){
    const input = getCodeInput(); if (!input) return false;
    const now = Date.now();

    const cur = parseXXXX(latest);
    const next = nextByMod(cur, mod, residue);
    const newVal = replaceXXXX(latest, next);

    if (input.value.trim() === newVal) { setLabels(latest, newVal); return false; }
    if (window.__MCT__.applyGuard.to === newVal && (now - window.__MCT__.applyGuard.ts) < APPLY_WINDOW) {
      setLabels(latest, newVal); return false;
    }
    input.value = newVal;
    window.__MCT__.applyGuard = { to:newVal, ts:now };
    setLabels(latest, newVal);
    return true;
  }
  async function applyLatestToField(force=false){
    const latest = await MCT_getServerLatest(force);
    safeApplyToInput(latest, CFG.MOD, CFG.RESIDUE);
  }

  // ---------- ROUTER / RENDER / SUBMIT / TOAST ----------
  const ensureDebounced = debounce(async ()=>{
    try { await applyLatestToField(false); }
    catch (e) {
      if (CFG.allowLocalFallback){
        const input = getCodeInput(); if (!input) return;
        const base = (input.value || "").trim();
        const updated = replaceXXXX(base, nextByMod(parseXXXX(base), CFG.MOD, CFG.RESIDUE));
        input.value = updated;
        setLabels(base, updated);
      }
    }
  }, 200);

  (function hookHistoryAndHash(){
    addEventListener("hashchange", ensureDebounced);
    const _ps = history.pushState, _rs = history.replaceState;
    history.pushState = function(){ const r=_ps.apply(this,arguments); ensureDebounced(); return r; };
    history.replaceState = function(){ const r=_rs.apply(this,arguments); ensureDebounced(); return r; };
  })();

  function startFormObserver(){
    if (startFormObserver.started) return; startFormObserver.started = true;
    const root = document.getElementById("app_user_profile") || document.body;
    new MutationObserver(()=>{ if (getCodeInput()) ensureDebounced(); })
      .observe(root,{ childList:true, subtree:true });
  }

  function findSubmitButton(){
    const byCfg = Array.from(document.querySelectorAll(CFG.submitSelector || ""))
      .find(b => b && b.offsetParent !== null);
    if (byCfg) return byCfg;
    return Array.from(document.querySelectorAll("button,[role='button']"))
      .find(b => /lưu lại/i.test(b.textContent || ""));
  }
  const clickSubmit = ()=> findSubmitButton()?.click();

  if (!window.__MCT__.redirectTimer) window.__MCT__.redirectTimer = null;
  function armRedirectAfterSave(){
    if (!CFG.redirectAfterSave) return;
    if (window.__MCT__.redirectTimer){ clearTimeout(window.__MCT__.redirectTimer); window.__MCT__.redirectTimer = null; }
    window.__MCT__.redirectTimer = setTimeout(()=>{
      window.__MCT__.redirectTimer = null;
      location.assign(REDIRECT_URL);
    }, 2500);
  }

  async function hookSubmitButton(){
    try{
      const btn = await waitFor(()=>findSubmitButton(), 15000, 200);
      if (btn && !btn.__mctHooked){
        btn.__mctHooked = true;
        btn.addEventListener("click", async ()=>{
          if (CFG.precomputeBeforeSubmit){
            try { await applyLatestToField(false); } catch (e) {
              if (CFG.allowLocalFallback){
                const input = getCodeInput(); if (input){
                  const base = (input.value || "").trim();
                  const updated = replaceXXXX(base, nextByMod(parseXXXX(base), CFG.MOD, CFG.RESIDUE));
                  input.value = updated;
                  setLabels(base, updated);
                }
              }
            }
          }
          armRedirectAfterSave();
        }, true);
      }
    }catch{}
  }
  function keepHookingSubmit(){ hookSubmitButton(); setInterval(()=>hookSubmitButton(), 2000); }

  function startToastObserver(){
    if (startToastObserver.started) return; startToastObserver.started = true;
    const re = new RegExp(CFG.errorTextRegex || "(mã hồ sơ|đã được sử dụng|trùng)", "i");
    const obs = new MutationObserver((muts)=>{
      for (const m of muts) for (const node of m.addedNodes){
        if (!(node instanceof HTMLElement)) continue;
        const t = node.textContent?.trim() || "";
        if (!t || !re.test(t)) continue;

        (async ()=>{
          try { await applyLatestToField(true); }
          catch {
            if (CFG.allowLocalFallback){
              const input = getCodeInput(); if (!input) return;
              const base = (input.value || "").trim();
              const updated = replaceXXXX(base, nextByMod(parseXXXX(base), CFG.MOD, CFG.RESIDUE));
              input.value = updated; setLabels(base, updated);
            }
          }
          if (CFG.autoResubmit){ setTimeout(()=>{ clickSubmit(); armRedirectAfterSave(); }, 200); }
        })();
      }
    });
    obs.observe(document.body, { childList:true, subtree:true });
  }

  // ---------- BOOTSTRAP ----------
  (async function bootstrap(){
    await loadCfg();
    buildPanel();
    startFormObserver();
    startToastObserver();
    ensureDebounced();
    keepHookingSubmit();
  })();
})();
