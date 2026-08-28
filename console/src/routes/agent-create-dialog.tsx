/**
 * New-agent dialog — the only console surface that registers an agent id.
 *
 * The id it accepts is the permanent runtime key (workspace directory,
 * addressing, audit rows), so it is validated here and never editable later;
 * everything else the dialog collects is a starting point the configuration
 * tab can change.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createAdminAgent } from '../api/client';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '../components/field';
import { Input } from '../components/input';
import { useToast } from '../components/toast';
import { getErrorMessage } from '../lib/error-message';

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function AgentCreateDialog(props: {
  open: boolean;
  existingAgentIds: string[];
  onOpenChange: (open: boolean) => void;
  onCreated: (agentId: string) => void;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');

  const normalizedId = agentId.trim().toLowerCase();
  const idTaken = props.existingAgentIds.includes(normalizedId);
  const idError = !normalizedId
    ? null
    : idTaken
      ? 'An agent with this id already exists.'
      : AGENT_ID_PATTERN.test(normalizedId)
        ? null
        : 'Use lowercase letters, digits, and dashes.';

  const createMutation = useMutation({
    mutationFn: async () =>
      createAdminAgent(auth.token, {
        id: normalizedId,
        name: name.trim(),
      }),
    onSuccess: (agent) => {
      void queryClient.invalidateQueries({
        queryKey: ['admin-agents', auth.token],
      });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      setAgentId('');
      setName('');
      props.onOpenChange(false);
      props.onCreated(agent.id);
      toast.success('Agent created', `${agent.name || agent.id} is ready.`);
    },
    onError: (error) => {
      toast.error('Create failed', getErrorMessage(error));
    },
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            The agent starts with every skill and tool available. Narrow that
            down on the configuration tab.
          </DialogDescription>
        </DialogHeader>

        <Field error={idError}>
          <FieldLabel>Agent id</FieldLabel>
          <Input
            value={agentId}
            placeholder="research"
            onChange={(event) => setAgentId(event.target.value)}
          />
          <FieldDescription>
            Permanent. Used for addressing, the workspace directory, and audit
            records.
          </FieldDescription>
          <FieldError>{idError}</FieldError>
        </Field>

        <Field>
          <FieldLabel>Display name</FieldLabel>
          <Input
            value={name}
            placeholder="Research Agent"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!normalizedId || Boolean(idError)}
            loading={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            Create agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
