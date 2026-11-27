import { UploadOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useRef } from "react";

export default function FilePickerButton({ label, accept, disabled, onSelect }: {
  label: string;
  accept: string;
  disabled?: boolean;
  onSelect: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        htmlType="button"
        icon={<UploadOutlined aria-hidden="true" />}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        aria-label={label}
        accept={accept}
        disabled={disabled}
        onChange={({ currentTarget }) => {
          const file = currentTarget.files?.[0];
          currentTarget.value = "";
          if (file) onSelect(file);
        }}
      />
    </>
  );
}
