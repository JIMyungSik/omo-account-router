# Publishing `oar-cli` to npm

The shell command is **`oar`**.  
The npm package name is **`oar-cli`** because the bare name [`oar`](https://www.npmjs.com/package/oar) is already taken (unrelated 2013 package).

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
npm install -g oar-cli
oar doctor
```

## Without npm registry (already works)

```bash
npm install -g https://github.com/JIMyungSik/omo-account-router/archive/refs/heads/main.tar.gz
```
