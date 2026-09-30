/**
 * Why does this file exist? A region is surveyed geometry under fictional names: every street, waterway and district
 * the world compiler takes from the sources leaves with a name made here, and no real name survives. The names are
 * compounds of two original word lists (a nature or material word and a place ending: "Ashbrook", "Copperdale"),
 * chosen by a hash of the real name, so the same real street always gets the same fictional one, across every segment
 * and every compile.
 * - A real street keeps its type and direction ("… Street West"): those are ordinary words, not names.
 * - Never a real name: every candidate is checked against the region's own real names and a denylist the compiler is
 *   given (the region's places), whole-word and in any case, and skipped if it matches or is already taken.
 * - Injective: two real names never share a fictional one.
 * What breaks if it is removed? The compiled region would carry the real names of its streets, which the product
 * must never show.
 */

/** Original first halves: trees, birds, stones, weather, craft. */
export const NAME_HEADS: readonly string[] = Object.freeze([
  'Alder', 'Amber', 'Anvil', 'Apple', 'Ash', 'Aspen', 'Aster', 'Autumn', 'Bark', 'Barley', 'Basalt', 'Beacon', 'Beech',
  'Bell', 'Birch', 'Bittern', 'Bracken', 'Bramble', 'Brass', 'Briar', 'Bronze', 'Brook', 'Bunting', 'Butternut',
  'Calico', 'Candle', 'Canvas', 'Catkin', 'Cedar', 'Chalk', 'Chestnut', 'Cinder', 'Clay', 'Clover', 'Cobble', 'Comet',
  'Copper', 'Coral', 'Cotton', 'Crane', 'Cricket', 'Crocus', 'Crystal', 'Curlew', 'Cypress', 'Daisy', 'Dapple', 'Dawn',
  'Dove', 'Dusk', 'Ember', 'Falcon', 'Fawn', 'Feather', 'Fern', 'Fiddle', 'Finch', 'Fir', 'Flax', 'Flint', 'Frost',
  'Garnet', 'Ginger', 'Glass', 'Gorse', 'Granite', 'Hawthorn', 'Hazel', 'Heather', 'Hemlock', 'Heron', 'Hickory',
  'Holly', 'Honey', 'Indigo', 'Iris', 'Iron', 'Ivory', 'Jasper', 'Juniper', 'Kestrel', 'Kiln', 'Lantern', 'Larch',
  'Lark', 'Laurel', 'Lavender', 'Ledger', 'Lichen', 'Lilac', 'Linden', 'Linnet', 'Loam', 'Loom', 'Lupin', 'Magpie',
  'Mallow', 'Marigold', 'Marten', 'Merlin', 'Mica', 'Millstone', 'Mistle', 'Moth', 'Nettle', 'Nutmeg', 'Oat', 'Ochre',
  'Opal', 'Orchid', 'Osprey', 'Otter', 'Owl', 'Pebble', 'Pepper', 'Pewter', 'Pheasant', 'Pigeon', 'Pinecone',
  'Plover', 'Plum', 'Poplar', 'Poppy', 'Primrose', 'Quail', 'Quartz', 'Quill', 'Raven', 'Reed', 'Rook', 'Rowan',
  'Rush', 'Russet', 'Rye', 'Saffron', 'Sandpiper', 'Satin', 'Sedge', 'Shale', 'Silver', 'Siskin', 'Slate', 'Sorrel',
  'Sparrow', 'Spindle', 'Spruce', 'Starling', 'Sumac', 'Swallow', 'Sycamore', 'Tallow', 'Tamarack', 'Tansy', 'Teal',
  'Tern', 'Thatch', 'Thistle', 'Thrush', 'Tinder', 'Topaz', 'Trillium', 'Tulip', 'Umber', 'Velvet', 'Verbena',
  'Violet', 'Walnut', 'Warbler', 'Wheat', 'Whistle', 'Willet', 'Winter', 'Wool', 'Yarrow', 'Yew', 'Zinnia',
])

