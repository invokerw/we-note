import { useState } from "react";
import { request } from "./api";
import { Cover } from "./LibraryUI";

const titles = {
  invite: "接受邀请",
  verify: "验证邮箱",
  reset: "重置密码",
  change: "修改密码",
  forgot: "找回密码",
  resend: "重发验证邮件",
};
export function accountAction() {
  const params = new URLSearchParams(location.hash.slice(1));
  for (const name of Object.keys(titles) as (keyof typeof titles)[]) {
    if (params.has(name)) return { name, secret: params.get(name) || "" };
  }
  return null;
}
export function AccountAction({
  action,
  token,
}: {
  action: NonNullable<ReturnType<typeof accountAction>>;
  token: string;
}) {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  const { name, secret } = action;
  return (
    <div className="auth">
      <Cover />
      <div className="entry-form">
        <h1>{titles[name]}</h1>
        <form
          hidden={done}
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const email = form.get("email"),
              password = form.get("password");
            setBusy(true);
            try {
              switch (name) {
                case "invite": {
                  const result = await (
                    await request(
                      "",
                      `/api/v1/auth/invitations/${encodeURIComponent(secret)}/register`,
                      "POST",
                      { password },
                    )
                  ).json();
                  setMessage(
                    !result.verification_required
                      ? "账户已创建，可以登录。"
                      : result.delivery_status === "sent"
                        ? "账户已创建，请查收验证邮件。"
                        : "账户已创建，邮件暂未送达。请联系管理员检查 SMTP 后重发验证邮件。",
                  );
                  break;
                }
                case "verify":
                  await request("", "/api/v1/auth/verify-email", "POST", {
                    token: secret,
                  });
                  setMessage("邮箱已验证，可以登录。");
                  break;
                case "reset":
                  await request("", "/api/v1/auth/password/reset", "POST", {
                    token: secret,
                    new_password: password,
                  });
                  setMessage("密码已重置，请重新登录。");
                  break;
                case "change":
                  await request(token, "/api/v1/auth/password/change", "POST", {
                    current_password: form.get("current"),
                    new_password: password,
                  });
                  sessionStorage.removeItem("wenote-session");
                  sessionStorage.removeItem("wenote-renewal");
                  setMessage("密码已修改，请重新登录。");
                  break;
                case "forgot":
                  await request(
                    "",
                    "/api/v1/auth/password/reset/request",
                    "POST",
                    { email },
                  );
                  setMessage("如果邮箱符合找回条件，将收到密码重置邮件。");
                  break;
                case "resend":
                  await request(
                    "",
                    "/api/v1/auth/verify-email/resend",
                    "POST",
                    { email, password },
                  );
                  setMessage("请查收验证邮件。");
                  break;
              }
              setDone(true);
            } catch (err) {
              setMessage(String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {(name === "forgot" || name === "resend") && (
            <label>
              邮箱
              <input type="email" name="email" required />
            </label>
          )}
          {name === "change" && (
            <label>
              当前密码
              <input
                name="current"
                type="password"
                required
                autoComplete="current-password"
              />
            </label>
          )}
          {name !== "forgot" && name !== "verify" && (
            <label>
              {name === "resend" ? "当前密码" : "新密码"}
              <input
                type="password"
                name="password"
                minLength={8}
                required
                autoComplete={
                  name === "resend" ? "current-password" : "new-password"
                }
              />
            </label>
          )}
          <button className="primary" disabled={busy}>
            {titles[name]}
          </button>
        </form>
        <p role="status">{message}</p>
        <a href="/">返回笔记</a>
      </div>
    </div>
  );
}
