/**
 * Devices tab: answers a device that asked this gateway for access and shows a
 * short code. Approving lets that device collect its own scoped API token,
 * which then appears under API tokens; that is where it is revoked. This tab
 * does not list or manage devices itself.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { type FormEvent, useId, useState } from 'react';
import { answerDeviceRequest, fetchDeviceRequest } from '../api/devices';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Field, FieldLabel } from '../components/field';
import { Input } from '../components/input';
import { getErrorMessage } from '../lib/error-message';
import styles from './secrets.module.css';

export function DevicesPage() {
  const { token } = useAuth();
  const search = useSearch({ strict: false }) as { code?: string };
  const codeId = useId();
  const [code, setCode] = useState(search.code ?? '');
  const [lookup, setLookup] = useState(search.code?.trim() || '');
  const [answer, setAnswer] = useState<'approved' | 'denied' | null>(null);

  const query = useQuery({
    queryKey: ['admin', 'device', lookup, token],
    queryFn: () => fetchDeviceRequest(token, lookup),
    enabled: Boolean(lookup) && answer === null,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      answerDeviceRequest(token, lookup, approve),
    onSuccess: (_, approve) => setAnswer(approve ? 'approved' : 'denied'),
  });

  const find = (event: FormEvent) => {
    event.preventDefault();
    setAnswer(null);
    decide.reset();
    setLookup(code.trim());
  };
  const device = query.data?.device;

  return (
    <div className="page-stack">
      <form className={styles.section} onSubmit={find}>
        <Field>
          <FieldLabel htmlFor={codeId}>Code shown on the device</FieldLabel>
          <Input
            id={codeId}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="bcdf-ghjk"
            autoComplete="off"
          />
        </Field>
        <div className={styles.actions}>
          <Button type="submit" disabled={!code.trim()}>
            Find device
          </Button>
        </div>
      </form>

      {answer === 'approved' ? (
        <div className="empty-state">
          Approved. The device finishes connecting by itself.
        </div>
      ) : answer === 'denied' ? (
        <div className="empty-state">Denied. The device was not connected.</div>
      ) : query.isError ? (
        <div className="empty-state">{getErrorMessage(query.error)}</div>
      ) : device ? (
        <Card>
          <CardHeader>
            <CardTitle>{device.clientName} asks to connect</CardTitle>
            <CardDescription>
              {device.sourceIp ? `From ${device.sourceIp}. ` : ''}
              Only approve a code you see on your own device.
            </CardDescription>
          </CardHeader>
          <CardContent>
            It will be able to chat with your agents, list them and open the
            documents they make. It gets no admin access. Revoke it at any time
            under API tokens.
          </CardContent>
          <CardFooter>
            <div className={styles.actions}>
              <Button
                type="button"
                variant="danger"
                disabled={decide.isPending}
                onClick={() => decide.mutate(false)}
              >
                Deny
              </Button>
              <Button
                type="button"
                disabled={decide.isPending}
                onClick={() => decide.mutate(true)}
              >
                Approve
              </Button>
            </div>
            {decide.isError ? (
              <p className={styles.caption}>{getErrorMessage(decide.error)}</p>
            ) : null}
          </CardFooter>
        </Card>
      ) : null}
    </div>
  );
}
