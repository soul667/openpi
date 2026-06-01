import React, { useEffect, useState } from 'react';
import { Table, Button, Input, Space, Typography } from 'antd';
import { SyncOutlined, ThunderboltOutlined, RocketOutlined, ExperimentOutlined, BugOutlined } from '@ant-design/icons';
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

  const filtered = datasets.filter(d => d.repoId.toLowerCase().includes(search.toLowerCase()));

  const columns = [
    {
      title: 'Repo ID',
      dataIndex: 'repoId',
      key: 'repoId',
      sorter: (a: DatasetInfo, b: DatasetInfo) => a.repoId.localeCompare(b.repoId),
      render: (val: string) => <a href={`https://huggingface.co/datasets/${val}`} target="_blank" rel="noreferrer">{val}</a>
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
    </Space>
  );
};