/** Original second halves: place endings. */
export const NAME_TAILS: readonly string[] = Object.freeze([
  'bank', 'brook', 'bury', 'combe', 'crest', 'croft', 'dale', 'dene', 'down', 'fell', 'field', 'fold', 'ford', 'garth',
  'gate', 'glen', 'grove', 'haven', 'hollow', 'holm', 'hurst', 'knoll', 'lea', 'mead', 'mere', 'moor', 'reach',
  'rigg', 'shaw', 'side', 'stead', 'thorpe', 'vale', 'view', 'wald', 'well', 'wick', 'wold', 'wood', 'worth',
])

/** How many distinct names the lists can make. */
export const NAME_SPACE = NAME_HEADS.length * NAME_TAILS.length

/** FNV-1a over a string, then a finalizer: a stable 32-bit hash. */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Letters and digits only, upper case: how names are compared. */
export const normal = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()

/** The i-th candidate of the name space (0 ≤ i < NAME_SPACE), a stride permutation so neighbours differ. */
function candidate(i: number): string {
  const k = (i * 7919) % NAME_SPACE // 7919 is prime and shares no factor with the space's size (checked in the tests)
  return NAME_HEADS[k % NAME_HEADS.length] + NAME_TAILS[Math.floor(k / NAME_HEADS.length)]
}

/**
 * A book of fictional names for one region: `name(real)` gives the same fictional name for the same real one, never
 * a name in `deny` (whole words, any case) nor one already given. `deny` holds the region's real names; the book adds
 * each real name it is asked about as it goes, so a real street is never another's fictional name.
 */
export class NameBook {
  private readonly deny = new Set<string>()
  private readonly denyWords = new Set<string>()
  private readonly given = new Map<string, string>()
  private readonly taken = new Set<string>()
  private readonly salt: string

  constructor(deny: Iterable<string>, salt = 'region') {
    this.salt = salt
    for (const d of deny) this.forbid(d)
  }

  /** Adds a real name to the denylist (its whole form and each of its words of four letters or more). */
  forbid(real: string): void {
    const n = normal(real)
    if (!n) return
    this.deny.add(n)
    for (const w of n.split(' ')) if (w.length >= 4) this.denyWords.add(w)
  }

  /** Whether a candidate is allowed: not a real name, not containing a real name's word, not taken. */
  allowed(name: string): boolean {
    const n = normal(name)
    if (this.deny.has(n) || this.taken.has(n)) return false
    for (const w of n.split(' ')) if (this.denyWords.has(w)) return false
    return true
  }

  /** The fictional name for a real one (its body only: type and direction are kept by the caller). */
  name(real: string): string {
    const key = normal(real)
    const had = this.given.get(key)
    if (had !== undefined) return had
    this.forbid(real)
    const start = hash32(`${this.salt}:${key}`) % NAME_SPACE
    for (let step = 0; step < NAME_SPACE; step++) {
      const c = candidate((start + step) % NAME_SPACE)
      if (this.allowed(c)) {
        this.given.set(key, c)
        this.taken.add(normal(c))
        return c
      }
    }
    throw new Error(`the name space (${NAME_SPACE}) is exhausted`)
  }

  /** Every real name given a fictional one so far. */
  get size(): number {
    return this.given.size
  }
}

/** Street types and directions: ordinary words the fictional street keeps, title-cased. */
const title = (s: string): string => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())

/**
 * The fictional name of a street from its parts (the sources' body, type and direction). Every body is renamed,
 * numbered ones too ("1st Avenue" is as real a street as any); an empty body gives ''.
 */
export function streetName(book: NameBook, body: string | null | undefined, type?: string | null, direction?: string | null): string {
  const b = (body ?? '').trim()
  if (!b) return ''
  return [book.name(b), type ? title(type) : '', direction ? title(direction) : ''].filter(Boolean).join(' ')
}
