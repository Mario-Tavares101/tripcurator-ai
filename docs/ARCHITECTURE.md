# Architecture — TripCurator AI

## System Overview

```
┌─────────────────────────────────────────────────────┐
│                    Frontend (React + Vite)           │
│                                                     │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Briefing  │→│  Itinerary   │→│    Export      │  │
│  │  Input    │  │   Viewer     │  │  (PDF/Link)   │  │
│  └──────────┘  └──────────────┘  └───────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │ API calls
                       ▼
┌─────────────────────────────────────────────────────┐
│              Backend (Edge Functions / API Routes)    │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │              Orchestrator                     │   │
│  │                                               │   │
│  │  1. Receive briefing                          │   │
│  │  2. Call Claude API (streaming)               │   │
│  │  3. Parse structured JSON response            │   │
│  │  4. Validate each place via Google Places     │   │
│  │  5. If substitution needed → re-narrate       │   │
│  │  6. Stream enriched itinerary to frontend     │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──────────────┐  ┌─────────────────────────────┐  │
│  │ Claude API   │  │    Google Places API         │  │
│  │ (Sonnet)     │  │    (Text Search + Details)   │  │
│  └──────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

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

### 1. Briefing → AI Call

```typescript
// System prompt = TASTE.md content + ITINERARY_SCHEMA instruction
const systemPrompt = `
${TASTE_MD_CONTENT}

You must respond with a valid JSON object matching the following schema:
${JSON.stringify(ITINERARY_SCHEMA)}

Do not include any text outside the JSON object.
`;

// User message = briefing + any refinement answers
const userMessage = briefing;

const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 8000,
  system: systemPrompt,
  messages: [{ role: "user", content: userMessage }],
  stream: true,
});
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
