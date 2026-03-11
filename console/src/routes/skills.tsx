import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { fetchSkills, saveSkillEnabled } from '../api/client';
import { useAuth } from '../auth';
import {
  BooleanPill,
  BooleanToggle,
  PageHeader,
  Panel,
} from '../components/ui';

export function SkillsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);

  const skillsQuery = useQuery({
    queryKey: ['skills', auth.token],
    queryFn: () => fetchSkills(auth.token),
  });

  const toggleMutation = useMutation({
    mutationFn: (payload: { name: string; enabled: boolean }) =>
      saveSkillEnabled(auth.token, payload),
    onSuccess: (payload) => {
      queryClient.setQueryData(['skills', auth.token], payload);
    },
  });

  const filteredSkills = (skillsQuery.data?.skills || []).filter((skill) => {
    const haystack = [
      skill.name,
      skill.description,
      skill.source,
      ...(skill.tags || []),
      ...(skill.relatedSkills || []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(deferredFilter.trim().toLowerCase());
  });

  return (
    <div className="page-stack">
      <PageHeader
        title="Skills"
        actions={
          <input
            className="compact-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter skills"
          />
        }
      />

      <div className="two-column-grid">
        <Panel title="Discovery">
          <div className="key-value-grid">
            <div>
              <span>Extra dirs</span>
              <strong>
                {skillsQuery.data?.extraDirs.length
                  ? skillsQuery.data.extraDirs.join(', ')
                  : 'none'}
              </strong>
            </div>
            <div>
              <span>Disabled skills</span>
              <strong>
                {skillsQuery.data?.disabled.length
                  ? skillsQuery.data.disabled.join(', ')
                  : 'none'}
              </strong>
            </div>
          </div>
        </Panel>
      </div>

      <Panel
        title="Installed skills"
        subtitle={`${filteredSkills.length} skill${filteredSkills.length === 1 ? '' : 's'} visible`}
      >
        {skillsQuery.isLoading ? (
          <div className="empty-state">Loading skill catalog...</div>
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Source</th>
                  <th>Runtime</th>
                  <th>Tags</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredSkills.map((skill) => (
                  <tr key={skill.name}>
                    <td>
                      <strong>{skill.name}</strong>
                      <small>{skill.description}</small>
                    </td>
                    <td>{skill.source}</td>
                    <td>
                      <BooleanPill
                        value={skill.available}
                        trueLabel="ready"
                        falseLabel="missing"
                      />
                      {!skill.available ? (
                        <small>
                          {skill.missing.join(', ') || 'missing requirements'}
                        </small>
                      ) : null}
                    </td>
                    <td>{skill.tags.join(', ') || 'none'}</td>
                    <td>
                      <BooleanToggle
                        value={skill.enabled}
                        ariaLabel={`${skill.name} status`}
                        disabled={toggleMutation.isPending}
                        trueLabel="active"
                        falseLabel="inactive"
                        onChange={(enabled) =>
                          toggleMutation.mutate({
                            name: skill.name,
                            enabled,
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
                {filteredSkills.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty-state">
                        No skills match this filter.
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        {toggleMutation.isError ? (
          <p className="error-banner">
            {(toggleMutation.error as Error).message}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
