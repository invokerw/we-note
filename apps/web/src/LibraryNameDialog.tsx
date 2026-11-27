import { Form, Input, Modal } from "antd";
import { useId, useRef, useState } from "react";

export function LibraryNameDialog({ title, label, initialValue, action, save, close }: {
  title: string;
  label: string;
  initialValue: string;
  action: string;
  save: (value: string) => Promise<void>;
  close: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  async function submit() {
    if (!value.trim() || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await save(value.trim());
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return <Modal open title={title} onCancel={() => { if (!busy) close(); }} onOk={submit}
    okText={action} cancelText="取消" confirmLoading={busy} cancelButtonProps={{disabled: busy}}
    okButtonProps={{disabled: !value.trim()}} width={400}>
    <Form layout="vertical" onFinish={submit}>
      <Form.Item label={label} htmlFor={id} validateStatus={error ? "error" : undefined}
        help={error && <span id={`${id}-error`} role="alert">{error}</span>}>
        <Input id={id} value={value} autoFocus disabled={busy}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={event => {setValue(event.target.value); setError("");}} />
      </Form.Item>
    </Form>
  </Modal>;
}
