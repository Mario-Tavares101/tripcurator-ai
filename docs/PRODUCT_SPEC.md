# Product Spec — TripCurator AI (V1 MVP)

## Objective

Build a portfolio-grade web app that demonstrates AI product thinking, prompt engineering, and system integration. Success = 50 real users + a compelling case study for PM interviews.

## Target Persona

**Mario Tavares** — 27, São Paulo, upper-middle class. Travels 2x/year with friends, 5x/year with girlfriend. Values authentic experiences over tourist attractions. Researches obsessively but struggles to synthesize fragmented information into a coherent plan. Follows food/travel creators. Reads Esquire. Cares about taste, not stars.

## Job To Be Done

> "Help me get an authentic travel experience at a specific destination — with the quality of a local friend's recommendation, in 2 minutes instead of 20 hours of research."

## User Flow — V1

### Step 1: Landing
- Clean landing page with a single text input
- Placeholder text: "Tell me about your next trip..."
- No login. No sign-up. Zero friction.
- Examples below the input to inspire: "5 days in Lisbon, couple, food and wine, nothing touristy"

### Step 2: Briefing
- User types their trip description in natural language
- AI processes and may ask 2-3 refinement questions:
  - "What's your vibe — are you more 'eat at the counter where locals eat' or 'beautiful courtyard with candles'?"
  - "Any dietary restrictions or mobility constraints?"
  - "Is there anything you've already booked (flights, hotel)?"
- Refinement questions are optional — AI proceeds with best inference if user skips

### Step 3: Itinerary Generation
- Streaming response: itinerary renders progressively, day by day
- Each place shows with editorial narrative (soul_factor, grit_warning, local_order)
- Google Places validation runs in parallel:
  - Places show "verifying..." indicator
  - Once validated: photo, rating, hours appear
  - If substituted: card updates with new place + re-narrated editorial
- Map view available alongside the day-by-day view

### Step 4: Export
- Share as link (read-only view, no login required for viewer)
- Export as PDF (clean, printable)
- Copy as markdown

## What's In V1

| Feature | Priority | Rationale |
|---------|----------|-----------|
| Natural language trip briefing | P0 | Core interaction |
| AI-generated structured itinerary | P0 | Core output |
| TASTE.md editorial voice | P0 | Product differentiator |
| Google Places validation + enrichment | P0 | Anti-hallucination, credibility |
| Streaming response | P0 | UX — perceived speed |
| Day-by-day rendered view | P0 | Core UI |
| Map view per day | P1 | Spatial context |
| PDF export | P1 | Shareable output |
| Link sharing (read-only) | P1 | Distribution |
| 2-3 refinement questions | P1 | Better input → better output |
| Persona detection | P2 | Enhances curation quality |
| Companion filter | P2 | Adapts to travel context |

## What's NOT in V1

| Feature | Why Not |
|---------|---------|
| User accounts / login | Friction. Portfolio product doesn't need auth. |
| Booking / reservations | Requires complex API partnerships. Not core value. |
| Skyscanner / flight integration | Same — adds complexity, not differentiation. |
| Conversational refinement ("swap day 3") | V2 feature. Requires conversation state management. |
| Onboarding questionnaire | V2. V1 relies on the briefing itself. |
| Group collaboration | V3. Requires multi-user state. |
| Proactive AI suggestions | Vision feature. Needs user history. |
| Payment / monetization | Portfolio product. |

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Itineraries generated | 100+ | Backend logs |
| Unique users | 50+ | Simple analytics (Plausible/Umami) |
| Completion rate | >60% | % of briefings that result in full itinerary view |
| Share rate | >20% | % of itineraries exported or shared |
| Factual accuracy | >90% | Google Places validation pass rate |
| Eval pass rate | All evals ≥3.5 avg | Manual eval rubric |

## Technical Constraints

- **Budget:** Minimize API costs. Claude Sonnet for generation (not Opus). Google Places has free tier.
- **Latency:** Itinerary must start rendering within 3 seconds of submission.
- **Mobile-first:** Primary use case is phone. UI must be responsive.
- **No backend database in V1:** Stateless. Each itinerary is generated fresh. Shareable links can use a simple KV store (Vercel KV or similar).
