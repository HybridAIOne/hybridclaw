import { useMutation, useQueryClient } from '@tanstack/react-query';
import { installOfficialPlugin, reinstallPlugin } from '../api/client';
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
  // An installed plugin that failed to load is already present, so only a
  // reinstall replaces it; the linked account stays in the data dir.
  const reinstall = props.plugin.loadFailed;
  const installMutation = useMutation({
    mutationFn: async () => {
      const result = reinstall
        ? await reinstallPlugin(props.token, props.plugin.installSource)
        : await installOfficialPlugin(props.token, props.plugin.pluginId);
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
      toast.success(
        `${props.channelLabel} plugin ${reinstall ? 'reinstalled' : 'installed'}.`,
      );
    },
    onError: (error) => {
      toast.error(
        `Plugin ${reinstall ? 'reinstall' : 'installation'} failed`,
        getErrorMessage(error),
      );
    },
  });

  return (
    <aside className="channel-plugin-notice" aria-label="Plugin required">
      <div>
        <strong>{`${props.channelLabel} plugin ${reinstall ? 'failed to load' : 'not installed'}`}</strong>
        <span>
          {reinstall
            ? `The installed ${props.channelLabel} plugin could not be loaded. Reinstall it; the linked account is kept.`
            : `Install the ${props.channelLabel} transport plugin and its required dependencies on this gateway.`}
        </span>
      </div>
      <Button
        type="button"
        loading={installMutation.isPending}
        onClick={() => installMutation.mutate()}
      >
        {installMutation.isPending
          ? `${reinstall ? 'Reinstalling' : 'Installing'} plugin...`
          : `${reinstall ? 'Reinstall' : 'Install'} ${props.channelLabel} plugin`}
      </Button>
    </aside>
  );
}
