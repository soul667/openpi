import React from 'react';
import { Tag } from 'antd';
import { JobStatus } from '../api/types';

export const JobStatusTag: React.FC<{ status: JobStatus; className?: string }> = ({ status, className }) => {
  const colorMap: Record<JobStatus, string> = {
    queued: 'default',
    running: 'processing',
    succeeded: 'success',
    failed: 'error',
    killed: 'warning'
  };

  return <Tag color={colorMap[status]} className={className}>{status.toUpperCase()}</Tag>;
};
