import { useEffect, useState } from "react";
import { Button, Card, Input, Modal, Space, Tag, Typography, message } from "antd";
import { KeyOutlined } from "@ant-design/icons";
import { api } from "../api/client";

interface SecretInfo {
  hasKey: boolean;
  maskedKey: string | null;
}

export function WandbSecretCard({ compact = false }: { compact?: boolean }) {
  const [info, setInfo] = useState<SecretInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    try {
      const s = await api.getWandbSecret();
      setInfo(s);
    } catch (e: unknown) {
      message.error((e as Error).message);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const save = async () => {
    const v = draft.trim();
    if (!v) {
      message.warning("key 不能为空");
      return;
    }
    setSaving(true);
    try {
      const s = await api.saveWandbSecret(v);
      setInfo(s);
      setEditing(false);
      setDraft("");
      message.success("wandb key 已保存到服务器");
    } catch (e: unknown) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const clear = () => {
    Modal.confirm({
      title: "清除已保存的 wandb key？",
      okType: "danger",
      onOk: async () => {
        try {
          const s = await api.clearWandbSecret();
          setInfo(s);
          message.success("已清除");
        } catch (e: unknown) {
          message.error((e as Error).message);
        }
      },
    });
  };

  const inner = (
    <Space wrap size="middle">
      <KeyOutlined />
      <Typography.Text strong>wandb API Key</Typography.Text>
      {info?.hasKey ? (
        <Tag color="success">已保存 {info.maskedKey}</Tag>
      ) : (
        <Tag>未配置</Tag>
      )}
      {!editing ? (
        <Space size="small">
          <Button size="small" onClick={() => setEditing(true)}>
            {info?.hasKey ? "更换" : "设置"}
          </Button>
          {info?.hasKey && (
            <Button size="small" danger onClick={clear}>
              清除
            </Button>
          )}
        </Space>
      ) : (
        <Space size="small">
          <Input.Password
            placeholder="粘贴 wandb key"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPressEnter={save}
            style={{ width: 320 }}
            autoFocus
          />
          <Button size="small" type="primary" loading={saving} onClick={save}>
            保存
          </Button>
          <Button
            size="small"
            onClick={() => {
              setEditing(false);
              setDraft("");
            }}
          >
            取消
          </Button>
        </Space>
      )}
    </Space>
  );

  if (compact) return inner;
  return (
    <Card size="small" style={{ marginBottom: 12 }}>
      {inner}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8, fontSize: 12 }}>
        存在 <code>tools/openpi-ui/.data/secrets.json</code>（仅本机可读）。训练启动时后端自动注入 <code>WANDB_API_KEY</code>。
      </Typography.Paragraph>
    </Card>
  );
}
