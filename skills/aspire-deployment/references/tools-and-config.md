# Tools And Configuration

Use this when the task is about docs lookup, secrets, CLI configuration, diagnostics, cache cleanup, or local certificates.

## Docs Lookup Before Changing AppHost

```bash
aspire docs search <query>
aspire docs list
aspire docs get <slug>
aspire docs api search <query> --language csharp|typescript
aspire docs api list <scope>
aspire docs api get <id>
```

- Use docs commands before changing integrations or implementing unfamiliar AppHost APIs.
- Use `aspire docs list` to browse available doc set before narrowing.
- Use `aspire docs api` when you need the C# or TypeScript API reference for a specific Aspire resource builder or extension method.

## AppHost Secrets Management

```bash
aspire secret set <key> <value>
aspire secret get <key>
aspire secret list
aspire secret path
aspire secret delete <key>
```

- Use `aspire secret` for AppHost user secrets (connection strings, passwords, API keys).
- Use `aspire secret path` to locate the backing store.

## CLI Configuration

```bash
aspire config set <key> <value>
aspire config get <key>
aspire config list
aspire config delete <key>
```

- Use `aspire config list` to see current CLI configuration settings.

## Local Environment Recovery

```bash
aspire doctor
aspire cache clear
aspire certs trust
aspire certs clean
```

- Use `aspire doctor` early when symptoms suggest environment drift, not an app bug.
- Use `aspire cache clear` when cached state is stale.
- Use `aspire certs trust` and `aspire certs clean` for certificate issues.
