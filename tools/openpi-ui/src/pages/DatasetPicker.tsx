import React, { useEffect, useState } from 'react';
import { Table, Button, Input, Space, Typography, Modal, message } from 'antd';
import { SyncOutlined, ThunderboltOutlined, RocketOutlined, ExperimentOutlined, BugOutlined, EditOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { DatasetInfo } from '../api/types';
import { useJobsStore } from '../store/jobs';
import { GripperNormalizeModal } from '../components/GripperNormalizeModal';
import { NormStatsModal } from '../components/NormStatsModal';

export const DatasetPicker: React.FC = () => {
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [gripperTarget, setGripperTarget] = useState<DatasetInfo | null>(null);
  const [normStatsTarget, setNormStatsTarget] = useState<DatasetInfo | null>(null);
  const [promptTarget, setPromptTarget] = useState<DatasetInfo | null>(null);
  const [promptText, setPromptText] = useState('');
  const [savingPrompt, setSavingPrompt] = useState(false);
  const navigate = useNavigate();
  const setPendingRepoId = useJobsStore(state => state.setPendingRepoId);

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await api.getDatasets();
      setDatasets(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const formatSize = (bytes?: number) => {
    if (bytes === undefined) return '-';
    const mb = bytes / (1024 * 1024);
    if (mb > 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(2)} MB`;
  };

  const filtered = datasets.filter((d) => {
    const q = search.toLowerCase();
    return d.repoId.toLowerCase().includes(q) || (d.taskPrompts || []).some((p) => p.toLowerCase().includes(q));
  });

  const openPromptEditor = (dataset: DatasetInfo) => {
    setPromptTarget(dataset);
    setPromptText((dataset.taskPrompts || []).join('\n'));
  };

  const savePromptEditor = async () => {
    if (!promptTarget) return;
    const taskPrompts = promptText
      .split('\n')
      .map((p) => p.trim())
      .filter((p, idx, arr) => p.length > 0 && arr.indexOf(p) === idx);
    setSavingPrompt(true);
    try {
      const updated = await api.updateDatasetPrompts(promptTarget.user, promptTarget.dataset, taskPrompts);
      setDatasets((prev) => prev.map((d) => (d.repoId === updated.repoId ? updated : d)));
      setPromptTarget(null);
      message.success('提示词已保存');
    } catch (e) {
      console.error(e);
      message.error(e instanceof Error ? e.message : '保存提示词失败');
    } finally {
      setSavingPrompt(false);
    }
  };

  const columns = [
    {
      title: 'Repo ID',
      dataIndex: 'repoId',
      key: 'repoId',
      sorter: (a: DatasetInfo, b: DatasetInfo) => a.repoId.localeCompare(b.repoId),
      render: (val: string) => <a href={`https://huggingface.co/datasets/${val}`} target="_blank" rel="noreferrer">{val}</a>
    },
    {
      title: 'Prompt',
      key: 'prompt',
      width: 260,
      render: (_: unknown, record: DatasetInfo) => {
        const prompts = record.taskPrompts || [];
        if (prompts.length === 0) return <Typography.Text type="secondary">-</Typography.Text>;
        return (
          <Space direction="vertical" size={0}>
            {prompts.slice(0, 3).map((p) => (
              <Typography.Text key={p} style={{ fontSize: 12 }}>{p}</Typography.Text>
            ))}
            {prompts.length > 3 && <Typography.Text type="secondary">+{prompts.length - 3} more</Typography.Text>}
          </Space>
        );
      },
    },
    {
      title: 'Robot',
      dataIndex: 'robotType',
      key: 'robotType',
      sorter: (a: DatasetInfo, b: DatasetInfo) => (a.robotType || '').localeCompare(b.robotType || '')
    },
    {
      title: 'Episodes',
      dataIndex: 'totalEpisodes',
      key: 'totalEpisodes',
      sorter: (a: DatasetInfo, b: DatasetInfo) => (a.totalEpisodes || 0) - (b.totalEpisodes || 0)
    },
    {
      title: 'Frames',
      dataIndex: 'totalFrames',
      key: 'totalFrames',
      sorter: (a: DatasetInfo, b: DatasetInfo) => (a.totalFrames || 0) - (b.totalFrames || 0)
    },
    {
      title: 'FPS',
      dataIndex: 'fps',
      key: 'fps',
      sorter: (a: DatasetInfo, b: DatasetInfo) => (a.fps || 0) - (b.fps || 0)
    },
    {
      title: 'Size',
      dataIndex: 'sizeBytes',
      key: 'sizeBytes',
      sorter: (a: DatasetInfo, b: DatasetInfo) => (a.sizeBytes || 0) - (b.sizeBytes || 0),
      render: (val?: number) => formatSize(val)
    },
    {
      title: 'Last Modified',
      dataIndex: 'lastModifiedMs',
      key: 'lastModifiedMs',
      sorter: (a: DatasetInfo, b: DatasetInfo) => a.lastModifiedMs - b.lastModifiedMs,
      render: (val: number) => new Date(val).toLocaleString()
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 420,
      render: (_: unknown, record: DatasetInfo) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => openPromptEditor(record)}
          >
            修改提示词
          </Button>
          <Button
            size="small"
            icon={<ExperimentOutlined />}
            onClick={() => setGripperTarget(record)}
          >
            归一化夹爪
          </Button>
          <Button
            size="small"
            icon={<BugOutlined />}
            onClick={() => setNormStatsTarget(record)}
          >
            预览/修复 Norm Stats
          </Button>
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            onClick={() => {
              setPendingRepoId(record.repoId);
              navigate('/train?tab=norm');
            }}
          >
            计算归一化
          </Button>
          <Button
            type="primary"
            size="small"
            icon={<RocketOutlined />}
            onClick={() => {
              setPendingRepoId(record.repoId);
              navigate('/train?tab=train');
            }}
          >
            开始训练
          </Button>
        </Space>
      )
    }
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>Datasets</Typography.Title>
        <Space>
          <Input.Search 
            placeholder="Search repo ID" 
            allowClear 
            onChange={e => setSearch(e.target.value)} 
            style={{ width: 250 }}
          />
          <Button icon={<SyncOutlined />} onClick={fetchData} loading={loading}>Refresh</Button>
        </Space>
      </div>
      <Table 
        columns={columns} 
        dataSource={filtered} 
        rowKey="repoId" 
        loading={loading}
        size="small"
        pagination={{ defaultPageSize: 50 }}
      />
      <GripperNormalizeModal
        dataset={gripperTarget}
        onClose={() => setGripperTarget(null)}
        onApplied={fetchData}
      />
      <NormStatsModal
        dataset={normStatsTarget}
        onClose={() => setNormStatsTarget(null)}
      />
      <Modal
        title={promptTarget ? `修改提示词：${promptTarget.repoId}` : '修改提示词'}
        open={!!promptTarget}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingPrompt}
        onOk={savePromptEditor}
        onCancel={() => setPromptTarget(null)}
      >
        <Typography.Paragraph type="secondary">
          每行一个提示词，保存后会写回数据集的 meta/tasks.jsonl。
        </Typography.Paragraph>
        <Input.TextArea
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          autoSize={{ minRows: 4, maxRows: 10 }}
          placeholder="例如：pick up the cube"
        />
      </Modal>
    </Space>
  );
};
