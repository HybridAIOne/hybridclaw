/**
 * The routing visibility switch changes presentation only; usage remains recorded.
 * Unlike provider settings, it cannot select models or alter execution policy.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchConfig, saveConfig } from '../api/client';
import { useAuth } from '../auth';
import { settingValue, withSettingValue } from '../lib/settings-registry';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { Field, FieldContent, FieldLabel } from './field';
import { Switch } from './switch';
import { useToast } from './toast';

export function RoutingVisibility() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['config', token],
    queryFn: () => fetchConfig(token),
  });
  const mutation = useMutation({
    mutationFn: async (checked: boolean) => {
      const latest = await fetchConfig(token);
      return saveConfig(
        token,
        withSettingValue(latest.config, 'routing.showRoutingInfo', checked),
      );
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(['config', token], payload);
      void queryClient.invalidateQueries({ queryKey: ['chat-history'] });
      void queryClient.invalidateQueries({ queryKey: ['chat-context'] });
      toast.success('Routing visibility saved.');
    },
    onError: (error) =>
      toast.error('Routing visibility save failed', error.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Routing transparency</CardTitle>
      </CardHeader>
      <CardContent>
        <Field orientation="horizontal">
          <Switch
            id="show-routing-info"
            checked={Boolean(
              query.data &&
                settingValue(query.data.config, 'routing.showRoutingInfo'),
            )}
            disabled={!query.data || mutation.isPending}
            onCheckedChange={(checked) => mutation.mutate(checked)}
          />
          <FieldContent>
            <FieldLabel htmlFor="show-routing-info">
              Show routing tags in chat
            </FieldLabel>
          </FieldContent>
        </Field>
        {query.isError ? (
          <p role="alert">Unable to load routing settings.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
