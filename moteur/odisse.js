// odisse.js
// Fetch des données arboviroses (dengue / chikungunya / Zika) de la
// déclaration obligatoire, via l'API OpenDataSoft de Santé publique France (Odissé).
//
// Plateforme : https://odisse.santepubliquefrance.fr
// Dataset    : arboviroses-donnees-declaration-obligatoire
// API        : OpenDataSoft Explore v2.1 (REST/JSON, sans authentification)
//
// ⚠️ Les NOMS EXACTS des champs du dataset n'ont pas pu être testés en live.
// Le module découvre donc le schéma au runtime (fetchSchema) et détecte
// automatiquement les colonnes "date", "pathologie", "statut" et "nombre de cas"
// par mots-clés. Si la détection échoue, les logs listent les champs réels
// pour que vous fixiez les noms en dur.

const ODISSE_BASE =
  "https://odisse.santepubliquefrance.fr/api/explore/v2.1/catalog/datasets";
const DATASET = "arboviroses-donnees-declaration-obligatoire";

/** Récupère la liste des champs du dataset : [{ name, label, type }]. */
export async function fetchSchema() {
  const res = await fetch(`${ODISSE_BASE}/${DATASET}`);
  if (!res.ok) throw new Error(`Odissé schema ${res.status}`);
  const json = await res.json();
  // OpenDataSoft v2.1 expose les champs sous json.dataset.fields (ou json.fields).
  const fields = json?.dataset?.fields || json?.fields || [];
  return fields.map((f) => ({
    name: f.name,
    label: f.label || f.name,
    type: f.type,
  }));
}

// Détecte un champ par mots-clés dans son nom/libellé.
function pickField(fields, keywords) {
  const norm = (s) => (s || "").toLowerCase();
  return (
    fields.find((f) =>
      keywords.some((k) => norm(f.name).includes(k) || norm(f.label).includes(k))
    )?.name || null
  );
}

/**
 * Récupère les enregistrements arboviroses, filtrables par pathologie / région / année.
 * Auto-mappe les colonnes ; retourne { rows, mapping } — rows normalisées + le mapping détecté.
 *
 * @param {string[]} pathologies  ex: ["dengue","chikungunya"] (filtre côté client, tolérant)
 * @param {string}   region       ex: "La Réunion" (si le dataset a une colonne région)
 * @param {number}   yearFrom     ex: 2022
 */
export async function fetchArboviroses({
  pathologies = null,
  region = null,
  yearFrom = null,
  limit = 100,
} = {}) {
  const fields = await fetchSchema();

  const mapping = {
    date: pickField(fields, ["date", "mois", "periode", "annee", "année"]),
    pathologie: pickField(fields, ["patho", "maladie", "arbovirose", "virus"]),
    statut: pickField(fields, ["statut", "importe", "importé", "autochtone", "type_cas"]),
    region: pickField(fields, ["region", "région", "territoire", "departement", "département"]),
    cas: pickField(fields, ["nombre", "cas", "effectif", "count", "valeur"]),
  };

  // Construit un ODSQL "where" côté serveur quand c'est possible.
  const where = [];
  if (region && mapping.region) where.push(`${mapping.region} like "${region}"`);
  if (yearFrom && mapping.date) where.push(`${mapping.date} >= "${yearFrom}-01-01"`);

  const params = new URLSearchParams({
    limit: String(Math.min(limit, 100)),
    order_by: mapping.date ? `${mapping.date} desc` : "",
  });
  if (where.length) params.set("where", where.join(" and "));

  const res = await fetch(`${ODISSE_BASE}/${DATASET}/records?${params}`);
  if (!res.ok) throw new Error(`Odissé records ${res.status}`);
  const json = await res.json();

  let rows = (json.results || []).map((r) => ({
    date: mapping.date ? r[mapping.date] : null,
    pathologie: mapping.pathologie ? r[mapping.pathologie] : null,
    statut: mapping.statut ? r[mapping.statut] : null,
    region: mapping.region ? r[mapping.region] : null,
    cas: mapping.cas ? Number(r[mapping.cas]) || 0 : null,
    _raw: r, // conservé pour debug si l'auto-mapping loupe une colonne
  }));

  // Filtre pathologie côté client (tolérant à la casse/accents).
  if (pathologies?.length && mapping.pathologie) {
    const wanted = pathologies.map((p) => p.toLowerCase());
    rows = rows.filter((r) =>
      wanted.some((w) => (r.pathologie || "").toLowerCase().includes(w))
    );
  }

  if (!mapping.date || !mapping.cas) {
    console.warn(
      "[odisse] Auto-mapping incomplet. Champs réels du dataset :",
      fields.map((f) => `${f.name} (${f.label})`)
    );
  }

  return { rows, mapping };
}
