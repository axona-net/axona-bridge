<!-- axona-bridge (signaling broker). Quick checklist before merge. -->

## Summary

<!-- What changed and why. -->

## Checklist

- [ ] **Security-relevant change?** If this touches auth, the embedded peer, WebSocket limits/origin handling, key handling, or anything that changes *what's protected* — add/update an entry in [`axona-docs/SECURITY-CHANGELOG.md`](https://github.com/axona-net/axona-docs/blob/main/SECURITY-CHANGELOG.md). Resolved items only: describe what's protected, **never enumerate still-open findings**.
- [ ] Smoke tests pass (`npm run smoke`, `smoke:signal`, `smoke:axona`, `smoke:pubsub`).
- [ ] `KERNEL_VERSION` is surfaced (`/healthz`, welcome frame) if the `@axona/protocol` dependency changed.
- [ ] Production deploy is user-gated (`ssh axona-bridge`; see `deploy/README.md`).
