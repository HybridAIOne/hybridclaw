/**
 * Operators review installed safety rules and explicitly save enabled states.
 * The server remains authoritative; stale edits cannot overwrite newer changes.
 * This page does not change session approval modes or sandbox permissions.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchSafetyRules, saveSafetyRules } from '../api/safety-rules';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import { Input } from '../components/input';
import { Switch } from '../components/switch';
import { PageHeader } from '../components/ui';
import { useFormMutation } from '../hooks/use-form-mutation';
import { useUnsavedChangesGuard } from '../hooks/use-unsaved-changes-guard';
import styles from './safety-rules.module.css';

export function SafetyRulesPage() {
  const auth = useAuth();
  const client = useQueryClient();
  const queryKey = ['safety-rules', auth.token];
  const query = useQuery({
    queryKey,
    queryFn: () => fetchSafetyRules(auth.token),
  });
  const [draft, setDraft] = useState<{
    before: string[];
    disabled: string[];
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState('');
  const disabled = draft?.disabled ?? query.data?.disabledRuleIds ?? [];
  const dirty =
    draft !== null &&
    JSON.stringify([...draft.before].sort()) !==
      JSON.stringify([...disabled].sort());
  const { dialog } = useUnsavedChangesGuard({
    isDirty: dirty,
    includeSearch: true,
  });
  const save = useFormMutation({
    mutationFn: (value: NonNullable<typeof draft>) =>
      saveSafetyRules(auth.token, value.disabled, value.before),
    onSuccess: (data) => {
      client.setQueryData(queryKey, data);
      void client.invalidateQueries({ queryKey: ['config'] });
      setDraft(null);
      setSaved(true);
    },
  });
  function change(next: string[]) {
    setSaved(false);
    setDraft({
      before: draft?.before ?? query.data?.disabledRuleIds ?? [],
      disabled: next,
    });
  }
  return (
    <div className={styles.page}>
      {dialog}
      <PageHeader description="Gateway-wide shell and file-content guards. Enabled rules block actions in every approval mode, including learning." />
      <div className={styles.intro}>
        <p>
          Changes apply to every agent from its next turn. Other matching rules
          and normal approval requirements still apply. In-flight turns keep
          their current settings.
        </p>
        <a href="/admin/audit?q=type%3Asafety.rules_changed">
          View configuration changes
        </a>
      </div>
      {query.isLoading && <p>Loading safety rules…</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {save.error && <p role="alert">{save.error.message}</p>}
      {saved && <p role="status">Saved. New turns will use these settings.</p>}
      {query.data && (
        <>
          <p>
            {query.data.rules.length - disabled.length} of{' '}
            {query.data.rules.length} rules enabled
          </p>
          <div className={styles.actions}>
            <Button
              disabled={!dirty || save.isPending}
              onClick={() => draft && save.mutate(draft)}
            >
              Save changes
            </Button>
            <Button
              variant="outline"
              disabled={save.isPending || disabled.length === 0}
              onClick={() => change([])}
            >
              Enable all rules
            </Button>
            <Button
              variant="outline"
              disabled={save.isPending}
              onClick={() => {
                setDraft(null);
                setSaved(false);
                void query.refetch();
              }}
            >
              Reload
            </Button>
          </div>
          <Input
            aria-label="Find a safety rule"
            placeholder="Find a rule by name, reason, or pattern…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className={styles.rules}>
            {query.data.rules
              .filter((rule) =>
                `${rule.id} ${rule.reason} ${rule.scope} ${rule.pattern}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((rule) => (
                <Card key={rule.id}>
                  <CardHeader className={styles.ruleHeader}>
                    <CardTitle>{rule.id}</CardTitle>
                    <Switch
                      aria-label={`Enable ${rule.id}`}
                      checked={!disabled.includes(rule.id)}
                      disabled={save.isPending}
                      onCheckedChange={(enabled) =>
                        change(
                          enabled
                            ? disabled.filter((id) => id !== rule.id)
                            : [...disabled, rule.id],
                        )
                      }
                    />
                  </CardHeader>
                  <CardContent className={styles.content}>
                    <p>{rule.reason}</p>
                    <p className={styles.scope}>
                      {rule.scope === 'bash'
                        ? 'Shell commands'
                        : 'Write and edit file contents'}
                    </p>
                    <code className={styles.pattern}>{rule.pattern}</code>
                  </CardContent>
                </Card>
              ))}
          </div>
          <p className={styles.scope}>
            These pattern checks are not a complete shell sandbox.
            Authentication, sandbox limits, network policy, and tool argument
            validation have their own controls.
          </p>
        </>
      )}
    </div>
  );
}
