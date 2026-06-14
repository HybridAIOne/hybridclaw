import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { fetchAdminLogs } from '../api/client';
import type { AdminLogFile } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { BooleanPill, PageHeader } from '../components/ui';
import { formatDateTime } from '../lib/format';

const LOG_TAIL_BYTES = 128 * 1024;

function formatBytes(value: number | null): string {
  if (value == null) return 'missing';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let next = value / 1024;
  for (const unit of units) {
    if (next < 1024 || unit === units.at(-1)) {
      return `${next.toFixed(next >= 10 ? 0 : 1)} ${unit}`;
    }
    next /= 1024;
  }
  return `${value} B`;
}

function fileStatusLabel(file: AdminLogFile): string {
  if (!file.exists) return 'missing';
  if (!file.readable) return 'unreadable';
  return 'readable';
}

export function LogsPage() {
  const auth = useAuth();
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

  const logsQuery = useQuery({
    queryKey: ['admin-logs', auth.token, selectedFileId],
    queryFn: () =>
      fetchAdminLogs(auth.token, {
        fileId: selectedFileId,
        tailBytes: LOG_TAIL_BYTES,
      }),
    refetchOnWindowFocus: false,
  });

  const files = logsQuery.data?.files || [];
  const selectedFile = useMemo(() => {
    const selectedId = logsQuery.data?.selected?.fileId || selectedFileId;
    return (
      files.find((file) => file.id === selectedId) ||
      files.find((file) => file.readable) ||
      files[0] ||
      null
    );
  }, [files, logsQuery.data?.selected?.fileId, selectedFileId]);

  useEffect(() => {
    if (!selectedFile || selectedFile.id === selectedFileId) return;
    setSelectedFileId(selectedFile.id);
  }, [selectedFile, selectedFileId]);

  return (
    <div className="page-stack">
      <PageHeader
        description="Gateway runtime log files"
        actions={
          <Button
            type="button"
            variant="outline"
            disabled={logsQuery.isFetching}
            onClick={() => void logsQuery.refetch()}
          >
            Refresh
          </Button>
        }
      />

      <div className="two-column-grid logs-layout">
        <Card>
          <CardHeader>
            <CardTitle>Files</CardTitle>
            <CardDescription>
              {`${files.length} configured log${files.length === 1 ? '' : 's'}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {logsQuery.isLoading ? (
              <div className="empty-state">Loading log files...</div>
            ) : files.length === 0 ? (
              <div className="empty-state">No log files are configured.</div>
            ) : (
              <div className="list-stack selectable-list">
                {files.map((file) => (
                  <button
                    key={file.id}
                    className={
                      file.id === selectedFile?.id
                        ? 'selectable-row active'
                        : 'selectable-row'
                    }
                    type="button"
                    onClick={() => setSelectedFileId(file.id)}
                  >
                    <div className="session-row-main">
                      <strong>{file.label}</strong>
                      <small className="session-row-meta">{file.path}</small>
                    </div>
                    <span className="session-row-time">
                      {fileStatusLabel(file)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card variant="muted">
          <CardHeader>
            <CardTitle>{selectedFile?.label || 'Log tail'}</CardTitle>
            <CardDescription>
              {selectedFile?.description || 'Select a log file.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!selectedFile ? (
              <div className="empty-state">Select a log file.</div>
            ) : (
              <div className="detail-stack">
                <div className="key-value-grid">
                  <div>
                    <span>Status</span>
                    <strong>
                      <BooleanPill
                        value={selectedFile.readable}
                        trueLabel="readable"
                        falseLabel={fileStatusLabel(selectedFile)}
                        falseTone={selectedFile.exists ? 'danger' : undefined}
                      />
                    </strong>
                  </div>
                  <div>
                    <span>Size</span>
                    <strong>{formatBytes(selectedFile.sizeBytes)}</strong>
                  </div>
                  <div>
                    <span>Modified</span>
                    <strong>
                      {selectedFile.mtime
                        ? formatDateTime(selectedFile.mtime)
                        : 'missing'}
                    </strong>
                  </div>
                  <div>
                    <span>Path</span>
                    <strong>{selectedFile.path}</strong>
                  </div>
                </div>
                {selectedFile.error ? (
                  <div className="empty-state error">{selectedFile.error}</div>
                ) : logsQuery.data?.selected ? (
                  <>
                    {logsQuery.data.selected.truncated ? (
                      <p className="muted-copy">
                        Showing the last{' '}
                        {formatBytes(logsQuery.data.selected.tailBytes)}.
                      </p>
                    ) : null}
                    <pre className="log-viewer">
                      {logsQuery.data.selected.content || '(empty log file)'}
                    </pre>
                  </>
                ) : (
                  <div className="empty-state">
                    This log file is not available yet.
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
