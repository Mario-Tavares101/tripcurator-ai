/**
 * validate_places.ts — Scenario C (ARCHITECTURE.md §Data Flow)
 *
 * Pipeline:
 *   1. Generate itinerary from briefing via Claude (or reuse cached result)
 *   2. For each recommendation, call Google Places Text Search with
 *      name + neighborhood + destination
 *   3. On match → enrich with place_id, photo, rating, hours, coordinates, address
 *   4. On miss → search by category + neighborhood + destination, take top 3
 *      alternatives, pick the best, then call Claude to re-narrate the
 *      substitution maintaining TASTE.md voice
 *   5. Write the final validated itinerary to evals/results/eval_01_validated.json
 *
 * Usage: npm run eval:01:validated
 * Requires: ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY (loaded from repo .env)
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

// ── .env loader (no external deps) ─────────────────────────────────────────
// Tries worktree root first, then main repo root (parent of .claude/worktrees/*).

function loadEnv() {
  const candidates = [
    resolve(root, '.env'),
    resolve(root, '../../../.env'), // main repo root when running from a worktree
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const raw = readFileSync(p, 'utf-8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      const key = m[1]
      let val = m[2]
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (!process.env[key]) process.env[key] = val
    }
  }
}
loadEnv()

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY
if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set')
if (!GOOGLE_KEY) throw new Error('GOOGLE_PLACES_API_KEY not set')

// ── Load source files ──────────────────────────────────────────────────────

const tasteMd = readFileSync(resolve(root, 'docs/TASTE.md'), 'utf-8')
const schemaJson = readFileSync(resolve(root, 'docs/ITINERARY_SCHEMA.json'), 'utf-8')
const evalData = JSON.parse(readFileSync(resolve(root, 'evals/eval_01_sao_paulo.json'), 'utf-8'))

// ── Types (minimal — matches ITINERARY_SCHEMA.json) ────────────────────────

type Recommendation = {
  name: string
  neighborhood: string
  category: string
  soul_factor: string
  grit_warning: string
  local_order?: string
  the_anchor?: string
  estimated_budget_per_person?: string
  duration_minutes?: number
  coordinates?: { lat: number; lng: number }
  google_places_status?: 'validated' | 'substituted' | 'not_checked'
  google_places_data?: {
    place_id?: string
    rating?: number
    total_ratings?: number
    photo_url?: string
    opening_hours?: string[]
    address?: string
    website?: string
  }
}

type Day = {
  day_number: number
  morning_ritual: Recommendation
  blocks: Array<{ block_type: string; recommendation: Recommendation; [k: string]: unknown }>
  [k: string]: unknown
}

type Itinerary = {
  trip_metadata: { destination: string; country: string; [k: string]: unknown }
  days: Day[]
  [k: string]: unknown
}

// ── Google Places (New) client ─────────────────────────────────────────────
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search

type GooglePlace = {
  id: string
  displayName?: { text: string }
  formattedAddress?: string
  rating?: number
  userRatingCount?: number
  websiteUri?: string
  regularOpeningHours?: { weekdayDescriptions?: string[] }
  location?: { latitude: number; longitude: number }
  photos?: Array<{ name: string }>
  types?: string[]
  primaryType?: string
}

const PLACES_BASE = 'https://places.googleapis.com/v1/places:searchText'
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.regularOpeningHours',
  'places.location',
  'places.photos',
  'places.types',
  'places.primaryType',
].join(',')

// Runtime toggle: start with the "New" Places API. If the project has only
// the legacy Places API enabled (common on older GCP projects), we fall back
// on the first SERVICE_DISABLED 403 and stick with legacy for the rest of the
// run so we don't re-probe 15 times.
let useLegacy = false

async function textSearchNew(query: string, maxResults: number): Promise<GooglePlace[]> {
  const res = await fetch(PLACES_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY!,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: query, pageSize: maxResults }),
  })
  if (!res.ok) {
    const body = await res.text()
    if (res.status === 403 && body.includes('SERVICE_DISABLED')) {
      useLegacy = true
      return textSearchLegacy(query, maxResults)
    }
    throw new Error(`Google Places (New) textSearch failed (${res.status}): ${body}`)
  }
  const json = (await res.json()) as { places?: GooglePlace[] }
  return json.places ?? []
}

// Legacy Places API (Text Search + Place Details) shim. Maps responses onto
// the same GooglePlace shape the rest of the pipeline consumes.
type LegacyPlace = {
  place_id: string
  name?: string
  formatted_address?: string
  rating?: number
  user_ratings_total?: number
  geometry?: { location: { lat: number; lng: number } }
  photos?: Array<{ photo_reference: string }>
  types?: string[]
  opening_hours?: { weekday_text?: string[] }
  website?: string
}

async function textSearchLegacy(query: string, maxResults: number): Promise<GooglePlace[]> {
  const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json')
  url.searchParams.set('query', query)
  url.searchParams.set('key', GOOGLE_KEY!)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Google Places (legacy) textSearch failed (${res.status}): ${await res.text()}`)
  }
  const json = (await res.json()) as { status: string; results?: LegacyPlace[]; error_message?: string }
  if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
    throw new Error(`Google Places (legacy) status=${json.status}: ${json.error_message ?? ''}`)
  }
  const results = (json.results ?? []).slice(0, maxResults)
  // For each top result, fetch Place Details so we get opening hours and website.
  const enriched = await Promise.all(
    results.map(async r => {
      try {
        const d = await placeDetailsLegacy(r.place_id)
        return mapLegacyToNew({ ...r, ...d })
      } catch {
        return mapLegacyToNew(r)
      }
    }),
  )
  return enriched
}

async function placeDetailsLegacy(placeId: string): Promise<LegacyPlace> {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json')
  url.searchParams.set('place_id', placeId)
  url.searchParams.set(
    'fields',
    'place_id,name,formatted_address,rating,user_ratings_total,geometry,photos,types,opening_hours,website',
  )
  url.searchParams.set('key', GOOGLE_KEY!)
  const res = await fetch(url)
  const json = (await res.json()) as { status: string; result?: LegacyPlace }
  if (json.status !== 'OK') throw new Error(`legacy details status=${json.status}`)
  return json.result ?? ({ place_id: placeId } as LegacyPlace)
}

function mapLegacyToNew(r: LegacyPlace): GooglePlace {
  return {
    id: r.place_id,
    displayName: r.name ? { text: r.name } : undefined,
    formattedAddress: r.formatted_address,
    rating: r.rating,
    userRatingCount: r.user_ratings_total,
    websiteUri: r.website,
    regularOpeningHours: r.opening_hours?.weekday_text
      ? { weekdayDescriptions: r.opening_hours.weekday_text }
      : undefined,
    location: r.geometry
      ? { latitude: r.geometry.location.lat, longitude: r.geometry.location.lng }
      : undefined,
    // Legacy photo_reference requires a different URL format:
    photos: r.photos?.map(p => ({ name: `LEGACY:${p.photo_reference}` })),
    types: r.types,
    primaryType: r.types?.[0],
  }
}

async function textSearch(query: string, maxResults = 5): Promise<GooglePlace[]> {
  if (useLegacy) return textSearchLegacy(query, maxResults)
  return textSearchNew(query, maxResults)
}

function photoUrl(photoName: string | undefined, maxWidth = 1200): string | undefined {
  if (!photoName) return undefined
  if (photoName.startsWith('LEGACY:')) {
    const ref = photoName.slice('LEGACY:'.length)
    return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxWidth}&photo_reference=${ref}&key=${GOOGLE_KEY}`
  }
  return `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidth}&key=${GOOGLE_KEY}`
}

// ── Matching heuristic ─────────────────────────────────────────────────────
// A "match" is the top result when its displayName has meaningful overlap
// with the queried name. We normalise (lowercase, strip punctuation/accents)
// and require either substring containment or ≥50% token overlap.

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isLikelyMatch(queryName: string, candidate: GooglePlace): boolean {
  const a = normalize(queryName)
  const b = normalize(candidate.displayName?.text ?? '')
  if (!a || !b) return false
  if (a === b) return true
  if (b.includes(a) || a.includes(b)) return true
  const aTokens = new Set(a.split(' ').filter(t => t.length > 2))
  const bTokens = new Set(b.split(' ').filter(t => t.length > 2))
  if (aTokens.size === 0) return false
  let overlap = 0
  for (const t of aTokens) if (bTokens.has(t)) overlap++
  return overlap / aTokens.size >= 0.5
}

// ── Validation per recommendation ──────────────────────────────────────────

type ValidationOutcome =
  | { status: 'validated'; place: GooglePlace }
  | { status: 'needs_substitution'; alternatives: GooglePlace[] }

async function validate(
  rec: Recommendation,
  destination: string,
): Promise<ValidationOutcome> {
  const primaryQuery = [rec.name, rec.neighborhood, destination].filter(Boolean).join(' ')
  const primary = await textSearch(primaryQuery, 5)

  const match = primary.find(p => isLikelyMatch(rec.name, p))
  if (match) return { status: 'validated', place: match }

  const fallbackQuery = [rec.category, rec.neighborhood, destination].filter(Boolean).join(' ')
  const alternatives = await textSearch(fallbackQuery, 3)
  return { status: 'needs_substitution', alternatives: alternatives.slice(0, 3) }
}

function enrich(rec: Recommendation, place: GooglePlace): Recommendation {
  return {
    ...rec,
    coordinates: place.location
      ? { lat: place.location.latitude, lng: place.location.longitude }
      : rec.coordinates,
    google_places_status: 'validated',
    google_places_data: {
      place_id: place.id,
      rating: place.rating,
      total_ratings: place.userRatingCount,
      photo_url: photoUrl(place.photos?.[0]?.name),
      opening_hours: place.regularOpeningHours?.weekdayDescriptions,
      address: place.formattedAddress,
      website: place.websiteUri,
    },
  }
}

// ── Re-narration via Claude ────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

async function reNarrate(
  original: Recommendation,
  alternative: GooglePlace,
  destination: string,
): Promise<Recommendation> {
  const system = `${tasteMd}\n\nYou generate a single recommendation object that matches this schema:\n${schemaJson}\n\nRespond ONLY with a valid JSON object (no markdown, no preamble) matching the #/$defs/recommendation shape. You must produce: name, neighborhood, category, soul_factor, grit_warning, local_order, the_anchor, estimated_budget_per_person, duration_minutes. Maintain the editorial voice described in the system prompt above.`

  const user = `The originally recommended place "${original.name}" in ${original.neighborhood}, ${destination} could not be verified via Google Places.

Original recommendation (for voice/context — DO NOT copy its name):
${JSON.stringify(original, null, 2)}

Verified alternative from Google Places:
- Name: ${alternative.displayName?.text}
- Address: ${alternative.formattedAddress}
- Rating: ${alternative.rating ?? 'n/a'} (${alternative.userRatingCount ?? 0} reviews)
- Types: ${(alternative.types ?? []).join(', ')}
- Primary type: ${alternative.primaryType ?? 'n/a'}
- Website: ${alternative.websiteUri ?? 'n/a'}

Re-narrate this alternative as a TripCurator recommendation maintaining TASTE.md voice. Keep the same category ("${original.category}") unless the alternative is clearly a different kind of place. The neighborhood should reflect the alternative's actual location if different. Respond as a JSON object for a single recommendation — name must be the alternative's name.`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system,
    messages: [{ role: 'user', content: user }],
  })

  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('re-narration: no text block in response')
  }
  let raw = textBlock.text.trim()
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  }
  const rewritten = JSON.parse(raw) as Recommendation

  // Enrich the re-narrated rec with Google data from the alternative.
  return {
    ...rewritten,
    coordinates: alternative.location
      ? { lat: alternative.location.latitude, lng: alternative.location.longitude }
      : rewritten.coordinates,
    google_places_status: 'substituted',
    google_places_data: {
      place_id: alternative.id,
      rating: alternative.rating,
      total_ratings: alternative.userRatingCount,
      photo_url: photoUrl(alternative.photos?.[0]?.name),
      opening_hours: alternative.regularOpeningHours?.weekdayDescriptions,
      address: alternative.formattedAddress,
      website: alternative.websiteUri,
    },
  }
}

// ── Itinerary generation (or cache) ────────────────────────────────────────

const outputInstructions = `
=== OUTPUT INSTRUCTIONS ===

You are TripCurator AI, a travel architect that creates deeply curated itineraries. You have the editorial sensibility described above and you must follow it in every recommendation.

TASK: Based on the user's trip briefing, generate a complete itinerary.

PROCESS:
1. Read the briefing carefully.
2. Detect the persona archetype (Disciple, Aesthetic Soul, Deep Diver, Night Wanderer) from the user's language and priorities. Do not ask — infer.
3. Detect the companion type (solo, couple, friends_group, family, family_with_kids).
4. Apply the Companion Filter if relevant.
5. Generate a day-by-day itinerary following the 1-1-1 Rule and Slow Flow principles.
6. Every day MUST include a morning_ritual.
7. Include at least one "happy_accident" buffer block per day.
8. For each recommendation, provide: soul_factor, grit_warning, local_order, the_anchor.
9. Include practical_notes for the whole trip.

CRITICAL RULES:
- Recommend REAL places that you are confident exist. Use specific names, not generic descriptions.
- If you are uncertain whether a place exists, still include it — the backend will validate via Google Places API.
- Do NOT fabricate history or chef names. If you don't know a place's specific story, focus on the neighborhood and cuisine type.
- Follow the 1-1-1 Rule strictly: max 1 major_anchor, 1 culinary_quest, 1 atmospheric_drift per day.
- Include transition_notes between blocks (walking time, driving time, transport mode).
- Budget estimates should be per person in local currency.
- Coordinates should be your best estimate — they will be corrected by Google Places.

OUTPUT FORMAT:
Respond ONLY with a valid JSON object. No markdown, no explanation, no preamble.
The JSON must conform to this schema:
${schemaJson}
`

async function generateItinerary(): Promise<Itinerary> {
  console.log('Calling Claude API to generate itinerary…')
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    system: `${tasteMd}\n${outputInstructions}`,
    messages: [{ role: 'user', content: evalData.user_briefing }],
  })
  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') throw new Error('No text block')
  let raw = textBlock.text.trim()
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  }
  console.log(
    `  tokens — input: ${response.usage.input_tokens}, output: ${response.usage.output_tokens}`,
  )
  return JSON.parse(raw) as Itinerary
}

function loadCachedItinerary(): Itinerary | null {
  const candidates = [
    resolve(root, 'evals/results/eval_01_result.json'),
    resolve(root, '../../../evals/results/eval_01_result.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const raw = JSON.parse(readFileSync(p, 'utf-8'))
    if (raw.itinerary) {
      console.log(`→ Using cached itinerary from ${p}`)
      return raw.itinerary as Itinerary
    }
  }
  return null
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('━'.repeat(60))
  console.log(`VALIDATE PIPELINE: ${evalData.eval_id}`)
  console.log('━'.repeat(60))

  const useCache = process.argv.includes('--use-cache')
  let itinerary: Itinerary
  if (useCache) {
    const cached = loadCachedItinerary()
    if (!cached) throw new Error('--use-cache passed but no cached itinerary found')
    itinerary = cached
  } else {
    itinerary = await generateItinerary()
  }

  const destination = itinerary.trip_metadata.destination
  console.log(`\nDestination: ${destination}`)
  console.log(`Days: ${itinerary.days.length}`)

  // Collect all recommendation "slots" with setter functions so we can mutate
  // the itinerary in place after validation.
  type Slot = {
    label: string
    get: () => Recommendation
    set: (r: Recommendation) => void
  }
  const slots: Slot[] = []
  itinerary.days.forEach((day, di) => {
    slots.push({
      label: `Day ${day.day_number} morning_ritual`,
      get: () => day.morning_ritual,
      set: r => {
        itinerary.days[di].morning_ritual = r
      },
    })
    day.blocks.forEach((block, bi) => {
      // Skip happy_accident buffer blocks — per TASTE.md these are
      // unstructured wandering time, not anchored establishments. Their
      // "name" field is usually a street or area description that can't be
      // meaningfully resolved via Google Places Text Search. Validating them
      // produces low-quality substitutions (e.g. "Walking" 5⭐). We mark them
      // as not_checked so the frontend knows they're intentionally unenriched.
      if (block.block_type === 'happy_accident') {
        itinerary.days[di].blocks[bi].recommendation = {
          ...block.recommendation,
          google_places_status: 'not_checked',
        }
        return
      }
      slots.push({
        label: `Day ${day.day_number} block ${bi + 1} (${block.block_type})`,
        get: () => block.recommendation,
        set: r => {
          itinerary.days[di].blocks[bi].recommendation = r
        },
      })
    })
  })

  console.log(`Total recommendations to validate: ${slots.length} (happy_accident blocks skipped)\n`)

  // Run Google Places validation in parallel.
  const outcomes = await Promise.all(
    slots.map(async slot => {
      const rec = slot.get()
      try {
        const outcome = await validate(rec, destination)
        return { slot, rec, outcome, error: null as string | null }
      } catch (err) {
        return { slot, rec, outcome: null, error: (err as Error).message }
      }
    }),
  )

  let validated = 0
  let substituted = 0
  let failed = 0

  // Apply validated enrichments first (sync); queue substitutions for Claude.
  const substitutionJobs: Array<{ slot: Slot; rec: Recommendation; alternatives: GooglePlace[] }> =
    []

  for (const o of outcomes) {
    if (o.error || !o.outcome) {
      console.log(`  ✗ ${o.slot.label} — ${o.rec.name} [error: ${o.error}]`)
      o.slot.set({ ...o.rec, google_places_status: 'not_checked' })
      failed++
      continue
    }
    if (o.outcome.status === 'validated') {
      console.log(
        `  ✓ ${o.slot.label} — ${o.rec.name} → ${o.outcome.place.displayName?.text} (${o.outcome.place.rating ?? '?'}⭐)`,
      )
      o.slot.set(enrich(o.rec, o.outcome.place))
      validated++
    } else {
      console.log(
        `  ~ ${o.slot.label} — ${o.rec.name} [no match, ${o.outcome.alternatives.length} alternatives]`,
      )
      substitutionJobs.push({ slot: o.slot, rec: o.rec, alternatives: o.outcome.alternatives })
    }
  }

  // Re-narrate substitutions via Claude (sequential — keeps voice consistent,
  // avoids rate limit bursts).
  if (substitutionJobs.length > 0) {
    console.log(`\nRe-narrating ${substitutionJobs.length} substitution(s)…`)
  }
  for (const job of substitutionJobs) {
    if (job.alternatives.length === 0) {
      console.log(`  ✗ ${job.slot.label} — no alternatives available, leaving as-is`)
      job.slot.set({ ...job.rec, google_places_status: 'not_checked' })
      failed++
      continue
    }
    // Pick the top alternative (Places returns them ranked by relevance).
    const pick = job.alternatives[0]
    console.log(
      `  → ${job.slot.label}: "${job.rec.name}" → "${pick.displayName?.text}" (${pick.rating ?? '?'}⭐)`,
    )
    try {
      const rewritten = await reNarrate(job.rec, pick, destination)
      job.slot.set(rewritten)
      substituted++
    } catch (err) {
      console.log(`    ✗ re-narration failed: ${(err as Error).message}`)
      job.slot.set({ ...job.rec, google_places_status: 'not_checked' })
      failed++
    }
  }

  console.log('\n━'.repeat(60))
  console.log(`Validated:   ${validated}`)
  console.log(`Substituted: ${substituted}`)
  console.log(`Failed:      ${failed}`)
  console.log('━'.repeat(60))

  // Write output
  const resultsDir = resolve(root, 'evals/results')
  mkdirSync(resultsDir, { recursive: true })
  const outPath = resolve(resultsDir, 'eval_01_validated.json')
  const out = {
    eval_id: evalData.eval_id,
    timestamp: new Date().toISOString(),
    pipeline: 'scenario_c_google_places_validation',
    summary: {
      total: slots.length,
      validated,
      substituted,
      failed,
    },
    itinerary,
  }
  writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`\n→ Wrote ${outPath}`)
}

main().catch(err => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
