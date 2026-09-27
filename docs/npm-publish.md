# Publishing `@carjms/oar-cli` to npm

The shell command is **`oar`**.  
The npm package name is **`@carjms/oar-cli`**. The bare name
[`oar`](https://www.npmjs.com/package/oar) is already taken, and npm rejected
the unscoped `oar-cli` as too similar to another package.

## One-time login

```bash
npm login
npm whoami   # must succeed
```

## Publish

```bash
cd omo-account-router
bun test && bun run build
npm publish --access public
```

## Users install

```bash
npm install -g @carjms/oar-cli
oar doctor
```

## Without npm registry (already works)

```bash
npm install -g https://github.com/JIMyungSik/omo-account-router/archive/refs/heads/main.tar.gz
```
