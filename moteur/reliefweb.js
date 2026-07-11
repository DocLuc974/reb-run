// reliefweb.js
// Fetch des alertes épidémiques (ReliefWeb API v2) pour l'océan Indien / Afrique de l'Est.
// Doc: https://apidoc.reliefweb.int/
//
// ⚠️ Depuis le 1er novembre 2025, l'appname doit être PRÉ-APPROUVÉ par ReliefWeb.
// Demande d'approbation : voir https://reliefweb.int/help/api (contact form).
// Tant que l'appname n'est pas approuvé, l'API peut refuser les requêtes.

const RELIEFWEB_BASE = "https://api.reliefweb.int/v2";

// Appname soumis au formulaire ReliefWeb (en attente d'approbation).
// Dès réception de l'e-mail de validation, garder ce nom s'il est approuvé tel quel.
export const APPNAME = "chu-reunion-veille-reb-x7q2";

// Pays de la zone de veille. Noms tels que ReliefWeb les taggue.
export const OCEAN_INDIEN_AFRIQUE_EST = [
  "Madagascar", "Comoros", "Mayotte (France)", "Mauritius", "Seychelles",
  "Democratic Republic of the Congo", "Tanzania, United Republic of",
  "Kenya", "Mozambique", "Uganda", "Ethiopia", "Malawi", "Zambia",
];

/**
 * Récupère les épidémies (endpoint /disasters, type "Epidemic") pour une liste de pays.
 * Retourne un tableau normalisé { id, name, country, type, status, date, url }.
 */
export async function fetchEpidemics({
  countries = OCEAN_INDIEN_AFRIQUE_EST,
  appname = APPNAME,
  limit = 100,
  includeArchived = false, // true => inclut les épidémies passées (analyse de tendance)
} = {}) {
  const payload = {
    appname,
    limit,
    preset: includeArchived ? "analysis" : "latest",
    profile: "list",
    filter: {
      operator: "AND",
      conditions: [
        { field: "type.name", value: "Epidemic" },
        { field: "primary_country.name", value: countries, operator: "OR" },
      ],
    },
    fields: {
      include: [
        "name", "type.name", "status", "date.created",
        "primary_country.name", "primary_country.iso3", "url",
      ],
    },
    sort: ["date.created:desc"],
  };

  const res = await fetch(`${RELIEFWEB_BASE}/disasters?appname=${encodeURIComponent(appname)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`ReliefWeb ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const json = await res.json();
  return (json.data || []).map((d) => {
    const f = d.fields || {};
    return {
      id: d.id,
      name: f.name || "",
      country: f.primary_country?.name || "",
      iso3: f.primary_country?.iso3 || "",
      type: (f.type || []).map((t) => t.name).join(", "),
      status: f.status || "",
      date: f.date?.created || null,
      url: f.url || `https://reliefweb.int/node/${d.id}`,
    };
  });
}

/**
 * Récupère les derniers rapports (endpoint /reports) mentionnant une maladie
 * dans la zone — utile comme couche "signal précoce" plus fine que /disasters.
 * @param {string} disease  ex: "cholera", "mpox", "Ebola", "chikungunya"
 */
export async function fetchDiseaseReports({
  disease,
  countries = OCEAN_INDIEN_AFRIQUE_EST,
  appname = APPNAME,
  limit = 50,
} = {}) {
  const payload = {
    appname,
    limit,
    preset: "latest",
    profile: "list",
    query: { value: disease, fields: ["title", "body"], operator: "AND" },
    filter: {
      field: "primary_country.name",
      value: countries,
      operator: "OR",
    },
    fields: {
      include: [
        "title", "date.created", "primary_country.name",
        "source.shortname", "url",
      ],
    },
    sort: ["date.created:desc"],
  };

  const res = await fetch(`${RELIEFWEB_BASE}/reports?appname=${encodeURIComponent(appname)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`ReliefWeb ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const json = await res.json();
  return (json.data || []).map((d) => {
    const f = d.fields || {};
    return {
      id: d.id,
      title: f.title || "",
      country: f.primary_country?.name || "",
      source: (f.source || []).map((s) => s.shortname).filter(Boolean).join(", "),
      date: f.date?.created || null,
      url: f.url || `https://reliefweb.int/node/${d.id}`,
    };
  });
}
