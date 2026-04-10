# Eval Framework — TripCurator AI

## Purpose

Evaluate itinerary quality across multiple dimensions before and during development. Each eval case tests a different stress level of the system.

## Methodology

1. Run the system prompt + user briefing through Claude API
2. Parse the JSON output
3. Score against the rubric (manual for V1, automatable later)
4. Track scores across prompt iterations to measure improvement

## Rubric — 6 Dimensions

Each dimension scored 1-5.

### 1. Authenticity (Does it avoid the tourist circuit?)

| Score | Criteria |
|-------|----------|
| 1 | All recommendations are from "Top 10" lists. Generic. |
| 2 | Mix of generic and interesting. Some effort at local spots. |
| 3 | Majority of recommendations feel curated. A few obvious picks remain. |
| 4 | Strong curation. Clear editorial voice. Most picks would surprise a seasoned traveler. |
| 5 | Every recommendation feels discovered, not searched. The itinerary has a point of view. |

### 2. Factual Accuracy (Do the places exist and are details correct?)

| Score | Criteria |
|-------|----------|
| 1 | Multiple fabricated places. Details (chef names, history) are invented. |
| 2 | Some places exist, some don't. History and details are vague or wrong. |
| 3 | Most places exist. Minor factual errors in details. |
| 4 | All places verifiable. Details are accurate or at least plausible. |
| 5 | All places verified via Google Places. Details confirmed by cross-reference. |

### 3. Logistical Coherence (Does the sequence make geographic/temporal sense?)

| Score | Criteria |
|-------|----------|
| 1 | Recommendations scattered randomly. Impossible to follow in a day. |
| 2 | Some geographic logic but requires excessive driving/transport between spots. |
| 3 | Generally coherent. A few transitions that are tight or impractical. |
| 4 | Well-structured flow. Transitions make sense. Timing is realistic. |
| 5 | Perfect flow. Clustered by neighborhood. Transitions feel natural. Buffer time respected. |

### 4. TASTE.md Adherence (Does it follow the editorial rules?)

| Score | Criteria |
|-------|----------|
| 1 | No evidence of TASTE.md influence. Generic output. |
| 2 | Some editorial language but doesn't follow 1-1-1 Rule or Morning Ritual. |
| 3 | Follows 1-1-1 Rule and Morning Ritual. soul_factor present but thin. |
| 4 | Strong editorial voice. Companion Filter applied correctly. Grit warnings feel real. |
| 5 | Every recommendation reads like it came from a friend who's been there. Full TASTE.md compliance. |

### 5. Briefing Adherence (Did it respect what the user asked for?)

| Score | Criteria |
|-------|----------|
| 1 | Ignores key constraints (budget, companions, restrictions). |
| 2 | Partially addresses briefing. Some constraints ignored. |
| 3 | Addresses most constraints. Companion type and budget roughly right. |
| 4 | Fully respects all stated constraints. Persona detected correctly. |
| 5 | Anticipates unstated needs based on context. Goes beyond the briefing intelligently. |

### 6. Parseability (Is the JSON valid and schema-compliant?)

| Score | Criteria |
|-------|----------|
| 1 | Not valid JSON. Cannot parse. |
| 2 | Valid JSON but major schema violations (missing required fields). |
| 3 | Valid JSON, schema mostly correct. A few fields missing or wrong type. |
| 4 | Fully schema-compliant. All required fields present with correct types. |
| 5 | Fully compliant + optional fields populated thoughtfully. |

## Thresholds

- **Minimum to ship:** No dimension below 3. Overall average ≥ 3.5.
- **Target for launch:** No dimension below 4. Overall average ≥ 4.0.
- **Regression rule:** If a prompt change drops any eval by ≥ 1 point, the change is reverted.

## Tracking

Each eval run is logged with:
- Prompt version (hash or version number)
- Date
- Scores per dimension
- Total average
- Notes on specific failures

```
| Run | Prompt Version | Date | Auth | Fact | Logic | Taste | Brief | Parse | Avg | Notes |
|-----|---------------|------|------|------|-------|-------|-------|-------|-----|-------|
| 1   | v0.1          | ...  | ...  | ...  | ...   | ...   | ...   | ...   | ... | ...   |
```
