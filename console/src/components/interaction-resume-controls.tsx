import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { resumeInteractiveEscalation } from '../api/client';
import type {
  AdminInteractionResponse,
  AdminSuspendedSession,
} from '../api/types';
import { useAuth } from '../auth';
import { getErrorMessage } from '../lib/error-message';
import { useToast } from './toast';

export function InteractionResumeControls(props: {
  session: AdminSuspendedSession;
  onResumed?: () => void;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState('');

  const mutation = useMutation({
    mutationFn: (params: {
      sessionId: string;
      response: AdminInteractionResponse;
    }) => resumeInteractiveEscalation(auth.token, params),
    onSuccess: () => {
      setCode('');
      void queryClient.invalidateQueries({
        queryKey: ['admin-approvals', auth.token],
      });
      props.onResumed?.();
      toast.success('Blocked session resumed.');
    },
    onError: (error) => {
      toast.error('Failed to resume blocked session', getErrorMessage(error));
    },
  });

  function resume(response: AdminInteractionResponse): void {
    if (response.kind === 'code' && !response.value.trim()) {
      toast.error('Code required', 'Enter the operator-provided code first.');
      return;
    }
    mutation.mutate({
      sessionId: props.session.sessionId,
      response,
    });
  }

  return (
    <div className="button-row">
      {props.session.expectedReturnKinds.includes('code') ? (
        <>
          <input
            aria-label={`Code for ${props.session.sessionId}`}
            value={code}
            disabled={mutation.isPending}
            placeholder="Code"
            onChange={(event) => setCode(event.target.value)}
          />
          <button
            className="primary-button"
            type="button"
            disabled={mutation.isPending}
            onClick={() => resume({ kind: 'code', value: code.trim() })}
          >
            Resume
          </button>
        </>
      ) : null}
      {props.session.expectedReturnKinds.includes('approved') ? (
        <button
          className="primary-button"
          type="button"
          disabled={mutation.isPending}
          onClick={() => resume({ kind: 'approved' })}
        >
          Approved
        </button>
      ) : null}
      {props.session.expectedReturnKinds.includes('scanned') ? (
        <button
          className="primary-button"
          type="button"
          disabled={mutation.isPending}
          onClick={() => resume({ kind: 'scanned' })}
        >
          Scanned
        </button>
      ) : null}
      {props.session.expectedReturnKinds.includes('declined') ? (
        <button
          className="danger-button"
          type="button"
          disabled={mutation.isPending}
          onClick={() => resume({ kind: 'declined' })}
        >
          Decline
        </button>
      ) : null}
      {props.session.expectedReturnKinds.includes('timeout') ? (
        <button
          className="ghost-button"
          type="button"
          disabled={mutation.isPending}
          onClick={() => resume({ kind: 'timeout' })}
        >
          Timeout
        </button>
      ) : null}
    </div>
  );
}
