# Plan: Companion Tests + Bug Fixes

## Overview

Three workstreams:
1. Add unit tests for shared onboarding & app tour logic in `packages/companion/`
2. Fix personalizing flow (gradient flash + missing personalized-briefing page)
3. Fix app tour SubscribeDialog not showing on web

---

## Part 1: Shared Unit Tests (`packages/companion/`)

All tests go in `packages/companion/src/` and follow the existing pattern (`*.test.ts`, `@jest/globals`, `// @auto-export-skip`).

### 1A. App Tour Step Definitions
**File:** `packages/companion/src/hooks/appTour/steps.test.ts`
- `tourSteps` exports correctly
- Step count matches expected (7 base + 5 extra = 12 total)
- Each step has required fields: `target`, `title`, `content`, `stepNo`, `placement`
- Step numbers are sequential (1–12)
- Web-specific vs RN-specific steps: `#companion-tools` is step 8 on web, step 9 on RN
- `#companion-specialists` route is `/companion/specialists` on web, `/companion/specialist` on RN
- Base steps have correct targets and routes
- No duplicate step numbers

### 1B. App Tour Store Factory
**File:** `packages/companion/src/hooks/appTour/store.test.ts`
- `createAppTourStore` creates a valid Zustand store
- Initial state: `run: false`, `stepIndex: 0`
- `setRun` / `setStepIndex` update state correctly
- `next()` increments stepIndex
- `next()` stops when reaching end of tour
- `prev()` decrements stepIndex (min 0)
- `stop(true)` sets `run: false` and calls `onComplete` callback
- `stop(false)` sets `run: false` without callback
- `restart()` resets to step 0 and sets `run: true`
- Persist layer is called with correct keys on next/prev/stop/restart
- `syncToApi` is called on stop/restart

### 1C. AI Chat Tour Hook
**File:** `packages/companion/src/hooks/appTour/useTourAiChat.test.ts`
- Returns questions array for given week/role
- `questionCount` starts at 0
- `canProceed` is false initially
- `askQuestion` increments count
- `canProceed` becomes true after 1 question
- Different weeks return different questions
- Nurture vs caregiver returns different question sets

### 1D. Symptom Log Tour Hook
**File:** `packages/companion/src/hooks/appTour/useTourSymptomLog.test.ts`
- Initial state: severity null, frequency null, step 'select'
- `selectSymptom()` moves to 'severity' step
- `selectSeverity()` sets severity and moves to 'frequency' step
- `selectFrequency()` sets frequency and moves to 'done' step
- `reset()` returns all to initial state
- Flow completes correctly: select → severity → frequency → done

### 1E. Onboarding Hook
**File:** `packages/companion/src/hooks/useOnboarding.test.ts`
- Returns `firstIncompleteStep` and `isComplete` for null user
- Returns correct step for partial user
- Returns `isComplete: true` when all steps done
- Memoizes results (same reference for same input)

### 1F. Personalizing Constants
**File:** `packages/companion/src/constants/personalizing.test.ts`
- `PERSONALIZING_TITLE` is non-empty string
- `PERSONALIZING_FACTS` has 5 items, all non-empty strings
- `PERSONALIZING_DURATION_MS` is 15000
- `FACT_INTERVAL_MS` is 1500

### 1G. Profile Completion
**File:** `packages/companion/src/utils/profile-completion.test.ts`
- `calculateClientCompletion` returns 0 for empty inputs
- Returns correct section scores
- Required fields weighted 2x vs optional 1x
- `getSectionProgress` returns correct section score
- `getIncompleteFields` returns only unfilled fields
- `isFilled` handles empty strings, null, undefined, empty arrays
- `SECTION_ORDER` has all 4 sections

### 1H. Onboarding API Service
**File:** `packages/companion/src/api/onboarding.service.test.ts`
- Mock the `api` instance
- `updateStep` calls correct endpoint
- Returns user data on success
- Returns null on API error
- Returns null on network error
- Passes correct data payload

---

## Part 2: Fix Personalizing Flow

### Problem
- `apps/companion/src/app/(auth)/personalizing/page.tsx` wraps `PersonalizingLoader` in `AuthBackground` → gradient (#fafafa) flashes before black loader covers it
- Web skips `personalized-briefing` step that mobile has

### Mobile Flow
`personalizing` (black bg, loading gif, rotating facts) → `personalized-briefing` (animated narrative, "Begin" button) → home

### Web Flow (current)
`personalizing` → `/companion` directly

### Changes

#### 2A. Edit `apps/companion/src/app/(auth)/personalizing/page.tsx`
- Remove `AuthBackground` import and wrapper
- Render `PersonalizingLoader` directly (it already has `bg-black`)
- Change `handleComplete` to navigate to `/personalized-briefing` instead of `/companion`

#### 2B. Create `apps/companion/src/app/(auth)/personalized-briefing/page.tsx`
- Standalone page matching mobile's `personalized-briefing.tsx` flow
- Fetches briefing via `api.post(API_ENDPOINTS.briefing.generate, ...)` (same endpoint as mobile)
- Displays: journey heading + body → personalization cards → closing text → "Begin" button
- "Begin" calls `api.patch(profile.update, { onboardingCompleted: true, personalizedBriefingGenerated: true })` → navigates to `/companion`
- Dark → cream gradient transition via CSS animation
- Loading state with Leto icon / spinner
- Uses `useUser()` from auth provider, `api` from `@/lib/api`

---

## Part 3: Fix App Tour SubscribeDialog

### Problem
In `apps/companion/src/hooks/appTour/AppTour.tsx`, the health-history step (last step on web, step 12) has a custom `onDone` that calls `stop(true)` + opens profile dialog but does NOT call `useSubscribeStore.getState().setOpen(true)`.

### Change

#### 3A. Edit `apps/companion/src/hooks/appTour/AppTour.tsx` (~line 836)
In the health-history step's `onDone` handler, add:
```tsx
useSubscribeStore.getState().setOpen(true);
```
After `stop(true)`. This ensures the `SubscribeDialog` opens when the tour completes.

---

## Files Summary

### New Files (tests)
| File | Purpose |
|------|---------|
| `packages/companion/src/hooks/appTour/steps.test.ts` | Tour step definitions |
| `packages/companion/src/hooks/appTour/store.test.ts` | Tour store factory |
| `packages/companion/src/hooks/appTour/useTourAiChat.test.ts` | AI chat hook |
| `packages/companion/src/hooks/appTour/useTourSymptomLog.test.ts` | Symptom log hook |
| `packages/companion/src/hooks/useOnboarding.test.ts` | Onboarding hook |
| `packages/companion/src/constants/personalizing.test.ts` | Personalizing constants |
| `packages/companion/src/utils/profile-completion.test.ts` | Profile completion |
| `packages/companion/src/api/onboarding.service.test.ts` | Onboarding API service |

### New Files (features)
| File | Purpose |
|------|---------|
| `apps/companion/src/app/(auth)/personalized-briefing/page.tsx` | Personalized briefing page |

### Edited Files
| File | Change |
|------|--------|
| `apps/companion/src/app/(auth)/personalizing/page.tsx` | Remove AuthBackground, redirect to /personalized-briefing |
| `apps/companion/src/hooks/appTour/AppTour.tsx` | Add SubscribeDialog open in health-history onDone |

---

## Verification
1. `cd packages/companion && pnpm test` — all new + existing tests pass
2. `cd apps/companion && pnpm test` — no regressions
3. Manual: complete onboarding → personalizing (black bg, no gradient flash) → personalized-briefing (narrative + "Begin") → /companion
4. Manual: run app tour → last step "Done" → SubscribeDialog appears
