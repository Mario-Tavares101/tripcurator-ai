# TripCurator AI

**One-liner:** A web app where travelers describe what they want in natural language and receive a curated itinerary with the depth of a well-traveled friend — not a generic Google list.

## The Problem

Travel planning lives in a limbo. TripAdvisor and Google give you the "Top 10" everyone already knows. Content creators deliver incredible curation, but it's fragmented across reels, stories, and articles. Stitching it all into a coherent itinerary is manual, time-consuming, and depends entirely on how much you researched.

TripCurator AI is the friend who researches as much as you do — but organizes everything in 2 minutes.

## Core Architecture — Scenario C (Hybrid)

The system combines AI curation with real-world data validation:

```
User Briefing
    ↓
[1] AI generates framework + specific place names
    (guided by TASTE.md editorial voice)
    ↓
[2] Backend validates each place via Google Places API
    ├── Match found → enrich with photo, rating, hours, coordinates
    ├── No match → query Google Places by criteria, get top 3 alternatives
    └── Ambiguous → same as no match
    ↓
[3] If substitutions occurred → second AI call to re-narrate
    (maintains TASTE.md editorial voice for new places)
    ↓
[4] Frontend renders validated, enriched itinerary
```

## Key Design Decisions

- **Structured JSON output from AI** — not free text. Enables rich UI rendering and eval automation.
- **Streaming + async validation** — itinerary renders progressively; Google Places validation happens in parallel.
- **Editorial voice via TASTE.md** — injected into system prompt. Defines the product's soul.
- **No login in V1** — zero friction. Onboarding is the briefing itself.

## Project Structure

```
tripcurator-ai/
├── README.md                          # This file
├── docs/
│   ├── TASTE.md                       # Editorial manifesto (→ system prompt)
│   ├── SYSTEM_PROMPT.md               # Full system prompt spec
│   ├── ITINERARY_SCHEMA.json          # AI output contract
│   ├── PRODUCT_SPEC.md                # MVP scope, flows, what's in/out
│   └── ARCHITECTURE.md                # Technical architecture decisions
├── evals/
│   ├── EVAL_FRAMEWORK.md              # Rubric and methodology
│   ├── eval_01_provence.json          # Easy — known destination
│   ├── eval_02_lisboa.json            # Medium — partial knowledge
│   └── eval_03_oaxaca.json           # Hard — unknown destination
└── src/                               # (implementation — later)
```

## Roadmap

### V1 — Core (Weeks 1-2)
- Conversational input → AI generates structured itinerary
- Google Places validation + enrichment
- Render itinerary with photos, ratings, editorial narrative
- Export as shareable link or PDF

### V2 — Refinement (Weeks 3-4)
- Conversational refinement ("swap day 3 dinner")
- Preference onboarding that persists
- Companion filter (traveling with parents, partner, group)

### V3 — Collaboration (Weeks 5-6)
- Share via link, group members vote on recommendations
- Organizer dashboard
- Polish, launch, collect feedback

## Not in Scope (V1)
- Booking / reservations
- Skyscanner integration
- User accounts / login
- Proactive AI suggestions
- Payment
