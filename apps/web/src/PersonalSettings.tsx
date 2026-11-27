import { ModelSettings } from "./assistant/Settings";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { checkPicture, pictureTypes } from "./api";
import AppearanceSettings from "./AppearanceSettings";
import Manager from "./plugins/Manager";
import type { UserPreferences } from "./preferences";

export type ProfileRequest = (
  action: "me" | "avatar" | "saveAvatar" | "password",
  body?: Record<string, string>,
) => Promise<{ avatar?: string; email?: string; role?: string }>;
export function useAccountProfile(request: ProfileRequest) {
  const [email, setEmail] = useState("");
  const [admin, setAdmin] = useState(false);
  const [avatar, setAvatar] = useState("");
  const [error, setError] = useState("");
  const [revision, reload] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([request("me"), request("avatar")])
      .then(([user, image]) => {
        if (active) {
          setEmail(user.email || "");
          setAdmin(user.role === "system_admin");
          setAvatar(image.avatar || "");
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [request, revision]);
  return {
    email,
    admin,
    avatar,
    error,
    retry: () => reload((r) => r + 1),
    saveAvatar: async (value: string) => {
      await request("saveAvatar", { avatar: value });
      setAvatar(value);
    },
  };
}
function Avatar({ src }: { src: string }) {
  return src ? (
    <img src={src} alt="" />
  ) : (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-9 16-9 16 0" />
    </svg>
  );
}
export function SettingsButton({
  avatar,
  open,
}: {
  avatar: string;
  open: () => void;
}) {
  return (
    <button
      className="library-avatar"
      aria-label="打开个人设置"
      title="打开个人设置"
      onClick={open}
    >
      <Avatar src={avatar} />
    </button>
  );
}
async function thumbnail(file: File) {
  checkPicture(file);
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 192;
    const size = Math.min(img.naturalWidth, img.naturalHeight);
    canvas
      .getContext("2d")!
      .drawImage(
        img,
        (img.naturalWidth - size) / 2,
        (img.naturalHeight - size) / 2,
        size,
        size,
        0,
        0,
        192,
        192,
      );
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
export default function PersonalSettings(props: {
  profile: ReturnType<typeof useAccountProfile>;
  request: ProfileRequest;
  phone: boolean;
  close: () => void;
  confirmLeave: () => boolean;
  logout: () => void;
  preferences: UserPreferences;
  updatePluginSetting: (id: string, value: unknown) => void;
  mcp?: ReactNode;
  audit?: ReactNode;
  shares?: ReactNode;
  exportPanel: ReactNode;
  sync?: () => void;
  manage?: ReactNode;
}) {
  const { profile, phone } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState(phone ? "" : "账户与安全");
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [password, showPassword] = useState(false);
  useLayoutEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  function back() {
    if (!busy) {
      if (phone && section) setSection("");
      else props.close();
    }
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  const categories = [
    "账户与安全",
    "外观",
    "编辑与插件",
    "导出/导入",
    ...(props.mcp ? ["笔记助手", "MCP 连接"] : []),
    ...(props.shares ? ["我的分享"] : []),
    ...(props.sync ? ["设备与同步"] : []),
  ];
  return (
    <dialog
      ref={dialog}
      className="personal-settings"
      aria-labelledby="settings-title"
      onCancel={(e) => {
        e.preventDefault();
        back();
      }}
    >
      <header>
        <h2 id="settings-title">个人设置</h2>
        <button aria-label="关闭个人设置" disabled={busy} onClick={props.close}>
          ×
        </button>
      </header>
      <div className="settings-layout">
        {(!phone || !section) && (
          <nav aria-label="设置分类">
            {categories.map((name) => (
              <button
                key={name}
                disabled={busy}
                aria-current={name === section ? "page" : undefined}
                onClick={() => {
                  setSection(name);
                  setMessage("");
                }}
              >
                {name}
              </button>
            ))}
            {props.manage}
          </nav>
        )}
        {section && (
          <section className="settings-detail" key={section}>
            {phone && (
              <button disabled={busy} onClick={back}>
                返回设置分类
              </button>
            )}
            <h3>{section}</h3>
            {section === "账户与安全" && (
              <>
                <div className="profile-heading">
                  <span className="library-avatar">
                    <Avatar src={preview || profile.avatar} />
                  </span>
                  <strong>
                    {profile.email || (props.sync ? "本地使用" : "当前账户")}
                  </strong>
                </div>
                {profile.error && (
                  <p role="status">
                    {props.sync
                      ? "连接账号后可修改头像和密码。"
                      : profile.error}{" "}
                    <button onClick={profile.retry}>重新连接</button>
                  </p>
                )}
                {profile.email && (
                  <>
                    <fieldset disabled={busy}>
                      <label className="choose-avatar">
                        更换头像
                        <input
                          type="file"
                          accept={pictureTypes}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (file)
                              void run(async () =>
                                setPreview(await thumbnail(file)),
                              );
                          }}
                        />
                      </label>
                      {preview && (
                        <>
                          <button
                            onClick={() =>
                              run(async () => {
                                await profile.saveAvatar(preview);
                                setPreview("");
                                setMessage("头像已保存");
                              })
                            }
                          >
                            保存头像
                          </button>
                          <button onClick={() => setPreview("")}>
                            取消更换
                          </button>
                        </>
                      )}
                      {profile.avatar && (
                        <button
                          onClick={() => {
                            if (confirm("恢复默认头像？"))
                              void run(async () => {
                                await profile.saveAvatar("");
                                setPreview("");
                              });
                          }}
                        >
                          恢复默认头像
                        </button>
                      )}
                    </fieldset>
                    <button
                      disabled={busy}
                      className="profile-action"
                      aria-expanded={password}
                      onClick={() => showPassword((v) => !v)}
                    >
                      修改密码
                    </button>
                    {password && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const form = new FormData(e.currentTarget);
                          void run(async () => {
                            const next = String(form.get("new"));
                            if (next !== form.get("confirm"))
                              throw Error("两次输入的新密码不一致");
                            if (!props.confirmLeave()) return;
                            await props.request("password", {
                              current_password: String(form.get("current")),
                              new_password: next,
                            });
                            alert("密码已修改，请重新登录。");
                            props.logout();
                          });
                        }}
                      >
                        <fieldset disabled={busy}>
                          <label>
                            当前密码
                            <input
                              name="current"
                              type="password"
                              autoComplete="current-password"
                              required
                            />
                          </label>
                          <label>
                            新密码
                            <input
                              name="new"
                              type="password"
                              autoComplete="new-password"
                              minLength={8}
                              required
                            />
                          </label>
                          <label>
                            确认新密码
                            <input
                              name="confirm"
                              type="password"
                              autoComplete="new-password"
                              minLength={8}
                              required
                            />
                          </label>
                          <button>确认修改密码</button>
                        </fieldset>
                      </form>
                    )}
                    {props.audit && (
                      <details>
                        <summary>账户活动</summary>
                        {props.audit}
                      </details>
                    )}
                    <button className="profile-logout"
                      disabled={busy}
                      onClick={() => {
                        if (props.confirmLeave()) props.logout();
                      }}
                    >
                      退出登录
                    </button>
                  </>
                )}
              </>
            )}
            {section === "外观" && <AppearanceSettings />}
            {section === "编辑与插件" && (
              <Manager
                preferences={props.preferences}
                updatePluginSetting={props.updatePluginSetting}
              />
            )}
            {section === "笔记助手" && <ModelSettings/>}
            {section === "MCP 连接" && props.mcp}
            {section === "导出/导入" && props.exportPanel}
            {section === "我的分享" && props.shares}
            {section === "设备与同步" && (
              <button
                onClick={() => {
                  if (props.confirmLeave()) props.sync?.();
                }}
              >
                返回同步
              </button>
            )}
            {message && <p role="status">{message}</p>}
          </section>
        )}
      </div>
    </dialog>
  );
}
