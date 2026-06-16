import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAdminLogs,
  fetchConfig,
  reloadGateway,
  saveConfig,
} from '../api/client';
import type {
  AdminConfig,
  AdminLogFile,
  AdminLoggingState,
} from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { useToast } from '../components/toast';
import { BooleanPill, PageHeader, SegmentedToggle } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime } from '../lib/format';

const LOG_TAIL_BYTES = 128 * 1024;
type LoggingMode = 'off' | 'on' | 'debug';
const LOGGING_MODE_OPTIONS: Array<{
  value: LoggingMode;
  label: string;
  activeTone?: 'is-on' | 'is-off';
}> = [
  { value: 'off', label: 'Off', activeTone: 'is-off' },
  { value: 'on', label: 'On' },
  { value: 'debug', label: 'Debug' },
];

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

function loggingModeFromState(
  config: AdminConfig | null,
  state?: AdminLoggingState,
): LoggingMode {
  const effectiveLevel = state?.effectiveLevel ?? config?.ops.logLevel;
  if (effectiveLevel === 'silent') return 'off';
  if (
    effectiveLevel === 'debug' ||
    effectiveLevel === 'trace' ||
    state?.logRequests.effective === true ||
    state?.debugModelResponses.effective === true ||
    config?.ops.logRequests === true ||
    config?.ops.debugModelResponses === true
  ) {
    return 'debug';
  }
  return 'on';
}

function loggingModeDescription(
  mode: LoggingMode,
  state?: AdminLoggingState,
): string {
  if (!state) return `Current mode: ${mode}`;
  if (state.forcedLevel) {
    return `Current mode: ${mode} (forced by runtime)`;
  }
  if (state.logRequests.envEnabled || state.debugModelResponses.envEnabled) {
    return `Current mode: ${mode} (enabled by runtime flag)`;
  }
  return `Current mode: ${mode}`;
}

function applyLoggingMode(config: AdminConfig, mode: LoggingMode): AdminConfig {
  const debug = mode === 'debug';
  return {
    ...config,
    ops: {
      ...config.ops,
      logLevel: mode === 'off' ? 'silent' : debug ? 'debug' : 'info',
      logRequests: debug,
      debugModelResponses: debug,
    },
  };
}

export function LogsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const logViewerRef = useRef<HTMLPreElement | null>(null);

  const logsQuery = useQuery({
    queryKey: ['admin-logs', auth.token, selectedFileId],
    queryFn: () =>
      fetchAdminLogs(auth.token, {
        fileId: selectedFileId,
        tailBytes: LOG_TAIL_BYTES,
      }),
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
  });
  const configQuery = useQuery({
    queryKey: ['config', auth.token],
    queryFn: () => fetchConfig(auth.token),
    refetchOnWindowFocus: false,
  });
  const loggingState = logsQuery.data?.logging;
  const loggingMode = loggingModeFromState(
    configQuery.data?.config ?? null,
    loggingState,
  );
  const loggingMutation = useMutation({
    mutationFn: async (mode: LoggingMode) => {
      const current = configQuery.data?.config;
      if (!current) throw new Error('Runtime config has not loaded yet.');
      const saved = await saveConfig(
        auth.token,
        applyLoggingMode(current, mode),
      );
      const reload = await reloadGateway(auth.token);
      if (reload.status !== 'ok') {
        throw new Error(reload.message || 'Gateway reload failed.');
      }
      return saved;
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(['config', auth.token], payload);
      toast.success('Logging mode saved.');
      void logsQuery.refetch();
    },
    onError: (error) => {
      toast.error('Logging mode update failed', getErrorMessage(error));
    },
  });

  const files = logsQuery.data?.files || [];
  const selectedLog = logsQuery.data?.selected;
  const selectedFile = useMemo(() => {
    const selectedId = selectedLog?.fileId || selectedFileId;
    return (
      files.find((file) => file.id === selectedId) ||
      files.find((file) => file.readable) ||
      files[0] ||
      null
    );
  }, [files, selectedLog?.fileId, selectedFileId]);

  useEffect(() => {
    if (!selectedFile || selectedFile.id === selectedFileId) return;
    setSelectedFileId(selectedFile.id);
  }, [selectedFile, selectedFileId]);

  useEffect(() => {
    const logViewer = logViewerRef.current;
    if (!logViewer || !selectedLog) return;
    logViewer.scrollTop = logViewer.scrollHeight;
  }, [selectedLog]);

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

      <Card>
        <CardHeader>
          <CardTitle>Logging</CardTitle>
          <CardDescription>
            {configQuery.data
              ? loggingModeDescription(loggingMode, loggingState)
              : configQuery.isError
                ? 'Runtime config unavailable.'
                : 'Loading runtime config...'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SegmentedToggle
            ariaLabel="Logging mode"
            value={loggingMode}
            options={LOGGING_MODE_OPTIONS}
            disabled={
              !configQuery.data ||
              configQuery.isFetching ||
              loggingMutation.isPending
            }
            onChange={(mode) => {
              if (mode === 'off' || mode === 'on' || mode === 'debug') {
                loggingMutation.mutate(mode);
              }
            }}
          />
        </CardContent>
      </Card>

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
                ) : selectedLog ? (
                  <>
                    {selectedLog.truncated ? (
                      <p className="muted-copy">
                        Showing the last {formatBytes(selectedLog.tailBytes)}.
                      </p>
                    ) : null}
                    <pre className="log-viewer" ref={logViewerRef}>
                      {selectedLog.content || '(empty log file)'}
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
