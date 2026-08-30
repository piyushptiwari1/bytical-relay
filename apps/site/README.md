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

The live Vercel project is `relay-bytical`, connected to `piyushptiwari1/bytical-relay` and rooted
at `apps/site`. Vercel automatically creates production deployments for `main` and preview
deployments for pull requests. The production address is
[relay.bytical.ai](https://relay.bytical.ai), with
[relay-bytical.vercel.app](https://relay-bytical.vercel.app) retained as the Vercel fallback.

The project uses these settings:

| Setting | Value |
| --- | --- |
| Framework preset | Vite |
| Root directory | `apps/site` |
| Build command | `pnpm build` |
| Output directory | `dist` |
| Install command | `pnpm install --frozen-lockfile` |

The production hostname `relay.bytical.ai` is associated with the `relay-bytical` Vercel project,
uses its project-unique Vercel CNAME, and has valid HTTPS. Its public DNS is delegated to AWS Route
53, but the AWS `rdc-dev` profile does not own that hosted zone. Future changes must modify only the
`relay` record. Do not modify `bytical.ai`, `www`, `nerva`, other records, AWS stacks, or the
existing Bytical host.