(() => {
  const els = {};
  const DEF = {
    MOD: 4,
    RESIDUE: 0,
    XPATH: "",
    submitSelector: "button[jf-ext-button-ct='lưu lại'], button[jf-ext-button-ct='lưu lại']",
    errorTextRegex: "(mã hồ sơ|đã được sử dụng|trùng)",
    tableSelector: "div.v-card__text table tbody tr",
    autoResubmit: true,
    redirectAfterSave: false
  };

  function $(id) { return document.getElementById(id); }

  function restore() {
    chrome.storage.sync.get(null, (cfg) => {
      const data = Object.assign({}, DEF, cfg || {});
      els.MOD.value = data.MOD;
      els.RESIDUE.value = data.RESIDUE;
      els.XPATH.value = data.XPATH;
      els.submitSelector.value = data.submitSelector;
      els.errorTextRegex.value = data.errorTextRegex;
      els.tableSelector.value = data.tableSelector;
      els.autoResubmit.checked = !!data.autoResubmit;
      els.redirectAfterSave.checked = !!data.redirectAfterSave;
    });
  }

  function save() {
    const mod = Number(els.MOD.value || 4);
    const residue = Number(els.RESIDUE.value || 0);
    if (!Number.isFinite(mod) || mod < 1) return setStatus("MOD không hợp lệ (>=1).", true);
    if (!Number.isFinite(residue) || residue < 0 || residue >= mod)
      return setStatus("Residue phải trong [0..MOD-1].", true);

    const payload = {
      MOD: mod,
      RESIDUE: residue,
      XPATH: (els.XPATH.value || "").trim(),
      submitSelector: (els.submitSelector.value || "").trim(),
      errorTextRegex: (els.errorTextRegex.value || "").trim(),
      tableSelector: (els.tableSelector.value || "").trim(),
      autoResubmit: !!els.autoResubmit.checked,
      redirectAfterSave: !!els.redirectAfterSave.checked
    };

    chrome.storage.sync.set(payload, () => {
      if (chrome.runtime.lastError) setStatus("Lỗi lưu: " + chrome.runtime.lastError.message, true);
      else setStatus("Đã lưu ✔", false);
    });
  }

  let clearTimer;
  function setStatus(msg, isErr) {
    els.status.textContent = msg;
    els.status.className = isErr ? "err" : "ok";
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => (els.status.textContent = "", els.status.className = ""), 2200);
  }

  document.addEventListener("DOMContentLoaded", () => {
    els.MOD = $("MOD");
    els.RESIDUE = $("RESIDUE");
    els.XPATH = $("XPATH");
    els.submitSelector = $("submitSelector");
    els.errorTextRegex = $("errorTextRegex");
    els.tableSelector = $("tableSelector");
    els.autoResubmit = $("autoResubmit");
    els.redirectAfterSave = $("redirectAfterSave");
    els.save = $("save");
    els.status = $("status");
    els.save.addEventListener("click", save);
    restore();
  });
})();
