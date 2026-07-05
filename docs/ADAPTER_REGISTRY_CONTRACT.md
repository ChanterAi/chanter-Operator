# CHANTER Operator — Adapter Registry / Runtime Catalog (P1.5)

## Status

**Metadata-only catalog.** No execution. No UI. No DB. No network.

## Overview

The adapter registry catalogs all registered CHANTER product adapters (Loop Governor, SafeCommit, AutoPoster) with metadata including lifecycle mappings, safety notes, exclusions, and documentation paths. This allows Operator and its UI to discover available adapters without importing adapter code or executing products.

## Registered Adapters

| Adapter ID      | Product        | States | Doc |
|-----------------|----------------|--------|-----|
| `loop_governor` | Loop Governor  | 11     | `docs/LOOP_GOVERNOR_ADAPTER_CONTRACT.md` |
| `safecommit`    | SafeCommit     | 14     | `docs/SAFE_COMMIT_ADAPTER_CONTRACT.md` |
| `autoposter`    | AutoPoster     | 19     | `docs/AUTOPOSTER_ADAPTER_CONTRACT.md` |

All adapters: `contractOnly: true`, `hasSampleFixture: true`, proper safety exclusions.

## Types

### AgentRuntimeAdapterMetadata

```typescript
interface AgentRuntimeAdapterMetadata {
  adapterId: AgentRuntimeAdapterId;        // "loop_governor" | "safecommit" | "autoposter"
  productId: string;                       // CHANTER product name
  displayName: string;                     // Human-readable
  contractOnly: true;                      // Always true
  supportedSourceStates: string[];         // Valid domain-specific states
  lifecycleStates: readonly AgentRunLifecycleState[];  // Always all 6
  contractDocPath: string;                 // Relative doc path
  hasSampleFixture: boolean;               // Always true
  safetyNotes: string[];                   // Human-readable
  exclusions: AdapterSafetyExclusion[];    // What the adapter does NOT do
}
```

### AgentRuntimeAdapterCatalog

```typescript
interface AgentRuntimeAdapterCatalog {
  adapters: Record<AgentRuntimeAdapterId, AgentRuntimeAdapterMetadata>;
  assembledAt: string;   // ISO-8601
  version: number;       // Incremented on add/remove
}
```

## API

| Function | Returns | Description |
|----------|---------|-------------|
| `listRegisteredAdapters()` | `AgentRuntimeAdapterMetadata[]` | All registered adapters |
| `getRegisteredAdapter(id)` | `AdapterRegistryResult` | Lookup by id, never throws |
| `assertAdapterRegistered(id)` | `AgentRuntimeAdapterMetadata` | Throws if unknown |
| `getAdapterLifecycleMapping(id)` | `AdapterLifecycleMapping[]` | State → lifecycle mapping |
| `getCatalog()` | `AgentRuntimeAdapterCatalog` | Full serializable catalog |

## Future Integration Path

```
Operator UI
  │
  │  calls listRegisteredAdapters() → discovers available products
  │  calls getAdapterLifecycleMapping("autoposter") → displays state mapping
  │  calls getCatalog() → exports catalog as JSON for external tools
  ▼
Adapter Registry (this module)
  │
  │  Returns metadata only — never imports adapter code
  │  Never executes products
  ▼
No execution happens. Pure metadata catalog.
```

## Adding Future Adapters

1. Add adapter types + mapping function to `apps/backend/src/agentRuntime/adapters/`
2. Add adapter ID to `AdapterIds` array in `adapterRegistry.ts`
3. Add metadata constant (e.g. `CLEAN_ENGINE_META`)
4. Add entry to `CATALOG.adapters`
5. Increment `CATALOG.version`
6. Add tests to `adapter-registry.test.ts`
7. Add docs to `docs/`

## Exclusions

❌ No execution  ❌ No UI  ❌ No DB  ❌ No network  
❌ No cross-repo  ❌ No deploy changes  ❌ No agent integration  

## Module Location

```
apps/backend/src/agentRuntime/adapters/
  adapterRegistry.ts           — Registry types, catalog, lookup functions

apps/backend/tests/
  adapter-registry.test.ts     — 68 tests
```
