import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  fetchPublishedTools,
  PUBLISHED_TOOLS_ENDPOINT_PATH,
  PUBLISHED_TOOLS_PLUGIN_ID,
  PUBLISHED_TOOLS_TOKEN_NAME,
  type PublishedTool,
  savePublishedTools,
} from '../api/published-tools';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Field, FieldDescription, FieldLabel } from '../components/field';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { BooleanPill, PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';

interface ToolDraft {
  originalName: string | null;
  name: string;
  title: string;
  description: string;
  instructions: string;
  agentId: string;
  allowedTools: string;
}

function createDraft(source?: PublishedTool): ToolDraft {
  return {
    originalName: source?.name ?? null,
    name: source?.name ?? '',
    title: source?.title ?? '',
    description: source?.description ?? '',
    instructions: source?.instructions ?? '',
    agentId: source?.agentId ?? '',
    allowedTools: (source?.allowedTools ?? []).join('\n'),
  };
}

function draftToTool(draft: ToolDraft): PublishedTool {
  const title = draft.title.trim();
  const agentId = draft.agentId.trim();
  return {
    name: draft.name.trim(),
    ...(title ? { title } : {}),
    description: draft.description.trim(),
    instructions: draft.instructions.trim(),
    ...(agentId ? { agentId } : {}),
    allowedTools: draft.allowedTools
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
}

export function PublishedToolsPage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const queryKey = ['published-tools', auth.token];
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<ToolDraft>(() => createDraft());

  const stateQuery = useQuery({
    queryKey,
    queryFn: () => fetchPublishedTools(auth.token),
  });
  const tools = stateQuery.data?.tools ?? [];
  const selectedTool = tools.find((tool) => tool.name === selectedName) ?? null;

  useEffect(() => {
    setDraft(createDraft(selectedTool ?? undefined));
  }, [selectedTool]);

  const saveMutation = useMutation({
    mutationFn: async (next: PublishedTool[]) => {
      await savePublishedTools(auth.token, next);
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  function saveDraft() {
    const tool = draftToTool(draft);
    const rest = tools.filter((entry) => entry.name !== draft.originalName);
    const index = tools.findIndex((entry) => entry.name === draft.originalName);
    const next =
      index === -1
        ? [...rest, tool]
        : [...rest.slice(0, index), tool, ...rest.slice(index)];
    saveMutation.mutate(next, {
      onSuccess: () => {
        setSelectedName(tool.name);
        toast.success(`Saved ${tool.name}.`);
      },
    });
  }

  function deleteSelected() {
    if (!selectedTool) return;
    saveMutation.mutate(
      tools.filter((entry) => entry.name !== selectedTool.name),
      {
        onSuccess: () => {
          setSelectedName(null);
          toast.success(`Deleted ${selectedTool.name}.`);
        },
      },
    );
  }

  const plugin = stateQuery.data?.plugin;
  const endpointUrl = `${window.location.origin}${PUBLISHED_TOOLS_ENDPOINT_PATH}`;

  if (stateQuery.isLoading) {
    return <div className="empty-state">Loading published tools...</div>;
  }
  if (stateQuery.isError) {
    return (
      <div className="empty-state">{getErrorMessage(stateQuery.error)}</div>
    );
  }
  if (!plugin) {
    return (
      <div className="page-stack">
        <PageHeader />
        <Card>
          <CardHeader>
            <CardTitle>Published Tools is not installed</CardTitle>
            <CardDescription>
              Published tools let Microsoft Copilot and other MCP hosts hand
              tasks to a HybridClaw agent. Install the plugin from the gateway
              host, then reload this page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre>{`hybridclaw plugin install ./plugins/${PUBLISHED_TOOLS_PLUGIN_ID}`}</pre>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        actions={
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setSelectedName(null);
              setDraft(createDraft());
            }}
          >
            New tool
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>MCP endpoint</CardTitle>
          <CardDescription>
            Add this URL as a Model Context Protocol tool in Copilot Studio,
            with the token as a Bearer API key. Protocol version 2026-07-28.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="stack-form">
            <Field>
              <FieldLabel>URL</FieldLabel>
              <Input readOnly value={endpointUrl} />
            </Field>
            <div className="button-row">
              <BooleanPill
                value={plugin.status === 'loaded'}
                trueLabel="plugin loaded"
                falseLabel="plugin failed"
                falseTone="danger"
              />
              <BooleanPill
                value={stateQuery.data?.tokenSet ?? false}
                trueLabel="token set"
                falseLabel="token missing"
                falseTone="danger"
              />
            </div>
            {plugin.error ? <p>{plugin.error}</p> : null}
            {stateQuery.data?.tokenSet ? null : (
              <p>
                Every request is rejected until{' '}
                <code>{PUBLISHED_TOOLS_TOKEN_NAME}</code> is set under{' '}
                <Link to="/admin/credentials">Credentials</Link>.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      <div className="two-column-grid">
        <Card>
          <CardHeader>
            <CardTitle>Tools</CardTitle>
            <CardDescription>
              {`${tools.length} published tool${tools.length === 1 ? '' : 's'}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {tools.length ? (
              <div className="list-stack selectable-list">
                {tools.map((tool) => (
                  <button
                    key={tool.name}
                    className={
                      tool.name === selectedName
                        ? 'selectable-row active'
                        : 'selectable-row'
                    }
                    type="button"
                    onClick={() => setSelectedName(tool.name)}
                  >
                    <div>
                      <strong>{tool.title || tool.name}</strong>
                      <small>{tool.description}</small>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                No tools are published yet. Add one to make it callable from the
                MCP endpoint.
              </div>
            )}
          </CardContent>
        </Card>
        <Card variant="muted">
          <CardHeader>
            <CardTitle>
              {selectedTool ? `Edit ${selectedTool.name}` : 'New tool'}
            </CardTitle>
            <CardDescription>
              Hosts see the name, title and description. Instructions and
              allowed tools stay inside HybridClaw.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="stack-form">
              <div className="field-grid">
                <Field>
                  <FieldLabel>Name</FieldLabel>
                  <Input
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    placeholder="ask_sales_pipeline"
                  />
                  <FieldDescription>
                    Letters, digits, _ . and -, starting with a letter.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Title</FieldLabel>
                  <Input
                    value={draft.title}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        title: event.target.value,
                      }))
                    }
                    placeholder="Sales pipeline"
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel>Description (read by the host model)</FieldLabel>
                <Textarea
                  rows={4}
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  placeholder="Use for questions about Salesforce pipeline, forecast and win rates. Do not use for email or documents."
                />
                <FieldDescription>
                  Decides when the host calls this tool: say what it is for,
                  what it is not for, and give example questions.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Instructions (HybridClaw only)</FieldLabel>
                <Textarea
                  rows={6}
                  value={draft.instructions}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      instructions: event.target.value,
                    }))
                  }
                  placeholder="Answer from Salesforce opportunities via the salesforce skill. Reply with a short answer and a small table."
                />
                <FieldDescription>
                  Added to the agent's system prompt for these calls; never sent
                  to the host.
                </FieldDescription>
              </Field>
              <div className="field-grid">
                <Field>
                  <FieldLabel>Agent</FieldLabel>
                  <NativeSelect
                    value={draft.agentId}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        agentId: event.target.value,
                      }))
                    }
                  >
                    <NativeSelectOption value="">
                      {`Default (${stateQuery.data?.defaultAgentId ?? 'main'})`}
                    </NativeSelectOption>
                    {(stateQuery.data?.agentIds ?? []).map((agentId) => (
                      <NativeSelectOption key={agentId} value={agentId}>
                        {agentId}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel>Allowed tools</FieldLabel>
                  <Textarea
                    rows={3}
                    value={draft.allowedTools}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        allowedTools: event.target.value,
                      }))
                    }
                    placeholder={'read\nbash'}
                  />
                  <FieldDescription>
                    One per line. Narrows the agent's own tools; * keeps them
                    unchanged.
                  </FieldDescription>
                </Field>
              </div>
              <div className="button-row">
                <Button
                  type="button"
                  loading={saveMutation.isPending}
                  disabled={saveMutation.isPending}
                  onClick={saveDraft}
                >
                  {saveMutation.isPending ? 'Saving...' : 'Save tool'}
                </Button>
                {selectedTool ? (
                  <Button
                    variant="danger"
                    type="button"
                    disabled={saveMutation.isPending}
                    onClick={deleteSelected}
                  >
                    Delete tool
                  </Button>
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
