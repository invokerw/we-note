const byId = (id) => document.getElementById(id);
const invoke = window.__TAURI__.core.invoke;
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
byId("vault").onchange = restoreFolder;
byId("login").onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  try {
    const origin = byId("origin").value.trim();
    const session = await invoke("login", {
      origin,
      email: byId("email").value,
      password: byId("password").value,
    });
    if (!session.vaults.length) throw "请先在网页端创建笔记库，然后重新登录。";
    token = session.token;
    refreshToken = session.refresh;
    expires = Date.parse(session.expires);
    localStorage.setItem("origin", origin);
    byId("password").value = "";
    byId("vault").replaceChildren(
      ...session.vaults.map((v) => new Option(v.name, v.id)),
    );
    byId("login").hidden = true;
    byId("settings").hidden = false;
    restoreFolder();
    status("");
  } catch (error) {
    status(String(error));
  } finally {
    busy = false;
  }
};
async function sync() {
  if (busy || !token || !byId("settings").reportValidity()) return;
  busy = true;
  const vault = byId("vault").value,
    root = byId("root").value;
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
    status(
      `上次同步 ${new Date().toLocaleTimeString()} · 上传 ${result.uploaded} · 下载 ${result.downloaded}` +
        (result.conflicts.length
          ? "\n已保留冲突副本\n" + result.conflicts.join("\n")
          : ""),
    );
  } catch (error) {
    status(String(error));
  } finally {
    busy = false;
  }
}
byId("settings").onsubmit = (event) => {
  event.preventDefault();
  sync();
};
byId("logout").onclick = () => {
  if (busy) return;
  void invoke("logout", { origin: byId("origin").value.trim(), token }).catch(
    () => {},
  );
  token = "";
  refreshToken = "";
  byId("settings").hidden = true;
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
        access: async () => {
          if (vault !== byId("vault").value)
            throw Error("请登录这个笔记库以访问在线资源");
          return access();
        },
      },
    }),
  );
};
