/**
 * Semantic-search regression eval (graduated from the P0 spike — see
 * `scratchpad/p0-eval/RESULTS.md` for the original standalone-harness
 * measurement this replaces: GRAY verdict, best model 64.3% hit@10 on
 * classes 1+2, dominant miss = whole-note dilution on long notes, which
 * per-section chunking targets directly).
 *
 * P0 embedded the corpus and ranked it itself, entirely outside the
 * product, because the product didn't have semantic search yet. Now it
 * does — this script is a THIN REST client against a LIVE vault's real
 * `GET /notes?semantic=true&near_text=...` endpoint (the exact call
 * Adam's Claude — or any MCP client calling `query-notes { near_text,
 * semantic }` — makes), scored against the same fixed query set. It's
 * the permanent way to re-measure retrieval quality whenever the
 * chunker, provider, or model changes.
 *
 * Usage:
 *   VAULT_URL=http://localhost:1940 VAULT_TOKEN=<read-scoped token> \
 *     bun scripts/eval-semantic.ts [path/to/queries.json]
 *
 * Defaults: VAULT_URL=http://localhost:1940, VAULT_NAME=default, no auth
 * header when VAULT_TOKEN is unset (fine for a loopback dev server with
 * no api_keys configured). Queries default to
 * `scripts/fixtures/eval-semantic-queries.json` — Aaron's fixed set
 * (memory-recall / paraphrase / lexical-control), kept intact from P0.
 *
 * NOTE: the shipped query fixture's `target_ids` are real note IDs from
 * Aaron's personal vault — running this against a DIFFERENT vault will
 * correctly report near-zero hits (the notes don't exist there). Bring
 * your own `queries.json` (same shape) to eval a different corpus.
 *
 * Requires `GET /api/vault` to report `embeddings.enabled: true` — the
 * script fails loudly (not a silent zero-score run) if semantic search
 * isn't actually configured on the target vault. A vault mid-backfill
 * (embeddings_pending > 0) under-reports quality, never over-reports it.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface EvalQuery {
  id: string;
  class: "memory-recall" | "paraphrase" | "lexical-control";
  query: string;
  target_ids: string[];
  note?: string;
}

interface NoteRef {
  id: string;
  path: string | null;
}

const VAULT_URL = (process.env.VAULT_URL ?? "http://localhost:1940").replace(/\/$/, "");
const VAULT_NAME = process.env.VAULT_NAME ?? "default";
const VAULT_TOKEN = process.env.VAULT_TOKEN;
const QUERIES_PATH = process.argv[2] ?? join(__dirname, "fixtures", "eval-semantic-queries.json");
const TOP_K = 20; // wide enough to compute hit@10 + a generous MRR tail

function authHeaders(): Record<string, string> {
  return VAULT_TOKEN ? { Authorization: `Bearer ${VAULT_TOKEN}` } : {};
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${VAULT_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** Run one query against `/notes`, returning the ranked note ids/paths (up to TOP_K). */
async function runQuery(params: Record<string, string>): Promise<NoteRef[]> {
  const url = new URL(`${VAULT_URL}/vault/${VAULT_NAME}/api/notes`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("limit", String(TOP_K));
  url.searchParams.set("include_content", "false");
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    // A lexical-control query with no keyword overlap can 200 with [] —
    // only a genuine error (malformed request, auth) should throw.
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url.pathname}${url.search} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const body = (await res.json()) as any;
  const notes = Array.isArray(body) ? body : body.notes;
  return (notes ?? []).map((n: any) => ({ id: n.id, path: n.path ?? null }));
}

/** 1-based rank of the first target id in `ranked`, or null if absent. Mirrors P0's score.mjs. */
function bestRank(ranked: NoteRef[], targetIds: string[]): number | null {
  const idx = ranked.findIndex((r) => targetIds.includes(r.id));
  return idx === -1 ? null : idx + 1;
}

function mrrOf(rank: number | null): number {
  return rank === null ? 0 : 1 / rank;
}

interface ClassRollup {
  n: number;
  hit5_rate: number;
  hit10_rate: number;
  mrr_mean: number;
}

function rollupClass(queries: EvalQuery[], ranks: Map<string, number | null>, cls: string): ClassRollup | null {
  const inClass = queries.filter((q) => q.class === cls);
  if (inClass.length === 0) return null;
  let hit5 = 0;
  let hit10 = 0;
  let mrrSum = 0;
  for (const q of inClass) {
    const r = ranks.get(q.id) ?? null;
    if (r !== null && r <= 5) hit5++;
    if (r !== null && r <= 10) hit10++;
    mrrSum += mrrOf(r);
  }
  return {
    n: inClass.length,
    hit5_rate: hit5 / inClass.length,
    hit10_rate: hit10 / inClass.length,
    mrr_mean: mrrSum / inClass.length,
  };
}

async function main(): Promise<void> {
  const vaultInfo = await getJson(`/vault/${VAULT_NAME}/api/vault`);
  const embeddings = vaultInfo.embeddings;
  console.log(`vault "${VAULT_NAME}" embeddings capability: ${JSON.stringify(embeddings)}`);
  if (!embeddings?.enabled) {
    console.error(
      `embeddings.enabled=false on vault "${VAULT_NAME}" — nothing to measure. Configure a provider ` +
        `(zero-config already gives the bundled floor; see EMBEDDING_API_URL for the config upgrade tier) and retry.`,
    );
    process.exit(1);
  }

  const queries: EvalQuery[] = JSON.parse(readFileSync(QUERIES_PATH, "utf8"));
  console.log(`loaded ${queries.length} queries from ${QUERIES_PATH}`);

  const semanticRanks = new Map<string, number | null>();
  const lexicalRanks = new Map<string, number | null>();

  for (const q of queries) {
    const [semanticResults, lexicalResults] = await Promise.all([
      runQuery({ semantic: "true", near_text: q.query }),
      runQuery({ search: q.query }),
    ]);
    const sRank = bestRank(semanticResults, q.target_ids);
    const lRank = bestRank(lexicalResults, q.target_ids);
    semanticRanks.set(q.id, sRank);
    lexicalRanks.set(q.id, lRank);
    console.log(
      `${q.id} [${q.class}] semantic_rank=${sRank ?? `not in top ${TOP_K}`} lexical_rank=${lRank ?? `not in top ${TOP_K}`}`,
    );
  }

  const classes = ["memory-recall", "paraphrase", "lexical-control"] as const;
  console.log("\n=== semantic (near_text + semantic:true) ===");
  for (const cls of classes) {
    console.log(cls, JSON.stringify(rollupClass(queries, semanticRanks, cls)));
  }
  console.log("\n=== lexical (search=) ===");
  for (const cls of classes) {
    console.log(cls, JSON.stringify(rollupClass(queries, lexicalRanks, cls)));
  }

  // The plan's "verdict number": hit@10 on classes 1+2 (memory-recall +
  // paraphrase) combined — see SEMANTIC-MVP-PLAN.md §5.
  const combined = queries.filter((q) => q.class !== "lexical-control");
  const combinedHits = combined.filter((q) => {
    const r = semanticRanks.get(q.id);
    return r !== null && r !== undefined && r <= 10;
  }).length;
  const combinedHit10 = combined.length > 0 ? combinedHits / combined.length : 0;
  console.log(
    `\nclasses 1+2 combined hit@10 (the plan's verdict number): ${(combinedHit10 * 100).toFixed(1)}% (n=${combined.length})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
