# Relay by Bytical Website

This Vite application is the public site for **Relay by Bytical**. It uses a restrained product
presentation and an interactive Three.js laptop-to-phone scene to explain the product without
pretending Relay is a mobile desktop editor.

## Local development

```sh
pnpm --filter @bytical/relay-site dev
pnpm --filter @bytical/relay-site build
```

## Vercel deployment

Do not put a Vercel token in the repository, a shell history, or a chat transcript. Authenticate
with `vercel login` or set a freshly rotated `VERCEL_TOKEN` directly in your own terminal.

Create a Vercel project with these settings:

| Setting | Value |
| --- | --- |
| Framework preset | Vite |
| Root directory | `apps/site` |
| Build command | `pnpm build` |
| Output directory | `dist` |
| Install command | `pnpm install --frozen-lockfile` |

The intended production hostname is `relay.bytical.ai`. Its public DNS is delegated to AWS Route 53,
but the AWS `rdc-dev` profile does not own that hosted zone. Add the hostname in Vercel, then create
the CNAME or A record Vercel specifies using the AWS profile that owns the `bytical.ai` hosted zone.
Do not replace the current wildcard or `relay` record until Vercel has verified the custom domain.