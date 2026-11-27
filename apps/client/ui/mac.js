import { encryptRefresh, decryptRefresh } from "./session.js";

const el = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const activeKey = "mac-active-account";
const settingsKey = (owner) => `mac-library:${owner}`;
const read = (key) => JSON.parse(localStorage.getItem(key) || "null");
let account,
  library,
  session,
  refreshRequest,
  syncing,
  choosing = false;
let pendingPath,
  failures = [],
  editor = false;
const persist = () =>
  localStorage.setItem(settingsKey(account.owner), JSON.stringify(library));
const status = (message) => {
  el("status").textContent = message;
};
const available = () =>
  library.vaults.filter((v) => library.ready.includes(v.id));

function page(heading, description, actions = []) {
  el("heading").textContent = heading;
  el("login").hidden = !!account;
  el("storage-setup").hidden = !account;
  el("storage-description").textContent = description;
  for (const id of [
    "pick-storage",
    "create-separate",
    "retry-sync",
    "ready-editor",
    "mac-auto-label",
    "device-panel",
  ])
    el(id).hidden = !actions.includes(id);
  status("");
}
function setup(message = "") {
  const previous = library.root ? `上次使用的位置：${library.root}\n` : "";
  page(
    "选择笔记库存储位置",
    previous +
      `此账号的 ${library.vaults.length} 个笔记库将分别保存在这里。已绑定的旧版笔记库会连同本机修改一起复制到新位置。`,
    ["pick-storage"],
  );
  status(message);
}
function dashboard() {
  const actions = ["retry-sync", "mac-auto-label", "device-panel"];
  if (available().length) actions.push("ready-editor");

  el("retry-sync").textContent = failures.length
    ? "重试未完成的笔记库"
    : "同步所有笔记库";
  page(
    library.vaults.length ? "笔记库同步" : "创建第一个笔记库",
    library.root,
    actions,
  );
  el("mac-auto").checked = !!library.auto;
  el("diagnostic").textContent = library.report || "尚无同步记录";
  status(failures.join("\n"));
}
function openEditor(id) {
  const books = available();
  const current =
    books.find((v) => v.id === id) ||
    books.find((v) => v.id === library.last) ||
    books[0];
  if (!current) {
    if (library.vaults.length) return;
    const who = account;
    window.dispatchEvent(
      new CustomEvent("empty-notebooks", {
        detail: {
          email: who.email,
          root: library.root,
          logout,
          create: async (name) => {
            const created = await invoke("account_vaults", {
              origin: who.origin,
              token: await access(who.owner),
              create: name,
            });
            if (account !== who) return;
            library.vaults = [created];
            persist();
            window.dispatchEvent(new Event("close-empty-notebooks"));
            await syncAll();
          },
        },
      }),
    );
    return;
  }
  const owner = account.owner;
  library.last = current.id;
  persist();
  editor = true;
  window.dispatchEvent(
    new CustomEvent("open-notebook", {
      detail: {
        vault: current.id,
        name: current.name,
        account: account.email,
        owner,
        books,
        switchBook: openEditor,
        access: () => access(owner),
        logout,
        synchronize: () =>
          syncAll({ open: false }).then((ok) => ok && account?.owner === owner),
        settings: () => {
          editor = false;
          dashboard();
        },
      },
    }),
  );
}
async function saveRefresh(who, refresh) {
  const saved = await encryptRefresh(who.owner, refresh);
  if (account !== who) return;
  who.credential = saved;
  localStorage.setItem(activeKey, JSON.stringify(who));
}
async function access(owner) {
  const who = account;
  if (!who || owner !== who.owner) throw Error("请重新登录此账号");
  if (session?.expires > Date.now() + 60000) return session.token;
  if (!refreshRequest)
    refreshRequest = (async () => {
      if (!who.credential && !session?.refresh)
        throw Error("请退出后重新登录以继续同步");
      const refresh =
        session?.refresh || (await decryptRefresh(owner, who.credential));
      const next = await invoke("refresh", {
        origin: who.origin,
        token: refresh,
      });
      if (account !== who) throw Error("账号已切换");
      session = {
        token: next.access_token,
        refresh: next.refresh_token,
        expires: Date.parse(next.expires_at),
      };
      await saveRefresh(who, session.refresh).catch(() => {});
      return session.token;
    })().finally(() => {
      refreshRequest = null;
    });
  return refreshRequest;
}
async function syncAll({
  open = true,
  refresh = true,
  onlyMissing = false,
} = {}) {
  if (syncing) return syncing;
  const who = account;
  if (!onlyMissing) library.finished = [];
  if (!editor) library.complete = false;
  persist();
  const job = (async () => {
    if (!editor) page("正在同步笔记库", library.root);
    failures = [];
    try {
      if (refresh) {
        const result = await invoke("account_vaults", {
          origin: who.origin,
          token: await access(who.owner),
        });
        if (account !== who) return false;
        library.vaults = result.vaults;
        library.ready = library.ready.filter((id) =>
          library.vaults.some((v) => v.id === id),
        );
      }
      const todo = library.vaults.filter(
        (v) => !onlyMissing || !library.finished.includes(v.id),
      );
      for (const [index, vault] of todo.entries()) {
        if (account !== who) return false;
        status(`正在同步 ${index + 1}/${todo.length} · ${vault.name}`);
        try {
          const report = await invoke("sync", {
            owner: who.owner,
            origin: who.origin,
            token: await access(who.owner),
            vault: vault.id,
            name: vault.name,
            root: "",
          });
          if (account !== who) return false;
          library.devices ||= {};
          library.devices[vault.id] = report.device_id;
          if (!library.ready.includes(vault.id)) library.ready.push(vault.id);
          if (!library.finished.includes(vault.id))
            library.finished.push(vault.id);
          persist();
        } catch (e) {
          failures.push(`${vault.name}：${e}`);
        }
      }
    } catch (e) {
      failures.push(String(e));
    }
    if (account !== who) return false;
    if (editor)
      window.dispatchEvent(
        new CustomEvent("account-vaults-updated", {
          detail: { owner: who.owner, books: available() },
        }),
      );
    if (!failures.length) library.complete = true;
    library.report = failures.length
      ? failures.join("\n")
      : `上次同步 ${new Date().toLocaleString()} · ${library.vaults.length} 个笔记库`;
    persist();
    if (!editor) {
      dashboard();
      if (open && !failures.length) openEditor();
    }
    return !failures.length;
  })();
  syncing = job;
  try {
    return await job;
  } finally {
    syncing = null;
  }
}
async function bind(path, separate) {
  if (choosing || !account) return;
  const who = account;
  choosing = true;
  try {
    path ||= await invoke("choose_storage");
    if (!path || who !== account) return;
    const root = await invoke("account_location", {
      owner: who.owner,
      path,
      separate,
    });
    if (who !== account) return;
    Object.assign(library, { root, ready: [], finished: [], complete: false });
    pendingPath = null;
    persist();
    await syncAll();
  } catch (e) {
    if (who !== account) return;
    setup(String(e));
    if (/已有文件|其他账号正在使用/.test(String(e))) {
      pendingPath = path;
      el("create-separate").hidden = false;
    }
  } finally {
    choosing = false;
  }
}
async function enter(restoring) {
  const who = account;
  try {
    library.root = await invoke("account_location", { owner: who.owner });
  } catch (e) {
    if (account === who) setup(library.root ? String(e) : "");
    return;
  }
  if (account !== who) return;
  if (restoring && library.complete && available().length) {
    openEditor();
    if (navigator.onLine) void syncAll({ open: false });
  } else {
    await syncAll({ refresh: restoring, onlyMissing: restoring });
  }
}
async function logout() {
  const who = account,
    token = session?.token;
  account = null;
  localStorage.removeItem(activeKey);
  editor = false;
  page("登录 WeNote", "");
  el("login").inert = true;
  el("device-list").replaceChildren();
  if (who && token)
    void invoke("logout", { origin: who.origin, token }).catch(() => {});
  await Promise.allSettled([syncing, refreshRequest]);
  session = null;
  library = null;
  pendingPath = null;
  failures = [];
  el("login").inert = false;
}
export async function start() {
  el("origin").value = localStorage.getItem("origin") || el("origin").value;
  el("login").onsubmit = async (event) => {
    event.preventDefault();
    if (el("login").inert) return;
    el("login").inert = true;
    try {
      const address = el("origin").value.trim();
      const origin = new URL(address).origin;
      const email = el("email").value.trim().toLowerCase();
      const result = await invoke("login", {
        origin: address,
        email,
        password: el("password").value,
      });
      account = { owner: result.owner, email, origin };
      localStorage.setItem("origin", origin);
      el("password").value = "";
      session = {
        token: result.token,
        refresh: result.refresh,
        expires: Date.parse(result.expires),
      };
      library = read(settingsKey(account.owner)) || { ready: [], finished: [] };
      library.vaults = result.vaults;
      persist();
      localStorage.setItem(activeKey, JSON.stringify(account));
      // This session remains usable when the WebView cannot persist a device key.
      await saveRefresh(account, result.refresh).catch(() => {});
      await enter(false);
    } catch (e) {
      status(String(e));
    } finally {
      el("login").inert = false;
    }
  };
  el("pick-storage").onclick = () => bind(null, false);
  el("create-separate").onclick = () => bind(pendingPath, true);
  el("retry-sync").onclick = () => {
    if (!failures.length) library.finished = [];
    return syncAll({ onlyMissing: !!failures.length });
  };
  el("ready-editor").onclick = () => openEditor();
  el("mac-logout").onclick = logout;
  el("mac-auto").onchange = () => {
    library.auto = el("mac-auto").checked;
    persist();
  };
  el("devices").onclick = async () => {
    const who = account;
    try {
      const args = { origin: who.origin, token: await access(who.owner) };
      const { devices } = await invoke("devices", args);
      if (who !== account) return;
      el("device-list").replaceChildren(
        ...devices.map((d) => {
          const li = document.createElement("li");
          li.textContent = d.name + " · " + d.id;
          if (!Object.values(library.devices || {}).includes(d.id)) {
            const button = document.createElement("button");
            button.textContent = "移除";
            button.onclick = async () => {
              if (account === who && confirm(`移除设备 ${d.name}？`)) {
                try {
                  await invoke("devices", { ...args, remove: d.id });
                  li.remove();
                } catch (e) {
                  status(String(e));
                }
              }
            };
            li.append(button);
          }
          return li;
        }),
      );
    } catch (e) {
      if (account === who) status(String(e));
    }
  };
  const online = () => {
    el("network").hidden = navigator.onLine;
  };
  window.addEventListener("online", () => {
    online();
    if (editor) void syncAll({ open: false });
  });
  window.addEventListener("offline", online);
  setInterval(() => {
    if (editor && library?.auto && navigator.onLine)
      void syncAll({ open: false });
  }, 15000);
  online();
  account = read(activeKey);
  if (account && (library = read(settingsKey(account.owner))))
    await enter(true);
  else {
    account = null;
    page("登录 WeNote", "");
  }
}
