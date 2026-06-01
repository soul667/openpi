import React from 'react';
import { Tag } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useJobsStore } from '../store/jobs';

export const ActiveJobPill: React.FC = () => {
  const activeJob = useJobsStore(state => state.activeJob);
  const navigate = useNavigate();

  if (!activeJob) {
    return <Tag color="default">Idle</Tag>;
  }

  return (
    <Tag 
      color="success" 
      className="pulse" 
      style={{ cursor: 'pointer', margin: 0 }}
      onClick={() => navigate(`/jobs/${activeJob.id}`)}
    >
      {activeJob.kind} ({activeJob.status})
    </Tag>
  );
};
