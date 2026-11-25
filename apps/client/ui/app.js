const byId = (id) => document.getElementById(id);
const invoke = window.__TAURI__.core.invoke;
let android = false,
  background = false;
const mobile = (action, payload = {}) =>
  invoke("mobile_control", { action, payload });
let refreshToken = "",
  expires = 0;
let token = "",
  busy = false;
const status = (s) => {
  byId("status").textContent = s;
};
byId("origin").value = localStorage.getItem("origin") || byId("origin").value;
function restoreFolder() {
  byId("root").value =
    localStorage.getItem("folder:" + byId("vault").value) || "";
}
byId("vault").onchange = () => {
  restoreFolder();
  byId("diagnostic").textContent = lastReport();
};
const reportKey = () =>
  "sync-report:" +
  JSON.stringify([byId("origin").value.trim(), byId("vault").value]);
const lastReport = () => localStorage.getItem(reportKey()) || "尚无同步记录";
function toggleSettings(on) {
  byId("login").hidden = on;
  byId("settings").hidden = !on;
  byId("device-panel").hidden = !on;
  byId("device-list").replaceChildren();
  byId("diagnostic").textContent = on ? lastReport() : "";
}
function backgroundMode(on) {
  background = on;
  byId("background").checked = on;
  byId("vault").disabled = on;
}
async function initialize() {
  android = await invoke("is_android");
  const recent = await invoke("recent_notebook");
  if (recent) {
    localStorage.setItem("last-notebook", recent.vault);
    byId("open-editor").hidden = false;
    if (!localStorage.getItem("origin")) byId("origin").value = recent.origin;
  }
  if (!android) return;
  document.documentElement.classList.add("android-client");
  byId("heading").textContent = "笔记同步";
  byId("open-editor").textContent = "打开笔记";
  byId("heading").after(byId("open-editor"));
  byId("folder-label").hidden = true;
  byId("root").required = false;
  byId("background-label").hidden = false;
  const session = await mobile("restore");
  if (session?.vault) {
    byId("vault").replaceChildren(new Option(session.name, session.vault));
    byId("origin").value = session.origin;
    localStorage.setItem("origin", session.origin);
    localStorage.setItem("last-notebook", session.vault);
    byId("open-editor").hidden = false;
    token = session.token;
    refreshToken = session.refresh;
    expires = session.expires;
    backgroundMode(true);
    toggleSettings(true);
    byId("diagnostic").textContent = session.diagnostic || lastReport();
  }
}
const initialized = initialize().catch((e) => status(String(e)));
function network() {
  byId("network").hidden = navigator.onLine;
  if (navigator.onLine && byId("auto").checked) sync();
}
window.addEventListener("online", network);
window.addEventListener("offline", network);
network();
byId("login").onsubmit = async (event) => {
  event.preventDefault();
  await initialized;
  if (busy) return;
  busy = true;
  try {
    const origin = byId("origin").value.trim();
    const session = await invoke("login", {
      origin,
      email: byId("email").value,
      password: byId("password").value,
    });

    token = session.token;
    refreshToken = session.refresh;
    expires = Date.parse(session.expires);
    localStorage.setItem("origin", origin);
    byId("password").value = "";
    byId("vault").replaceChildren(
      ...session.vaults.map((v) => new Option(v.name, v.id)),
    );
    toggleSettings(true);
    restoreFolder();
    status(
      session.vaults.length
        ? ""
        : "请先在网页创建笔记库，再返回这里同步。",
    );
  } catch (error) {
    status(String(error));
  } finally {
    busy = false;
  }
};
async function sync() {
  if (
    !navigator.onLine ||
    busy ||
    !token ||
    !byId("vault").value ||
    !byId("settings").reportValidity()
  )
    return;
  busy = true;
  const vault = byId("vault").value,
    root = byId("root").value;
  byId("vault").disabled = true;
  status("正在同步…");
  try {
    await access();
    const result = await invoke("sync", {
      origin: byId("origin").value.trim(),
      token,
      vault,
      root,
    });
    localStorage.setItem("folder:" + vault, root);
    localStorage.setItem("last-notebook", vault);
    byId("open-editor").hidden = false;
    const report =
      `上次同步 ${new Date().toLocaleTimeString()} · 上传 ${result.uploaded} · 下载 ${result.downloaded}` +
      (result.conflicts.length
        ? "\n已保留冲突副本\n" + result.conflicts.join("\n")
        : "") +
      ` · 版本 ${result.revision}`;
    status(report);
    localStorage.setItem(reportKey(), report);
    localStorage.setItem(reportKey() + ":device", result.device_id);
    byId("diagnostic").textContent = report;
  } catch (error) {
    status(String(error));
    byId("diagnostic").textContent = String(error) + "\n" + lastReport();
    return false;
  } finally {
    byId("vault").disabled = background;
    busy = false;
  }
}
byId("settings").onsubmit = (event) => {
  event.preventDefault();
  sync();
};
byId("logout").onclick = async () => {
  if (busy) return;
  if (background) {
    try {
      const s = await mobile("disable");
      token = s.token;
      backgroundMode(false);
    } catch (e) {
      status(String(e));
      return;
    }
  }
  void invoke("logout", { origin: byId("origin").value.trim(), token }).catch(
    () => {},
  );
  token = "";
  refreshToken = "";
  toggleSettings(false);
  byId("auto").checked = false;
  byId("login").hidden = false;
  status("");
};
setInterval(() => {
  if (byId("auto").checked) sync();
}, 15000);

