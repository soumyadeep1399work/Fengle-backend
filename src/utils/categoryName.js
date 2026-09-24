// Duplicate prevention for kitchen-created categories. Kitchens can add
// categories with no admin approval (product decision 2026-09-21), so the
// safeguard is that the customer never sees both "Momo" and "Momos".
//
// normalizeCategoryName() reduces a name to a canonical key: two names that a
// person would call "the same category" produce the same key. It is the only
// definition of "the same" — the API never compares raw names.

// Words that add no meaning to a category name ("Bengali Food" == "Bengali").
const FILLER = new Set([
  "food", "foods", "item", "items", "special", "specials",
  "cuisine", "dish", "dishes", "style", "corner", "house",
  "and", // "Chaat & Snacks" == "Chaat Snacks" (& is turned into "and" first)
]);

// Irregular Indian-spelling variants that the generic folds below can't catch.
// (paneer/panir, ee/i, oo/u, ph/f, ss/s and word-initial w/v are handled by fold().)
const WORD_CANON = {
  biriyani: "biryani", briyani: "biryani", biriani: "biryani", biryani: "biryani",
  chowmein: "chowmein", chaumin: "chowmein", chowmin: "chowmein", chaumein: "chowmein",
  tandoori: "tandori",
};

/** momos -> momo, sweets -> sweet, sandwiches -> sandwich, candies -> candy, biryanis -> biryani. */
function singularize(word) {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (/(ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("ss") || word.endsWith("us")) return word;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function fold(word) {
  return word
    .replace(/ph/g, "f")
    .replace(/ee/g, "i")
    .replace(/oo/g, "u")
    .replace(/ss/g, "s")
    .replace(/^w/, "v");
}

/** Canonical comparison key; "" if the name is nothing but filler words. */
function normalizeCategoryName(name) {
  let s = String(name).toLowerCase().normalize("NFKD");
  // Strip accents (Café -> cafe) only for Latin-script names. In Bengali/Hindi
  // the combining marks are vowel signs — removing them would collapse
  // different words into one key and wrongly block a genuinely new category.
  if (!/[\p{L}--[\p{Script=Latin}]]/v.test(s)) s = s.replace(/\p{M}+/gu, "");
  s = s
    .replace(/&/g, " and ")
    .replace(/\bchow\s+mein\b/g, "chowmein")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ") // marks stay: they're part of Indic words
    .trim();

  const words = s.split(/\s+/).filter((w) => w && !FILLER.has(w));
  return words
    .map((w) => {
      const singular = singularize(w);
      return fold(WORD_CANON[singular] || singular);
    })
    .join("");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Close-but-not-identical existing categories, best first, at most `limit`.
 * "Close" = edit distance <= 1 when the shorter key is under 8 chars (<= 2
 * otherwise), OR one key contains the other ("northindian" vs "indian").
 * Edit-distance matches rank ahead of contains-only matches. Never returns the
 * exact match (same key) — callers handle that separately.
 * @param {string} key normalized name being checked
 * @param {Array<{id:number,name:string,norm:string}>} categories
 */
function findSimilar(key, categories, limit = 5) {
  if (!key) return [];
  const scored = [];
  for (const c of categories) {
    if (!c.norm || c.norm === key) continue;
    const shorter = Math.min(key.length, c.norm.length);
    const distance = levenshtein(key, c.norm);
    const withinDistance = distance <= (shorter < 8 ? 1 : 2);
    const contains = shorter >= 3 && (key.includes(c.norm) || c.norm.includes(key));
    if (!withinDistance && !contains) continue;
    scored.push({ c, score: withinDistance ? distance : 3, lengthGap: Math.abs(key.length - c.norm.length) });
  }
  scored.sort((x, y) => x.score - y.score || x.lengthGap - y.lengthGap || x.c.name.localeCompare(y.c.name));
  return scored.slice(0, limit).map((x) => x.c);
}

/**
 * Validates and cleans a category name typed by a kitchen. Returns
 * { error } or { name, normalized }. All-lowercase input is title-cased
 * ("hakka noodles" -> "Hakka Noodles") because it is shown to customers as-is.
 */
function validateCategoryName(raw) {
  if (typeof raw !== "string") return { error: "name must be a string" };
  const name = raw.trim().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 40) return { error: "name must be 2 to 40 characters" };
  if (!/^[\p{L}\p{M}\p{N} &()\-']+$/u.test(name)) {
    return { error: "name may only contain letters, numbers, spaces and & ( ) - '" };
  }
  if (!/\p{L}/u.test(name)) return { error: "name must contain at least one letter" };

  const normalized = normalizeCategoryName(name);
  if (!normalized) return { error: "name is too generic — say which cuisine or kind of dish it is" };

  const display = /\p{Lu}/u.test(name)
    ? name
    : name.replace(/(^|[\s(\-&])(\p{L})/gu, (_, boundary, letter) => boundary + letter.toUpperCase());
  return { name: display, normalized };
}

module.exports = { normalizeCategoryName, findSimilar, validateCategoryName, levenshtein };
