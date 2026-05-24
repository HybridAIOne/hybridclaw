# T Cloud Public Operator Setup

T Cloud Public was formerly named Open Telekom Cloud. The setup steps still use
the established `OTC_*` secret names and OTC API terminology because those names
match the provider's credentials, API docs, and endpoint domains.

## Secrets

Store OTC credentials in HybridClaw encrypted runtime secrets:

```bash
hybridclaw secret set OTC_ACCESS_KEY_ID "<access-key-id>"
hybridclaw secret set OTC_SECRET_ACCESS_KEY "<secret-access-key>"
hybridclaw secret set OTC_PROJECT_ID "<project-id>"
```

If the access key is temporary, also store:

```bash
hybridclaw secret set OTC_SECURITY_TOKEN "<session-token>"
```

Do not paste AK/SK material, IAM passwords, project IDs intended to stay
private, bearer tokens, or session tokens into chat or project files.

## Region

Region is plain configuration, not a secret. Pass it per command:

```bash
node skills/open-telekom-cloud/open_telekom_cloud.cjs --format json run servers --region eu-de
```

For a local shell default, export it instead of putting it in the encrypted
secret store:

```bash
export OTC_REGION=eu-de
```

## Recommended Autonomy

- Inventory and describe calls: green, no operator approval beyond the normal
  network and secret policies.
- Deployment-readiness reports: green when they only read inventory and
  summarize risk.
- Mutations: confirm-each through F8/F14. The approval must include exact
  region, project, service, resource IDs, action, blast radius, rollback, and
  stop conditions.

## Credential Scope

Use a dedicated IAM user for automation. Prefer read-only policies for
inventory and readiness work. Grant write permissions only for a narrow
maintenance window and only for the services being changed.

## Live Call Path

`open_telekom_cloud.cjs run ...` posts an allowlisted `httpRequest` payload to
the HybridClaw gateway. The payload contains `otcAkSk` metadata with secret
names only. The gateway resolves the secrets and signs the request server-side.
The model should never see the access key, secret key, security token, or
computed Authorization header.

The helper defaults to `http://127.0.0.1:9090` for local gateway access. That
default is loopback-only, but a configured gateway bearer token still travels
over that local connection. For any non-loopback or remote gateway deployment,
set `HYBRIDCLAW_GATEWAY_URL` to an HTTPS endpoint and keep gateway tokens off
cleartext networks.

## Failure Handling

- 401, 403, and signature errors are terminal for the current run. Stop after
  the first failed live call and ask the operator to verify credentials, IAM
  scope, project ID, region, endpoint, and system clock.
- 429 responses should stop fan-out. Report `Retry-After` or rate-limit headers
  when present.
- Do not retry mutating actions automatically.

## Companion Tools

Terraform/OpenTofu, Ansible, Cloud Create, official SDKs, Gophercloud, and
`python-otcextensions` are useful for operator-owned changes. Keep those tools
as explicit companion workflows; the bundled skill helper remains the default
contract for read/list/describe and guarded request planning.
