const invoke = window.__TAURI__.core.invoke;
invoke("account_storage_available")
  .then(async (supported) => {
    if (supported) await (await import("./desktop-storage.js")).start();
    else await import("./app.js");
  })
  .catch((error) => {
    document.getElementById("status").textContent = String(error);
  });
