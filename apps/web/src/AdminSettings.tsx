import {
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
} from "antd";
import { MailOutlined } from "@ant-design/icons";
export type Settings = {
  registration_mode: string;
  require_email_verification: boolean;
  backup_root: string;
  backup_schedule: string;
  smtp: {
    host: string;
    port: number;
    security: string;
    username: string;
    password?: string;
    has_password?: boolean;
    from_name: string;
    from: string;
    reply_to: string;
  };
};
export function SettingsPanel({
  settings,
  busy,
  save,
  test,
}: {
  settings: Settings;
  busy: boolean;
  save: (value: Settings) => Promise<boolean>;
  test: () => void;
}) {
  const [form] = Form.useForm<Settings>();
  return (
    <Form
      className="gm-settings"
      layout="vertical"
      form={form}
      requiredMark={false}
      initialValues={{
        ...settings,
        smtp: {
          ...settings.smtp,
          security: settings.smtp.security || "starttls",
          port: settings.smtp.port || 587,
        },
      }}
      onFinish={async (value) => {
        if (await save(value)) form.setFieldValue(["smtp", "password"], "");
      }}
    >
      <Card title="注册与验证">
        <div className="gm-fields">
          <Form.Item name="registration_mode" label="注册模式">
            <Select
              options={[
                { value: "invite_only", label: "仅邀请注册" },
                { value: "open", label: "开放注册" },
                { value: "closed", label: "关闭注册" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="require_email_verification"
            label="邮箱验证"
            valuePropName="checked"
          >
            <Checkbox>必须验证邮箱</Checkbox>
          </Form.Item>
        </div>
      </Card>
      <Card
        title="邮件服务"
        extra={
          <Button
            aria-label="发送测试邮件"
            onClick={test}
            icon={<MailOutlined />}
          >
            发送测试邮件
          </Button>
        }
      >
        <div className="gm-fields">
          <Form.Item name={["smtp", "host"]} label="主机">
            <Input placeholder="smtp.example.com" />
          </Form.Item>
          <Form.Item name={["smtp", "port"]} label="端口">
            <InputNumber min={1} max={65535} />
          </Form.Item>
          <Form.Item name={["smtp", "security"]} label="安全方式">
            <Select
              options={[
                { value: "starttls", label: "STARTTLS" },
                { value: "tls", label: "TLS" },
                { value: "plain", label: "无加密" },
              ]}
            />
          </Form.Item>
          <Form.Item name={["smtp", "username"]} label="用户名">
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name={["smtp", "password"]} label="密码">
            <Input.Password
              autoComplete="new-password"
              placeholder={
                settings.smtp.has_password
                  ? "已配置，留空保留现有密码"
                  : undefined
              }
            />
          </Form.Item>
          <Form.Item name={["smtp", "from_name"]} label="发件人名称">
            <Input />
          </Form.Item>
          <Form.Item
            name={["smtp", "from"]}
            label="发件人地址"
            rules={[{ type: "email", message: "请输入有效邮箱" }]}
          >
            <Input type="email" />
          </Form.Item>
          <Form.Item
            name={["smtp", "reply_to"]}
            label="Reply-To"
            rules={[{ type: "email", message: "请输入有效邮箱" }]}
          >
            <Input type="email" />
          </Form.Item>
        </div>
      </Card>
      <Card title="备份计划">
        <div className="gm-fields">
          <Form.Item name="backup_schedule" label="自动备份">
            <Select
              options={[
                { value: "off", label: "关闭" },
                { value: "daily", label: "每 24 小时" },
                { value: "weekly", label: "每 7 天" },
              ]}
            />
          </Form.Item>
        </div>
      </Card>
      <Space>
        <Button type="primary" htmlType="submit" loading={busy}>
          保存设置
        </Button>
      </Space>
    </Form>
  );
}
