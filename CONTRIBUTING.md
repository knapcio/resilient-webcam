# Contributing

Thanks for helping make unattended browser cameras less fragile.

## Development

Requirements: Node.js 18 or newer and a current npm release.

```sh
npm install
npm run check
npm run demo
```

The demo opens at `http://localhost:4173`. Camera access works on localhost;
hosted demos must use HTTPS.

## Pull requests

- Keep the core framework-neutral and free of runtime dependencies.
- Keep changes focused. Recording, uploads, scanning, storage, and UI belong in
  applications or separate packages.
- Add a regression test for lifecycle or recovery behavior.
- Run `npm run check` before opening a pull request.
- Update `CHANGELOG.md` under **Unreleased** for user-facing changes.

Please open an issue before proposing a large API change. Recovery behavior is
easy to make surprising, so explain the failure signal, retry boundary, and
cleanup semantics in the proposal.

## Browser testing

Automated tests use fake media tracks. For changes involving real devices,
include the browser/Electron version, operating system, camera model, and the
disconnect, mute, or stall scenario you tested. Never attach captured images
unless every person shown has consented.

By contributing, you agree that your contribution is licensed under the MIT
License.
