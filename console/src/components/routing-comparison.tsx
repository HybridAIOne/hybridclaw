/**
 * Compares classifier decisions without executing either route.
 * Public confirmation resets on edits; displayed costs cover classification only.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { RoutingComparison as Comparison } from '../../../src/gateway/routing-comparison';
import { fetchModels, requestJson } from '../api/client';
import { useAuth } from '../auth';
import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { NativeSelect } from './native-select';
import { Switch } from './switch';

export function RoutingComparison() {
  const { token } = useAuth();
  const models = useQuery({
    queryKey: ['models', token],
    queryFn: () => fetchModels(token),
  });
  const [model, setModel] = useState('');
  const [text, setText] = useState(
    'Explain photosynthesis in three sentences.',
  );
  const [approved, setApproved] = useState(false);
  const compare = useMutation({
    mutationFn: () =>
      requestJson<Comparison>('/api/admin/routing/compare', {
        token,
        method: 'POST',
        body: { text, model, publicSample: approved },
      }),
  });
  const result = compare.data;
  const cost = (value: number | null) =>
    value === null ? 'Unavailable' : `Est. $${value.toFixed(8)}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Compare routers</CardTitle>
      </CardHeader>
      <CardContent>
        <div style={{ display: 'grid', gap: 12 }}>
          <label>
            Concierge model
            <NativeSelect
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                setApproved(false);
                compare.reset();
              }}
            >
              <option value="">Choose a model…</option>
              {models.data?.models
                .filter((item) => !item.id.startsWith('jev/'))
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                  </option>
                ))}
            </NativeSelect>
          </label>
          <label>
            Shared prompt
            <textarea
              aria-label="Shared prompt"
              rows={3}
              maxLength={4000}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setApproved(false);
                compare.reset();
              }}
              style={{
                width: '100%',
                padding: 10,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--panel-bg)',
                color: 'var(--text)',
              }}
            />
          </label>
          <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Switch checked={approved} onCheckedChange={setApproved} />
            Public sample · send to both providers
          </label>
          <div>
            <Button
              disabled={!model || !text.trim() || !approved}
              loading={compare.isPending}
              onClick={() => compare.mutate()}
            >
              Compare
            </Button>
          </div>
          <p style={{ color: 'var(--muted-foreground)', margin: 0 }}>
            Same tiers and policy · classification only.
          </p>
          {compare.isError ? <p role="alert">Comparison failed.</p> : null}
          {result ? (
            <div className="table-shell">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Router</th>
                    <th>Tier</th>
                    <th>Decision</th>
                    <th>Time</th>
                    <th>Tokens in / out</th>
                    <th>Classifier cost</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>JEV · {result.jev.model}</td>
                    <td>{result.jev.signals?.tier ?? '—'}</td>
                    <td>
                      {result.jev.recommendedTier ?? result.jev.decision}
                      {result.jev.selectedModel
                        ? ` → ${result.jev.selectedModel}`
                        : ''}
                      <br />
                      {result.jev.recommendedTier ? result.jev.decision : ''}
                    </td>
                    <td>{result.jev.durationMs}ms</td>
                    <td>
                      {result.jev.inputTokens ?? '—'} /{' '}
                      {result.jev.outputTokens ?? '—'}
                    </td>
                    <td>{cost(result.jev.costUsd)}</td>
                  </tr>
                  <tr>
                    <td>{result.concierge.model}</td>
                    <td>{result.concierge.signals?.tier ?? '—'}</td>
                    <td>
                      {result.concierge.decision.replaceAll('-', ' ')}
                      {result.concierge.selectedModel
                        ? ` → ${result.concierge.selectedModel}`
                        : ''}
                      {result.concierge.recommendedTier
                        ? ` (${result.concierge.recommendedTier})`
                        : ''}
                    </td>
                    <td>{result.concierge.durationMs}ms</td>
                    <td>
                      {result.concierge.inputTokens ?? '—'} /{' '}
                      {result.concierge.outputTokens ?? '—'}
                    </td>
                    <td>{cost(result.concierge.costUsd)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
