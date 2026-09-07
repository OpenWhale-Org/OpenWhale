/**
 * Which venue a catalogue picker should list.
 *
 * A catalogue is addressed by (kind, venue), and the venue is the runtime's to
 * know — `implementationVenue()`. The dashboard only reads it, and reads it
 * here: the same two-step used to live in three components, where the shortest
 * copy passed every CEX test and failed on the first on-chain plugin, because
 * an account's `type` is its CREDENTIAL type and only coincides with the venue
 * on exchanges. A Boros account binds a `pendle/boros-agent` key and trades on
 * `boros`.
 */

export interface VenueBearingAccount {
  /** Venue pin, resolved by the runtime. Preferred; absent on older gateways. */
  venue?: string
  /** Account implementation id — the key into the implementation pins. */
  implementation?: string
  /** Credential type. Equal to the venue on a CEX, and misleading elsewhere. */
  type?: string
}

/**
 * @param implVenues implementation id → venue, from `/api/accounts`
 *        `implementations[]`. Only needed against a gateway that predates
 *        `account.venue`; harmless to pass always.
 */
export function pickerVenue(
  account: VenueBearingAccount | undefined,
  implVenues: Record<string, string> = {},
): string | undefined {
  if (!account) return undefined
  return account.venue ?? (account.implementation ? implVenues[account.implementation] : undefined) ?? account.type
}

/** Build the implementation → venue map from an `/api/accounts` response. */
export function implVenueMap(
  implementations: Array<{ id: string; venue?: string; type?: string }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const impl of implementations ?? []) {
    // `type` is the deprecated spelling of the same pin; keep reading it so a
    // new dashboard works against an older gateway.
    const venue = impl.venue ?? impl.type
    if (venue) out[impl.id] = venue
  }
  return out
}

/**
 * The value a key/param field currently HOLDS, as the form sees it.
 *
 * An untouched `<select>` keeps state at '' while displaying its first option,
 * so "what will be submitted" and "what is on screen" are the schema default,
 * then the first option. Render, submit and catalogue lookup all have to agree
 * on that, and they only will while they call the same function.
 */
export function effectiveValue(
  field: { name: string; default?: unknown; options?: Array<{ value: unknown }> } | undefined,
  values: Record<string, string>,
): string {
  if (!field) return ''
  const typed = (values[field.name] ?? '').trim()
  if (typed) return typed
  if (field.default !== undefined) return String(field.default)
  const first = field.options?.[0]
  return first !== undefined ? String(first.value) : ''
}
