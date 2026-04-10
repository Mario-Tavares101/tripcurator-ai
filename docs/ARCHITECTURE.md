# Architecture — TripCurator AI

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React + Vite)                   │
│                                                             │
│  ┌────────────┐  ┌──────────┐  ┌────────────┐  ┌─────────┐  │
│  │ Onboarding │→│ Briefing  │→│  Itinerary  │→│ Export  │  │
│  │ (optional) │  │  Input    │  │   Viewer    │  │ PDF/URL │  │
│  └─────┬──────┘  └─────┬────┘  └─────────────┘  └─────────┘  │
│        │               │                                    │
│        ▼               │                                    │
│  ┌────────────┐        │                                    │
│  │localStorage│        │                                    │
│  │ taste_     │────────┤                                    │
│  │ profile    │        │                                    │
│  └────────────┘        │                                    │
└────────────────────────┼────────────────────────────────────┘
                         │ briefing + taste_profile
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Backend (Edge Functions / API Routes)           │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Orchestrator                          │  │
│  │                                                        │  │
│  │  1. Receive briefing + taste_profile (may be null)    │  │
│  │  2. Assemble system prompt:                            │  │
│  │       TASTE.md + TASTE_PROFILE block + output instr.   │  │
│  │       + ITINERARY_SCHEMA                               │  │
│  │  3. Call Claude API (streaming)                        │  │
│  │  4. Parse structured JSON response                     │  │
│  │  5. Validate each place via Google Places              │  │
│  │  6. If substitution needed → re-narrate                │  │
│  │  7. Stream enriched itinerary to frontend              │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────┐  ┌─────────────────────────────┐          │
│  │ Claude API   │  │    Google Places API         │          │
│  │ (Sonnet)     │  │    (Text Search + Details)   │          │
│  └──────────────┘  └─────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

## End-to-End Data Flow

```
Onboarding (optional, skippable)
    │
    │  user makes 5 visual choices → TASTE_PROFILE_SCHEMA.json
    ▼
localStorage: `tripcurator.taste_profile` (or { skipped: true })
    │
    ▼
User writes briefing (free text, any language)
    │
    │  POST /api/itinerary { briefing, taste_profile }
    ▼
Backend assembles system prompt:
    TASTE.md
    + === USER TASTE PROFILE === block (see SYSTEM_PROMPT.md)
    + === OUTPUT INSTRUCTIONS ===
    + ITINERARY_SCHEMA.json
    │
    ▼
Claude API (streaming) → structured JSON itinerary
    │
    ▼
Google Places validation pass (Scenario C):
    • Text Search per recommendation
    • Match → enrich (place_id, photo, rating, hours, coords, address)
    • No match → category fallback → top-3 alternatives → Claude re-narrates
    • happy_accident blocks are skipped (buffer time, not anchored)
    │
    ▼
Frontend renders validated itinerary (with progressive updates
as enrichment lands per place)
```

### Taste Profile contract

- **Where it lives:** `localStorage` only in V1 (no user accounts, no server storage).
- **Shape:** conforms to `docs/TASTE_PROFILE_SCHEMA.json`.
- **When it's absent:** user skipped onboarding OR localStorage is cold. Backend must accept `taste_profile: null` and the prompt assembly injects the block with `null` so Claude applies the documented defaults (see `SYSTEM_PROMPT.md`).
- **What it overrides:** only SUBJECTIVE calibration (restaurant style, atmosphere, pace, grit level). TASTE.md structural rules (1-1-1, morning ritual, grit warnings, Companion Filter, Disqualifiers, Immigrant/Diaspora Cuisine rule) are invariant.
- **Versioning:** the schema has a top-level `version` field. On mismatch, the frontend discards the stored profile and treats the user as skipped.

## Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend | React + Vite + TypeScript | Fast dev, familiar, good for portfolio |
| Styling | Tailwind CSS | Rapid prototyping, responsive |
| Backend | Vercel Edge Functions (or Next.js API routes) | Serverless, free tier, streaming support |
| AI | Claude API (claude-sonnet-4-20250514) | Structured output, streaming, cost-effective |
| Places Data | Google Places API (New) | Text Search + Place Details for validation |
| Maps | Google Maps JS API or Mapbox | Render itinerary on map |
| Export | html-to-pdf (or Puppeteer) | PDF generation |
| Sharing | Vercel KV (or Upstash Redis) | Store shareable itinerary links |
| Analytics | Plausible or Umami | Privacy-first, simple |
| Deploy | Vercel | Free tier, GitHub integration |

## Data Flow — Detailed

### 0. Onboarding (optional)

```typescript
// Frontend-only. Runs before the briefing input is shown, unless the user
// chooses "Skip — I'll tell you everything in the briefing."
const tasteProfile: TasteProfile = collectVisualChoices()
// Conforms to docs/TASTE_PROFILE_SCHEMA.json
localStorage.setItem('tripcurator.taste_profile', JSON.stringify(tasteProfile))
```

