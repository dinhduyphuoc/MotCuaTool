chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (cfg) => {
    const defaults = {
      MOD: 4,
      RESIDUE: 0,
      // Ô “Mã hồ sơ” trên trang bạn gửi (jf-ext-cache-id="10")
      XPATH: '//*[@id="app_user_profile"]//input[@jf-ext-cache-id="10"]',
      // Nút lưu: “Lưu lại”
      submitSelector: 'button[jf-ext-button-ct="lưu lại"]',
      // Regex nhận diện thông báo lỗi trùng mã (có thể thêm|bớt)
      errorTextRegex: "đã được sử dụng|đã tồn tại|trùng|duplicate|already used|already exists",
      autoResubmit: true,
      // Bảng trong dialog “Danh sách mã hồ sơ” – cột 3 là Mã hồ sơ
      tableSelector: 'div.v-card__text table tbody tr'
    };
    chrome.storage.sync.set(Object.assign({}, defaults, cfg));
  });
});
