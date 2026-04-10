# Leo Rename Migration Guide

## Summary

The project has been renamed from **Terragon** to **Leo**.

This change updates:

- Workspace/package scope: `@terragon/*` -> `@leo/*`
- User-facing branding text: `Terragon` -> `Leo`
- Primary env/config keys: `TERRAGON_*` -> `LEO_*`
- Primary internal header: `X-Terragon-Secret` -> `X-Leo-Secret`
- Primary setup script name: `terragon-setup.sh` -> `leo-setup.sh`

## Compatibility Aliases

During migration, the platform accepts both new and legacy identifiers in key runtime paths.

- CLI/web URL env:
  - New: `LEO_WEB_URL`, `NEXT_PUBLIC_LEO_WEB_URL`
  - Legacy still accepted: `TERRAGON_WEB_URL`, `NEXT_PUBLIC_TERRAGON_WEB_URL`
- Daemon/MCP env:
  - New: `LEO_FEATURE_FLAGS`, `LEO_SERVER_URL`, `LEO_THREAD_ID`, `LEO_THREAD_CHAT_ID`
  - Legacy still accepted: `TERRAGON_FEATURE_FLAGS`, `TERRAGON_SERVER_URL`, `TERRAGON_THREAD_ID`, `TERRAGON_THREAD_CHAT_ID`
- Internal service auth header:
  - New: `X-Leo-Secret`
  - Legacy still accepted: `X-Terragon-Secret`
- Repository setup script:
  - New preferred: `leo-setup.sh`
  - Legacy fallback: `terragon-setup.sh`
- Stripe metadata key:
  - New preferred: `leo_user_id`
  - Legacy fallback: `terragon_user_id`

## Deprecation Timeline

- Migration start: **April 10, 2026**
- Legacy alias support sunset target: **July 31, 2026**

After the sunset date, legacy Terragon-prefixed keys/headers/script names should be removed from runtime compatibility paths.
