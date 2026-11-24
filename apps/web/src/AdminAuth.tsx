import { useEffect, useState } from "react";
import { Alert, Button, Form, Input, Spin } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { rememberSession, request } from "./api";
import { Brand } from "./AdminUI";
export function AdminAuth({ login }: { login: (token: string) => void }) {
  const [setup, setSetup] = useState<boolean | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function check() {
    setError("");
    try {
      setSetup(
        (await (await request("", "/api/v1/admin/bootstrap")).json()).available,
      );
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void check();
  }, []);
  async function submit(values: {
    email: string;
    password: string;
    setup_token?: string;
  }) {
    setBusy(true);
    setError("");
    try {
      if (setup) {
        await request("", "/api/v1/admin/bootstrap", "POST", values);
        setSetup(false);
      }
      const session = await (
        await request("", "/api/v1/auth/login", "POST", {
          email: values.email,
          password: values.password,
        })
      ).json();
      rememberSession(session);
      login(session.access_token);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="gm-entry">
      <section className="gm-entry-cover">
        <Brand />
        <div className="gm-book-stack" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <h2>服务端管理</h2>
      </section>
      <section className="gm-entry-form">
        <a href="/">
          <ArrowLeftOutlined /> 返回笔记
        </a>
        <h1>{setup ? "初始化 GM 管理员" : "管理员登录"}</h1>
        {error && <Alert type="error" showIcon title={error} />}{" "}
        {setup === null ? (
          error ? (
            <Button onClick={check}>重试</Button>
          ) : (
            <Spin />
          )
        ) : (
          <Form layout="vertical" requiredMark={false} onFinish={submit}>
            {setup && (
              <Form.Item
                label="服务器初始化令牌"
                name="setup_token"
                extra="可在服务器数据目录中的 setup.token 文件内找到。"
                rules={[{ required: true, message: "请输入初始化令牌" }]}
              >
                <Input.Password autoComplete="off" />
              </Form.Item>
            )}
            <Form.Item
              label="邮箱"
              name="email"
              rules={[
                { required: true, type: "email", message: "请输入有效邮箱" },
              ]}
            >
              <Input type="email" autoComplete="username" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[
                { required: true, min: 8, message: "请输入至少 8 位密码" },
              ]}
            >
              <Input.Password
                autoComplete={setup ? "new-password" : "current-password"}
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy}>
              {setup ? "创建管理员并登录" : "登录"}
            </Button>
          </Form>
        )}
        {setup === false && (
          <p>
            <a href="/#forgot">找回密码</a> ·{" "}
            <a href="/#resend">重发验证邮件</a>
          </p>
        )}
      </section>
    </main>
  );
}
