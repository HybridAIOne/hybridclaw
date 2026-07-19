import { useMutation, useQueryClient } from '@tanstack/react-query';
import { installPlugin } from '../api/client';
import type { GatewayChannelPluginStatus } from '../api/types';
import { Button } from '../components/button';
import { useToast } from '../components/toast';
import { getErrorMessage } from '../lib/error-message';

export function ChannelPluginNotice(props: {
  channelLabel: string;
  plugin: GatewayChannelPluginStatus;
  token: string;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const installMutation = useMutation({
    mutationFn: async () => {
      const result = await installPlugin(
        props.token,
        props.plugin.installSource,
      );
      if (result.kind === 'error') throw new Error(result.text);
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['status', props.token],
      });
      void queryClient.invalidateQueries({
        queryKey: ['plugins', props.token],
      });
      toast.success(`${props.channelLabel} plugin installed.`);
    },
    onError: (error) => {
      toast.error('Plugin installation failed', getErrorMessage(error));
    },
  });

  return (
    <aside className="channel-plugin-notice" aria-label="Plugin required">
      <div>
        <strong>{props.channelLabel} plugin not installed</strong>
        <span>
          Install the {props.channelLabel} transport plugin and its required
          dependencies on this gateway.
        </span>
      </div>
      <Button
        type="button"
        loading={installMutation.isPending}
        onClick={() => installMutation.mutate()}
      >
        {installMutation.isPending
          ? 'Installing plugin...'
          : `Install ${props.channelLabel} plugin`}
      </Button>
    </aside>
  );
}
