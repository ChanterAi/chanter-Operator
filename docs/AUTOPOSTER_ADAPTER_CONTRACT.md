# CHANTER Operator — AutoPoster Adapter Contract (P1.4)

## Status

**Current implementation: contract-only.** No real AutoPoster execution. No TikTok/Instagram API. No social posting. No tokens. No scheduler/cron. No network access.

## Overview

The AutoPoster Adapter maps AutoPoster campaign/job concepts into `AgentRunManifest` objects. Pure data transformation — never imports AutoPoster code, never calls social APIs, never handles tokens.

## State Mapping

| AutoPoster State                    | Lifecycle State |
|-------------------------------------|----------------|
| `campaign_created`, `job_created`, `draft_ready` | `PLAN`               |
| `preparing_payload`, `generating_variants`, `queueing_job` | `EXECUTE`            |
| `validating_content`, `checking_schedule`, `checking_account_scope` | `VALIDATE`           |
| `preview_ready`, `evidence_collected`, `job_recorded` | `EVIDENCE`           |
| `awaiting_human_review`, `approval_required` | `HUMAN_REVIEW`       |
| `queued`, `scheduled`, `published`, `failed`, `cancelled` | `COMPLETE` |

### COMPLETE state requirements

- `queued`/`scheduled`/`published` → require account scope, validation, evidence
- `failed`/`cancelled` → synthetic failure record (skip strict `verifyCompletedManifest`)

## Input Types

### AutoPosterRunInput

```typescript
interface AutoPosterRunInput {
  taskId: string;              // Required
  state: AutoPosterRunState;   // Required — one of 19 states
  campaign?: AutoPosterCampaignInput;
  job?: AutoPosterJobInput;
  accountScope?: string[];     // Required for queued/scheduled/published
  validation?: AutoPosterValidationInput;
  evidence?: AutoPosterEvidenceInput[];
  failure?: AutoPosterFailureInput;
  stateTimestamps?: Partial<Record<AgentRunLifecycleState, string>>;
  runtimeIdPrefix?: string;    // Default: "ap-"
}
```

### AutoPosterCampaignInput
`campaignId`, `campaignName`, `platform` (7 supported), `accountAlias` (alias only, no tokens)

### AutoPosterJobInput
`jobId`, `contentType` (video/image/text/carousel), `variantCount`

## Security Blocklist

The adapter JSON-stringifies the input and blocks any match:

| Category          | Patterns blocked                                                 |
|-------------------|------------------------------------------------------------------|
| Tokens            | `access_token`, `refresh_token`, `bearer`, `api_key`, `client_secret` |
| Cookies/Sessions  | `cookie`, `session_id`, `x-csrf`                                |
| Social API URLs   | TikTok `/api` URLs, `graph.instagram.com`, `graph.facebook.com` |
| Posting claims    | `tiktok.*post`, `tiktok.*upload`, `instagram.*post`             |
| Signed URLs       | `signed-url`, `presigned`, `upload_token`                       |
| General URLs      | `https://`, `wss://`                                            |
| External agents   | `codex`, `ollama`, `openclaw`                                   |
| Execution/deploy  | `live execution`, `real runner`, `shell command`, `deploy`     |
| Scheduler         | `cron`, time-pattern strings                                    |
| Filesystem paths  | `C:\`, `D:\`, `/home/`, `/etc/`, `/var/`                       |

## Sample Fixture

`SAMPLE_AUTOPOSTER_INPUT` — published campaign with:
- Campaign: "Summer Collection Launch" on TikTok, `@chanter_official`
- Job: video with 3 variants
- Account scope: `@chanter_official`, `@chanter_style`
- 4 validation gates (content-check, schedule-check, account-scope-check, format-validation)
- 3 explicit evidence + auto-generated campaign, job, and scope evidence = 6 total

## Auto-Generated Evidence

- Campaign summary (`ap-campaign-{id}`)
- Job summary (`ap-job-{id}`)
- Account scope summary (`ap-scope-{id}`)

## Future Integration Path

```
AutoPoster (separate repo/app)
  │  emits campaign/job summary (state, platform, account aliases, previews)
  ▼
Operator P1.4 Adapter (this module)
  │  mapAutoPosterRunToManifest(input) → AgentRunManifest
  ▼
Operator UI — displays lifecycle, evidence, account scope, review/publish status
```

No AutoPoster code imported. No tokens handled. No API calls made.

## Exclusions

❌ No TikTok/Instagram/YouTube API  ❌ No social posting  ❌ No scheduler/cron  
❌ No token handling  ❌ No Codex/Ollama/OpenClaw  ❌ No network  ❌ No cross-repo  
❌ No DB migration  ❌ No frontend UI  ❌ No deploy changes  

## Module Location

```
apps/backend/src/agentRuntime/adapters/
  autoPosterAdapter.ts         — Contract-only adapter + sample fixture

apps/backend/tests/
  auto-poster-adapter.test.ts  — 71 tests
```

## Tests

71 tests covering state mapping (all 19), rejection (taskId, unknown state, COMPLETE requirements, account scope), token/secret rejection (7 patterns), API/posting/network rejection (7 patterns), sample fixture (11 checks), serialization round-trip, edge cases, and regression checks for all previous adapters.