If the user skips, we store `{ version: "1.0", skipped: true }` so we can distinguish "hasn't onboarded yet" from "chose to skip."

### 1. Briefing → AI Call

```typescript
// System prompt assembly (see SYSTEM_PROMPT.md for the full template):
//   TASTE.md + TASTE_PROFILE block + OUTPUT INSTRUCTIONS + ITINERARY_SCHEMA
const tasteProfile = loadTasteProfileFromLocalStorage() // may be null/skipped
const systemPrompt = buildSystemPrompt(tasteProfile)

// User message = briefing + any refinement answers
const userMessage = briefing

const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 16000,
  system: systemPrompt,
  messages: [{ role: 'user', content: userMessage }],
  stream: true,
})
```

### 2. Parse + Validate

```typescript
// After full JSON received from streaming
const itinerary: Itinerary = JSON.parse(aiResponse);

// Extract all recommendations
const allPlaces = extractAllRecommendations(itinerary);

// Validate in parallel
const validationResults = await Promise.all(
  allPlaces.map(place => validateWithGooglePlaces(place))
);
```

### 3. Google Places Validation

```typescript
async function validateWithGooglePlaces(place: Recommendation) {
  // Step 1: Text Search with place name + neighborhood + destination
  const searchQuery = `${place.name} ${place.neighborhood} ${destination}`;
  const searchResult = await googlePlaces.textSearch(searchQuery);

  if (searchResult.matches.length > 0) {
    // Match found — enrich
    const details = await googlePlaces.placeDetails(searchResult.matches[0].place_id);
    return {
      status: "validated",
      original: place,
      enrichment: {
        place_id: details.place_id,
        rating: details.rating,
        total_ratings: details.user_ratings_total,
        photo_url: details.photos?.[0]?.url,
        opening_hours: details.opening_hours?.weekday_text,
        address: details.formatted_address,
        website: details.website,
        coordinates: {
          lat: details.geometry.location.lat,
          lng: details.geometry.location.lng,
        },
      },
    };
  } else {
    // No match — search by criteria
    const fallbackQuery = `${place.category} ${place.neighborhood} ${destination}`;
    const alternatives = await googlePlaces.textSearch(fallbackQuery, { maxResults: 3 });
    return {
      status: "needs_substitution",
      original: place,
      alternatives: alternatives.matches,
    };
  }
}
```

### 4. Re-narration (for substitutions only)

```typescript
// Only called when Google Places couldn't validate a place
async function reNarrate(original: Recommendation, alternative: GooglePlace) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    system: TASTE_MD_CONTENT,
    messages: [{
      role: "user",
      content: `
        The originally recommended place "${original.name}" could not be verified.
        Here is a verified alternative from Google Places:
        
        Name: ${alternative.name}
        Address: ${alternative.address}
        Rating: ${alternative.rating} (${alternative.total_ratings} reviews)
        Type: ${alternative.types.join(', ')}
        
        Generate the recommendation fields (soul_factor, grit_warning, local_order, the_anchor)
        for this place, maintaining the editorial voice of TASTE.md.
        Respond as JSON matching the recommendation schema.
      `
    }],
  });
  
  return JSON.parse(response.content[0].text);
}
```

## Streaming Strategy

The frontend receives data in phases:

1. **Immediate (0-2s):** Loading state with contextual message ("Crafting your Provence itinerary...")
2. **Phase 1 (2-8s):** AI response streams in. Frontend parses JSON incrementally and renders each day as it completes.
3. **Phase 2 (parallel):** Google Places validation fires for all places simultaneously. Cards show "verifying..." then update with photos/ratings.
4. **Phase 3 (if needed):** Re-narration calls for substituted places. Cards update with new editorial content.

## API Cost Estimation (per itinerary)

| Service | Calls | Est. Cost |
|---------|-------|-----------|
| Claude Sonnet (generation) | 1 | ~$0.02-0.05 |
| Claude Sonnet (re-narration) | 0-5 | ~$0.01-0.03 |
| Google Places Text Search | 15-25 | Free tier (up to 5K/month) |
| Google Places Details | 15-25 | Free tier (up to 5K/month) |
| **Total per itinerary** | | **~$0.03-0.08** |

At 50 users generating ~3 itineraries each = 150 itineraries = **~$5-12 total.**

## Key Technical Decisions

### Why Structured JSON over Free Text
- Enables rich UI rendering (cards, maps, timelines)
- Enables automated eval (parse → check against rubric)
- Enables Google Places validation (need structured name + neighborhood)
- Enables future features (voting, reordering, filtering)

### Why Sonnet over Opus
- 5-10x cheaper per token
- Faster response time (important for streaming UX)
- Quality is sufficient for travel curation — Opus is overkill

### Why Edge Functions over traditional backend
- Cold start < 50ms (vs seconds for Lambda)
- Streaming support native
- No server to manage
- Vercel free tier is generous for portfolio project

### Why NOT a database in V1
- No user accounts = no persistent data to store
- Shareable links need only a KV store (key = random ID, value = itinerary JSON)
- Keeps architecture simple and free
