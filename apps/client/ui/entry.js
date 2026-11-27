const invoke = window.__TAURI__.core.invoke;
invoke("mac_storage_available")
  .then(async (mac) => {
    if (mac) await (await import("./mac.js")).start();
    else await import("./app.js");
  })
  .catch((error) => {
    document.getElementById("status").textContent = String(error);
  });