byId("open-editor").hidden = !localStorage.getItem("last-notebook");
let renewal;
async function access() {
  if (background) {
    const s = await mobile("access");
    token = s.token;
    refreshToken = s.refresh;
    expires = s.expires;
    return token;
  }
  if (!token) throw Error("请登录笔记库以访问在线资源");
  if (Date.now() + 60000 < expires) return token;
  if (!renewal) {
    const original = refreshToken;
    renewal = invoke("refresh", {
      origin: byId("origin").value.trim(),
      token: original,
    })
      .then((s) => {
        if (refreshToken !== original) throw Error("账户已切换");
        token = s.access_token;
        refreshToken = s.refresh_token;
        expires = Date.parse(s.expires_at);
        return token;
      })
      .finally(() => {
        renewal = undefined;
      });
  }
  return renewal;
}
byId("open-editor").onclick = () => {
  const vault = token
    ? byId("vault").value
    : localStorage.getItem("last-notebook");
  window.dispatchEvent(
    new CustomEvent("open-notebook", {
      detail: {
        vault,
        android,
        access: async () => {
          if (vault !== byId("vault").value)
            throw Error("请登录这个笔记库以访问在线资源");
          return access();
        },
      },
    }),
  );
};

byId("background").onchange = async () => {
  const enable = byId("background").checked;
  backgroundMode(background);
  if (busy) return;
  if (enable) {
    const vault = byId("vault").value;
    if (
      !navigator.onLine ||
      (await sync()) === false ||
      localStorage.getItem("last-notebook") !== vault
    )
      return;
  }
  busy = true;
  try {
    if (enable) {
      await mobile("enable", {
        vault: byId("vault").value,
        name: byId("vault").selectedOptions[0].text,
        origin: byId("origin").value.trim(),
        token,
        refresh: refreshToken,
        expires,
      });
    } else {
      const s = await mobile("disable");
      token = s.token;
      refreshToken = s.refresh;
      expires = s.expires;
    }
    backgroundMode(enable);
  } catch (e) {
    status(String(e));
  } finally {
    busy = false;
  }
};
byId("devices").onclick = async () => {
  async function show(remove) {
    const origin = byId("origin").value.trim();
    const { devices } = await invoke("devices", {
      origin,
      token: await access(),
      remove,
    });
    byId("device-list").replaceChildren(
      ...devices.map((d) => {
        const li = document.createElement("li");
        li.textContent = d.name + " · " + d.id;
        if (d.id === localStorage.getItem(reportKey() + ":device")) {
          li.append(" · 当前设备");
          return li;
        }
        const btn = document.createElement("button");
        btn.textContent = "移除";
        btn.onclick = () => {
          if (
            confirm("移除设备 " + d.id + "？该设备的现有绑定将无法继续同步。")
          )
            show(d.id).catch((e) => status(String(e)));
        };
        li.append(btn);
        return li;
      }),
    );
    if (background) {
      const s = await mobile("restore");
      byId("diagnostic").textContent = [lastReport(), s?.diagnostic]
        .filter(Boolean)
        .join("\n");
    }
  }
  try {
    await show(null);
  } catch (e) {
    status(String(e));
  }
};
