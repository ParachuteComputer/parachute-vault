import { SEARCH_MODES } from "./search-query.js";
import { MIN_CONTENT_LENGTH } from "./content-range-constants.js";
import { MAX_TICKET_UPLOAD_BYTES } from "./attachment/tickets.js";

/**
 * Pure-data MCP tool manifest — the single source of truth for every core MCP
 * tool's `name`, `description`, `inputSchema`, the minimum scope verb it
 * requires (`requiredVerb`), and the `condition` under which it's exposed.
 * NO store, NO closures, NO execution — data only.
 *
 * `generateMcpTools(store)` (core/src/mcp.ts) builds the live, store-bound
 * tool set BY ITERATING this manifest and attaching an `execute` closure per
 * entry; the metadata here is emitted verbatim. An account-level front-of-house
 * layer (cloud's identity worker, the hub) can import this same manifest to
 * enumerate/verb-filter the tool set without ever touching the store code.
 *
 * IMPORT-GRAPH INVARIANT (front-of-house Wave 0): this module's transitive
 * imports MUST stay free of `bun:sqlite` (and any bun-only / node-only runtime
 * import) so it loads cleanly under Cloudflare workerd. The three imported
 * constants above each come from a driver-free module (`search-query.ts` and
 * `attachment/tickets.ts` import nothing; `content-range-constants.ts` holds
 * only the extracted `MIN_CONTENT_LENGTH` literal) — keep it that way. See
 * `mcp-manifest.test.ts`, which asserts the closure is sqlite-free.
 */

/** Minimum scope verb a caller must hold for a vault to see + invoke a tool. */
export type McpToolVerb = "read" | "write" | "admin";

/**
 * Inclusion gate for a tool. `core` tools are always present;
 * `attachment-tickets` requires the caller wire an `attachmentTickets` seam;
 * `attachment-bytes` requires an `attachmentBytes` seam (see
 * `GenerateMcpToolsOpts`). A front-of-house layer reads this to know which
 * tools a given runtime can actually back.
 */
export type McpToolCondition = "core" | "attachment-tickets" | "attachment-bytes";

/** One pure-data tool entry. Mirrors the metadata half of `McpToolDef` (no `execute`/`resultContent`). */
export interface McpToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredVerb: McpToolVerb;
  condition: McpToolCondition;
}

export const MCP_TOOL_MANIFEST: readonly McpToolManifestEntry[] = [
    {
      name: "query-notes",
      requiredVerb: "read",
      description: `Query notes. Returns notes matching the given filters.

- **Single note**: pass \`id\` (accepts note ID, path, e.g., "Projects/README", or — as a last-resort fallback when id/path both miss cleanly and exactly one note matches — its H1 title, e.g. "Weekly Review")
- **Filter**: pass \`tag\`, \`path\`, \`path_prefix\`, \`exclude_path_prefix\`, \`search\`, \`metadata\`, date range
- **Graph neighborhood**: pass \`near\` to scope results to notes within N hops of an anchor note
- **No filters**: returns all notes (paginated)

Defaults: include_content=true for single note, false for lists. include_links=false. tag_match="any".

Each result carries \`validation_status\` when any tag it carries declares \`fields\` (vault#555) — same advisory-warnings shape create-note/update-note attach, now also on reads (an out-of-enum value on a non-strict field is stored and findable, but still surfaces its \`enum_mismatch\` warning here, not just on the write that introduced it). Absent entirely when no tag on the note declares a schema.

Large notes: pass \`content_offset\` / \`content_length\` (UTF-8 bytes) for a bounded read of note content — the response carries the slice plus \`content_total_length\` and \`content_next_offset\` (null when complete). Loop, feeding \`content_next_offset\` back as \`content_offset\`, to read a note too large for one response.

Link expansion: pass \`expand_links: true\` to inline [[wikilinks]] from returned content. Tune with \`expand_depth\` (1–3, default 1) and \`expand_mode\` ("full" inlines full content, "summary" inlines only metadata.summary). Expansions are deduplicated across the query and cycle-guarded.

Broken links (vault#555): a \`[[wikilink]]\` or structured \`links\` target that never resolved to a note used to be invisible — silently dropped from the response with no signal it existed. Pass \`has_broken_links: true\`/\`false\` to filter notes by whether they have any dangling outbound link, and/or \`include_broken_links: true\` to attach each note's pending targets as \`broken_links: [{target, relationship}]\` (empty array when none). Both read the vault's pending-resolution table — the same source \`create-note\`/\`update-note\`'s \`unresolved_link\` warning draws from; a target created later (this session or any future one) backfills the edge automatically and the note drops out of \`has_broken_links: true\`.

Ambiguous links (vault#581): the twin of the above, for a target that matched TOO MANY notes rather than none — \`[[Dup]]\` when two notes share that basename or H1 title. No link is created and none is guessed at; before #581 that was visible only in the write-time \`ambiguous_link\` warning, so a later audit couldn't find it. Pass \`has_ambiguous_links: true\`/\`false\` to filter, and/or \`include_ambiguous_links: true\` to attach \`ambiguous_links: [{target, relationship, candidate_count}]\` (empty array when none). Disjoint from \`has_broken_links\`: dangling = matched nothing, ambiguous = matched several. The record is persisted, so it survives restarts — and it self-heals: delete or rename one of the colliding notes and the link resolves for real (the note drops out of \`has_ambiguous_links: true\`); delete them ALL and it demotes to an ordinary broken link. (For a tag-scoped session that demotion has already happened at read time — see \`has_broken_links\`.)

Response shape (vault#550 — three variants, pick by what you passed):
- Default (no \`cursor\`, no warnings): a bare array of notes.
- Cursor mode (\`cursor\` param present — including \`cursor: ""\` to bootstrap): \`{notes: [...], next_cursor}\`. See \`cursor\` below for the bootstrap flow.
- Warnings present (e.g. an unrecognized \`tag\`) and NOT in cursor mode: \`{notes: [...], warnings: [...]}\`. Cursor mode + warnings compose: \`{notes, next_cursor, warnings}\`. Absent \`warnings\` key means nothing to flag — don't assume its presence either way.
- \`aggregate\` mode: \`[{group, value}]\` — a rollup row per group, NOT notes. See \`aggregate\` below.

\`aggregate\` (count/sum, optional group_by): pass \`aggregate: {op, group_by?, field?}\` to get counts/sums instead of note rows. \`{op: "count"}\` with no \`group_by\` is the filtered total — one row \`[{group: null, value: N}]\` (vault#626). Grouped examples: "how many notes per status" (\`{group_by: "status", op: "count"}\`) or "total amount per category" (\`{group_by: "category", op: "sum", field: "amount"}\`). Every other filter (\`tag\`, \`metadata\`, date range, ...) narrows the input set FIRST, exactly like a normal query. \`group_by\` is either \"tag\" (group by tag membership) or an indexed metadata field; omit it on \`count\` for the total. \`op: "sum"\` requires both \`group_by\` and \`field\` (indexed NUMERIC). Mutually exclusive with \`search\`/\`near\`/\`cursor\`/\`semantic\`.

\`search\` is literal-by-default (vault#551): your text is escaped and phrase-quoted before it reaches FTS5, so ordinary punctuation ("didn't", "eleven-day", "18.6") is matched as literal content instead of being parsed as query syntax (a bare hyphen used to mean NOT; an apostrophe or decimal point used to break the parse and silently return \`[]\`). Pass \`search_mode: "advanced"\` to opt back into raw FTS5 syntax (AND/OR/NOT, manual phrase quoting, prefix \`*\`) — a malformed advanced query now throws a structured error instead of silently returning \`[]\`. \`sort\` is honored under \`search\` too: omit it for relevance ranking (default), or pass "asc"/"desc" to order by \`created_at\` instead.

\`search\` indexes BOTH a note's title (\`path\`) and its \`content\` (vault#551 WS2C, schema v25) — a title match is weighted far above a passing body mention, so a dedicated note on a topic outranks another note that merely references it. Every result carries a \`score\` field (higher = more relevant; only meaningful as a RELATIVE comparison within one result set). Word matching also stems regular English affixes ("firefighter" matches "firefighters", "microbe" matches "microbes") — irregular plurals with a consonant change ("wolf"/"wolves") aren't covered by stemming. A search that returns ZERO results may carry a \`search_did_you_mean\` warning suggesting the closest indexed term when one looks like a likely typo (only unscoped sessions — tag-scoped tokens never see it, since the suggestion is computed vault-wide).`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Get one note by ID, path, or (fallback, only when id/path both miss and exactly one note matches) its H1 title" },
          tag: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Filter by tag(s)",
          },
          tag_match: { type: "string", enum: ["any", "all"], description: "How to match multiple tags: 'any' (OR, default) or 'all' (AND)" },
          expand: {
            type: "string",
            enum: ["subtypes", "namespace", "both", "exact"],
            description: "How each `tag` expands. 'subtypes' (DEFAULT): the tag plus its declared parent_names descendants — the semantic is-a axis (e.g. tag:entity also matches person/work). 'namespace': the tag plus everything filed under it by NAME (tag:entity also matches entity/archived) — the lexical filing axis. 'both': union of the two. 'exact': only the literal tag, no expansion. Omit for 'subtypes' (current behavior).",
          },
          exclude_tags: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Exclude notes with these tag(s). Accepts a single tag or an array. Aliases `excludeTags` and `exclude_tag` are also accepted. If multiple alias forms are provided, `exclude_tags` takes precedence (then `excludeTags`, then `exclude_tag`).",
          },
          // The runtime alias-fallback chain accepts these too. Declared
          // here so schema-introspecting clients (Claude, MCP clients
          // that surface tool schemas) see them as valid inputs rather
          // than thinking the canonical is the only option.
          excludeTags: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Alias for `exclude_tags` (camelCase). Same shape and semantics — pick whichever is more natural for your client.",
          },
          exclude_tag: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Alias for `exclude_tags` (singular). Same shape and semantics — accepts a single tag or an array.",
          },
          has_tags: { type: "boolean", description: "Presence filter: true = only notes with at least one tag; false = only untagged notes. Ignored when `tag` is set." },
          has_links: { type: "boolean", description: "Presence filter: true = only notes with at least one inbound or outbound link; false = only orphaned notes (no links in either direction)." },
          has_broken_links: { type: "boolean", description: "Presence filter (vault#555): true = only notes with at least one dangling outbound link — a [[wikilink]] or structured `links` target that never resolved to a note; false = only notes with none. Backed by the unresolved_wikilinks table (same data `doctor`/list-unresolved surfaces); safe on a vault where no link has ever gone unresolved (true matches nothing, false is a no-op). For a TAG-SCOPED session both polarities are answered on the notes the session can see (vault#239): a target whose candidates are ALL out of scope matches nothing in that session's sub-vault, so it counts as broken there even though the vault-wide record calls it ambiguous — otherwise the note would only become broken once the last invisible candidate was deleted. Decided after the page is drawn, so a scoped page may come back shorter than `limit` while more results remain." },
          has_ambiguous_links: { type: "boolean", description: "Presence filter (vault#581): true = only notes with at least one AMBIGUOUS outbound link — a [[wikilink]] or structured `links` target that matched TWO OR MORE notes, so no link was created and none was guessed at; false = only notes with none. Disjoint from `has_broken_links` (dangling = matched nothing; ambiguous = matched too much). Backed by the ambiguous_wikilinks table — the same source `create-note`/`update-note`'s `ambiguous_link` warning draws from; safe on a vault where no link has ever been ambiguous (true matches nothing, false is a no-op). For a TAG-SCOPED session both polarities are answered on the notes the session can see — a collision between a visible and an invisible note is neither reported by `true` nor excluded by `false` — so a scoped page may come back shorter than `limit` while more results remain." },
          path: { type: "string", description: "Exact path match (case-insensitive)" },
          path_prefix: { type: "string", description: "Path prefix match (e.g., 'Projects/')" },
          exclude_path_prefix: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Exclude notes whose path matches any of these prefixes (vault#628). Same matching as `path_prefix`. Repeatable. A note with no path is not excluded. First client: `.parachute/` system-space. Alias `excludePathPrefix` is also accepted.",
          },
          excludePathPrefix: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Alias for `exclude_path_prefix` (camelCase).",
          },
          extension: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Filter by file extension (vault#328). Pass a single extension (e.g. \"csv\") or an array (e.g. [\"csv\", \"yaml\", \"json\"]). Notes default to \"md\"; case-insensitive match.",
          },
          search: {
            type: "string",
            description:
              'Full-text search query, matched against BOTH a note\'s title (path) and its content — a title match ranks far above a passing body mention. Literal-by-default (vault#551): your text is escaped and phrase-quoted before reaching FTS5, so punctuation ("didn\'t", "eleven-day", "18.6") is matched as literal content rather than parsed as FTS5 query syntax. Pass `search_mode: "advanced"` for raw FTS5 syntax (boolean/phrase/prefix operators). `sort` is honored under search (see below) — default is relevance ranking. Matching stems regular affixes ("firefighter"/"firefighters") but not irregular plurals ("wolf"/"wolves"). Results carry a `score` field (higher = more relevant, relative within this result set only). A zero-result search may carry a `search_did_you_mean` warning (unscoped sessions only).',
          },
          search_mode: {
            type: "string",
            enum: [...SEARCH_MODES],
            description:
              'How `search` text is turned into an FTS5 query (vault#551). "literal" (DEFAULT): escape + phrase-quote the text so punctuation is literal content, not FTS5 syntax — the fix for `search: "didn\'t"` / "eleven-day" / "18.6" silently returning `[]`. "advanced": pass the text through to FTS5 raw, for callers who want boolean (AND/OR/NOT), manual phrase quoting, or prefix (`*`) syntax — a malformed advanced query throws a structured error (`error_type: "invalid_search_syntax"`) instead of silently returning `[]`. Has no effect without `search` (an `ignored_param` warning fires if you pass it without `search`). Omit for the default ("literal").',
          },
          near_text: {
            type: "string",
            description:
              'EXPERIMENTAL (semantic search MVP — may change or be removed while quality is validated). Free text to rank notes by MEANING rather than keyword — "that idea about music remixes as community building" finds the note even if it never uses those exact words. Requires `semantic: true`; mutually exclusive with `search`/`aggregate`/`cursor`. Composes with every other filter (`tag`, `metadata`, date range, ...) exactly like `search` does — those narrow the candidate set FIRST, then ranking runs over just that set. Long notes are chunked internally and ranked by their BEST-matching section, so a match buried in one part of a long note still surfaces the whole note. Results carry a `score` field — cosine similarity in `[-1, 1]` (typically 0.2–0.9), NOT the same scale as `search`\'s bm25 `score`; only meaningful as a relative ranking within one result set.',
          },
          semantic: {
            type: "boolean",
            description:
              'EXPERIMENTAL. Opt into vector ranking via `near_text` (required when true). No embedding provider configured, or the vault hasn\'t finished indexing, is reported HONESTLY — never a silent fallback to keyword search: a provider-less vault throws a structured `semantic_unavailable` error; a mid-backfill vault returns real (possibly partial) results plus an `embeddings_pending` warning naming how many candidate notes aren\'t embedded yet.',
          },
          metadata: {
            type: "object",
            description: "Filter by metadata values. Each value is either a primitive (exact match, scans JSON) or an operator object: `{eq|ne|gt|gte|lt|lte|in|not_in|exists: value}`. Operator objects require the field to be declared `indexed: true` in a tag schema — they route through the backing B-tree index. Multiple operators on one field AND together (e.g. `{gt: 5, lt: 10}`). `in`/`not_in` take arrays; `exists` takes a boolean.",
          },
          created_by: { type: "string", description: "Write-attribution filter (vault#298): only notes whose FIRST write was attributed to this principal (a JWT subject, or an operator/token label). Exact match; indexed. Legacy/unattributed notes (NULL) never match." },
          last_updated_by: { type: "string", description: "Write-attribution filter (vault#298): only notes whose MOST RECENT write was attributed to this principal. Exact match; indexed." },
          created_via: { type: "string", description: "Write-attribution filter (vault#298): only notes FIRST written through this interface/channel — e.g. `mcp`, `surface:<name>`, `agent:<id>`, `nostr:<64-hex-pubkey>`, `operator`, `api`. `nostr:<pubkey>` (vault#698) is the Nostr key that SIGNED the request, and is the axis that tells two agents apart when they share one hub user (`created_by`). Emitted by BOTH doors — self-hosted hub (parachute-hub#937) and cloud (parachute-cloud#277). Exact match; indexed." },
          last_updated_via: { type: "string", description: "Write-attribution filter (vault#298): only notes whose MOST RECENT write came through this interface/channel — same vocabulary as `created_via`, including `nostr:<64-hex-pubkey>` for the signing key. Exact match; indexed." },
          order_by: { type: "string", description: "Sort by an indexed metadata field instead of `created_at`. Field must be declared `indexed: true`; errors otherwise. Two special values need no declaration: `link_count` sorts by link DEGREE (both-directions raw row count), matching the `include_link_count` field for every note; `updated_at` (vault#585) sorts on the integer `updated_at_ms` mirror column — correct on non-canonical/imported timestamps — with `id` as the tiebreaker. Direction is taken from `sort` (default 'asc'); for other fields `created_at` is appended as a stable tiebreaker." },
          date_from: { type: "string", description: "Start date (ISO, inclusive). Filters on `created_at` (vault ingestion time). Shorthand for `date_filter: { field: 'created_at', from }`." },
          date_to: { type: "string", description: "End date (ISO, exclusive). Filters on `created_at` (vault ingestion time). Shorthand for `date_filter: { field: 'created_at', to }`." },
          date_filter: {
            type: "object",
            properties: {
              field: { type: "string", description: "Field to filter on. Defaults to `created_at` (vault ingestion time). `updated_at` is also recognized as a real column — use it for incremental rebuilds (\"what changed since X\"). Any other field must be declared `indexed: true` in a tag schema — same contract as metadata operator queries and `order_by`." },
              from: { type: "string", description: "Inclusive lower bound (ISO date)." },
              to: { type: "string", description: "Exclusive upper bound (ISO date)." },
            },
            description: "Generalized date-range filter. Use this when the date that matters is the *content* date (e.g. an email's received date, a meeting's scheduled date) rather than the vault ingestion time, or when paging by `updated_at` for incremental rebuilds. Mutually exclusive with the top-level `date_from` / `date_to` shorthand.",
          },
          aggregate: {
            type: "object",
            properties: {
              group_by: { type: "string", description: "What to group by: an indexed metadata field name (declared `indexed: true` in a tag schema — same FIELD_NOT_INDEXED contract as `metadata` operator queries / `order_by`), or the special value \"tag\" to group by tag membership. Under \"tag\", a note carrying N of the tags present in the filtered result set contributes to N separate groups (a membership rollup, not a partition). Optional when op is \"count\" — omit it for a single filtered-total row `{group: null, value: N}` (vault#626). Required for \"sum\"." },
              op: { type: "string", enum: ["count", "sum"], description: "\"count\": number of matching notes per group, or the filtered total when group_by is omitted. \"sum\": sum of `field` per group." },
              field: { type: "string", description: "Required when `op` is \"sum\"; ignored for \"count\". Must be an indexed metadata field with a numeric storage type (declared `type: \"integer\"` or `type: \"boolean\"` — the only indexable numeric shapes; a bare `type: \"number\"` field is never indexed and a TEXT-backed field can't be summed)." },
            },
            required: ["op"],
            description: "Aggregation / rollup mode. Every OTHER filter above (tag, metadata, date range, write-attribution, ...) is applied FIRST, exactly as a normal query would; the matching notes are then grouped and the response becomes `[{group, value}]` instead of note rows — one row per group, `value` is the count/sum. Omit `group_by` with `op: \"count\"` for a filtered total (`[{group: null, value: N}]`, including `value: 0` on an empty match). A note whose group_by value is absent collects into one `{group: null, value: ...}` row rather than being dropped. Mutually exclusive with `search`, `near`, `cursor`, and `semantic` (a rollup has no pagination/ranking/graph-neighborhood shape). Tag-scoped sessions see the SAME visibility enforcement as every other read — the rollup is computed only over notes the token can see.",
          },
          near: {
            type: "object",
            properties: {
              note_id: { type: "string", description: "Anchor note ID, path, or (fallback) H1 title" },
              depth: { type: "number", description: "Max hops from anchor (default 2, max 5)" },
              relationship: { type: "string", description: "Only follow links with this relationship" },
            },
            required: ["note_id"],
            description: "Scope results to notes within N hops of an anchor note",
          },
          sort: {
            type: "string",
            enum: ["asc", "desc"],
            description:
              'Sort by created_at. Under a structured query this is the only ordering (default "asc"). Under `search` (vault#551): omit for FTS5 relevance ranking (default, unchanged) — pass "asc"/"desc" to EXPLICITLY switch to created_at ordering instead of relevance.',
          },
          limit: { type: "number", description: "Max results (default 50)" },
          offset: { type: "number", description: "Pagination offset (default 0)" },
          cursor: {
            type: "string",
            description:
              "Opaque cursor for 'since last checked' agent loops (vault#313). Bootstrap flow (vault#550): FIRST call passes `cursor: \"\"` (empty string) — this opts into cursor mode with no watermark yet and the response comes back as `{notes, next_cursor}`. Persist `next_cursor` and pass it back verbatim as `cursor` on every SUBSEQUENT call to receive only notes created or updated since the prior page. Omitting `cursor` entirely (not passing the key at all) is a DIFFERENT thing — a plain one-shot list with no cursor envelope and no way to resume; use that when you don't want pagination at all. The cursor binds to the query's filters (tag, path, metadata, etc.); changing them between calls returns a structured `cursor_query_mismatch` error, and a malformed/expired cursor returns `cursor_invalid` naming the bootstrap flow again. Pagination via cursor orders results by `updated_at ASC` and is mutually exclusive with `order_by` and `sort: \"desc\"`.",
          },
          include_content: { type: "boolean", description: "Include note content (default: true for single, false for list)" },
          content_offset: {
            type: "number",
            description:
              "Byte offset (UTF-8) into note content to start reading from (default 0). For reading a note too large for one response: pass the previous response's `content_next_offset` here to continue. An offset landing mid-codepoint is aligned DOWN to the codepoint's leading byte (chained `content_next_offset` values are always aligned); the effective start is echoed back as `content_offset` on the response. Requires content in the response — errors when combined with include_content=false (or a list query without include_content=true).",
          },
          content_length: {
            type: "number",
            description:
              `Maximum bytes (UTF-8) of note content to return (minimum ${MIN_CONTENT_LENGTH}). When this or content_offset is set, the returned \`content\` is the byte slice and the response gains \`content_offset\` (effective start), \`content_total_length\` (full content size in bytes), and \`content_next_offset\` (pass back as content_offset to continue; null when the slice reaches the end). Slices end on a UTF-8 codepoint boundary, so a slice may be up to 3 bytes under the budget — never over. Concatenating the slices from offset 0 through content_next_offset=null reconstructs the content byte-for-byte. On list queries the same window applies to each note's content independently. When expand_links=true the range applies to the returned (expanded) content.`,
          },
          include_metadata: {
            oneOf: [
              { type: "boolean" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Control metadata in response: true (all, default), false (none), or array of field names to include",
          },
          include_links: { type: "boolean", description: "Include inbound + outbound links per note (default: false)" },
          include_broken_links: { type: "boolean", description: "Include each note's dangling outbound links as `broken_links: [{target, relationship}]` (default: false; vault#555). `target` is the unresolved path/title the [[wikilink]] or structured `links` entry named; `relationship` is \"wikilink\" for content-parsed links or the caller's own relationship string for a structured link. Empty array when the note has none. One batched query per request regardless of page size — mirrors `has_broken_links` (same backing table) and `include_links`. For a TAG-SCOPED session this also lists a target whose candidates are all out of scope, which is broken in that session's sub-vault (vault#239)." },
          include_ambiguous_links: { type: "boolean", description: "Include each note's ambiguous outbound links as `ambiguous_links: [{target, relationship, candidate_count}]` (default: false; vault#581). `target` is the path/title the [[wikilink]] or structured `links` entry named; `relationship` is \"wikilink\" for content-parsed links or the caller's own relationship string; `candidate_count` is how many notes it matched. For a TAG-SCOPED session the candidates are re-counted within the session's scope, and a target with fewer than two visible candidates is omitted — a scoped reader gets exactly what an unscoped one would get on a vault holding only the notes it can see. Empty array when the note has none. One batched query per request regardless of page size — mirrors `has_ambiguous_links` (same backing table) and `include_broken_links`." },
          include_link_count: {
            type: "boolean",
            description:
              "Include the note's link DEGREE as a `linkCount` field, without hauling the link objects (default: false). Degree is a raw row count: outbound (source) + inbound (target). A self-loop counts as 2. Cheap COUNT over indexes; batched once per request. For a tag-scoped token, `linkCount` is the raw degree and MAY include edges to notes the token can't see — only the number leaks, not the neighbor.",
          },
          link_count_direction: {
            type: "string",
            enum: ["both", "outbound", "inbound"],
            description:
              "Which edges `include_link_count` counts: both (default), outbound only (source_id), or inbound only (target_id). order_by=link_count always uses the both-directions degree.",
          },
          include_attachments: { type: "boolean", description: "Include attachment records (default: false)" },
          expand_links: { type: "boolean", description: "Inline [[wikilinks]] in returned content (default: false). Has no effect if content is not included (e.g., default list mode with include_content=false); wikilinks inside fenced or inline code are not expanded." },
          expand_depth: { type: "number", description: "Recursion depth for link expansion (default 1, max 3). Only meaningful in 'full' mode — 'summary' mode does not recurse." },
          expand_mode: { type: "string", enum: ["full", "summary"], description: "Expansion rendering: 'full' inlines the linked note's content, 'summary' inlines metadata.summary — falling back to the note's opening paragraph when no metadata.summary exists. Default: 'full'." },
        },
      },
      condition: "core",
    },
    {
      name: "create-note",
      requiredVerb: "write",
      description: `Create one or more notes. Pass a single note's fields directly, or pass a \`notes\` array for batch creation. Each note accepts content, path, metadata, tags, links, and created_at.

**Path-conflict handling** — \`if_exists: "error"|"ignore"|"update"|"replace"\` (vault#555, default \`"error"\`): what to do when the note's \`path\` already names an existing note.
- \`"error"\` (DEFAULT — unchanged behavior): the write is rejected with a \`path_conflict\` error (409); nothing is mutated.
- \`"ignore"\`: return the existing note UNCHANGED — no error and no mutation of any kind (content/metadata/tags/links untouched; no schema-default backfill runs either). Response carries \`existed: true\`. The idempotent-retry primitive: a crash-replay or the losing side of a create-race gets back the same note a first-time caller would have created, safely, any number of times.
- \`"update"\`: merge this payload into the existing note — \`content\` (if provided) fully replaces the existing content, exactly like \`update-note\`'s \`content\` field (omit to leave it untouched); \`metadata\` (if provided) is RFC-7386 merged — existing keys preserved, incoming keys overwrite, an incoming \`null\` value deletes a key — same semantics as \`update-note\`; \`tags\`/\`links\` (if provided) are ADDED to the existing set (union — nothing already there is removed). Response carries \`existed: true\`.
- \`"replace"\`: overwrite \`content\` and \`metadata\` WHOLESALE — \`content\` becomes exactly the incoming value (or \`""\` if omitted) and \`metadata\` becomes exactly the incoming object (or \`{}\` if omitted), NOT merged, so a prior metadata key absent from this payload is dropped. \`tags\`/\`links\` stay additive (same union behavior as \`"update"\`) — a replace targets the free-form fields, not the taxonomy/graph, so it can't silently orphan links or detach tags the caller didn't mention. The note's \`id\` and \`created_at\` are preserved either way.

A note's response carries \`existed\` (true/false) whenever ITS \`if_exists\` was one of \`"ignore"\`/\`"update"\`/\`"replace"\` — \`true\` when the collision branch fired, \`false\` when a normal fresh insert happened instead (including when \`path\` was never set, so there was nothing to conflict with — \`if_exists\` is a no-op without a \`path\`, but still reports \`existed: false\`). Absent entirely under the default \`"error"\` mode — a plain create-note call's response shape is byte-identical to before this feature. Batch-aware, per-item (like \`if_missing\` on \`update-note\`): set \`if_exists\` inside each \`notes[]\` entry — a top-level \`if_exists\` alongside a \`notes\` array is NOT inherited by items that omit their own (it only takes effect on the single-note form, where \`params\` IS the one item).

**Batch summary** — pass \`summary: true\` (batch/\`notes\` calls only; ignored on a single-note call) to receive a compact \`{created, ids, failed}\` shape instead of N full note objects: \`created\` counts items that resulted in a BRAND-NEW insert (excludes \`if_exists\` collisions); \`ids\` lists every resulting note id in item order (fresh creates AND \`existed\` hits alike); \`failed\` is reserved for future partial-batch-failure reporting — today a batch create is all-or-nothing (any thrown error aborts and rolls back the WHOLE call, same with or without \`summary\`), so it's always \`[]\`.`,
      inputSchema: {
        type: "object",
        properties: {
          // Single note fields
          content: { type: "string", description: "Note content (markdown). Wikilinks like [[Target]] auto-resolve." },
          path: { type: "string", description: "Note path (e.g., 'Projects/README')" },
          extension: { type: "string", description: "File extension (vault#328). Default \"md\". Use \"csv\"/\"yaml\"/\"json\"/\"mdx\"/etc. for non-markdown notes. Lowercase alphanumeric, 1–16 chars; no '.' or '/'. The \"parachute\" prefix is reserved." },
          metadata: { type: "object", description: "Metadata fields" },
          tags: { type: "array", items: { type: "string" }, description: "Tags to apply" },
          links: {
            type: "array",
            items: {
              type: "object",
              properties: {
                target: { type: "string", description: "Target note ID, path, or (fallback) H1 title" },
                relationship: { type: "string", description: "Relationship type (e.g., mentions, related-to)" },
              },
              required: ["target", "relationship"],
            },
            description: "Links to create from this note. `target` resolves with the SAME semantics as a [[wikilink]] (vault#555) — ID, then exact path, then basename, then (only on a clean miss, and only when exactly one note matches) an H1-title fallback. A target created LATER in the same `notes` batch, or by a future call, resolves automatically (queued + backfilled) — the response carries an `unresolved_link` warning naming the target in the meantime; never silently dropped.",
          },
          created_at: { type: "string", description: "ISO timestamp (defaults to now)" },
          if_exists: {
            type: "string",
            enum: ["error", "ignore", "update", "replace"],
            description: "What to do when `path` already names an existing note (vault#555). See the tool description for the full contract of each mode. Default \"error\" — unchanged path_conflict behavior.",
          },
          summary: {
            type: "boolean",
            description: "Batch calls only (a `notes` array): return a compact `{created, ids, failed}` shape instead of N full note objects. See the tool description. Ignored on a single-note call.",
          },
          // Batch
          notes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "Optional — defaults to \"\" (vault#555 fix: this item's schema previously marked it `required`, but it was never enforced; an empty-content batch item has always succeeded)." },
                path: { type: "string" },
                extension: { type: "string", description: "File extension (vault#328). See top-level docs." },
                metadata: { type: "object" },
                tags: { type: "array", items: { type: "string" } },
                links: { type: "array" },
                created_at: { type: "string" },
                if_exists: { type: "string", enum: ["error", "ignore", "update", "replace"], description: "Per-item: see top-level `if_exists` docs. Each batch item carries its own setting." },
              },
            },
            description: "Array of notes for batch creation",
          },
        },
      },
      condition: "core",
    },
    {
      name: "update-note",
      requiredVerb: "write",
      description: `Update one or more notes. Accepts ID, path, or (fallback, only when id/path both miss and exactly one note matches) its H1 title. Supports content, path, metadata updates plus tag and link mutations.

- Three content-modification modes (mutually exclusive):
  - \`content\` — full replace.
  - \`append\` / \`prepend\` — atomic concatenation at the SQL layer. Multiple agents appending to the same note never overwrite each other. No separator is added; include trailing/leading whitespace yourself if needed. May be combined with each other.
  - \`content_edit: { old_text, new_text }\` — surgical find-and-replace. \`old_text\` must occur exactly once; zero or multiple matches return an error. Add surrounding context to disambiguate.
- \`tags: { add: ["x"], remove: ["y"] }\` — add/remove tags
- \`links: { add: [{ target, relationship }], remove: [{ target, relationship }] }\` — add/remove links
- When removing a wikilink-type link, \`[[brackets]]\` are also removed from content.
- For batch: pass a \`notes\` array, each with an \`id\` field.
- **Optimistic concurrency is required by default.** Pass \`if_updated_at\` with the \`updated_at\` value you last read — the update is rejected with a conflict error if the note has changed since. Re-read, reconcile, and retry. To skip the safety check (e.g. bulk migration), pass \`force: true\` instead; the update then runs unconditionally. \`force\` only waives the *requirement to supply* \`if_updated_at\` — if you pass both, the precondition you supplied still applies and a mismatch returns a conflict error. \`append\` / \`prepend\` only updates are exempt from the precondition (no-conflict-by-design). **Batch default (vault#554):** a top-level \`force\` and/or \`if_updated_at\` alongside a \`notes\` array applies as the DEFAULT for every item that doesn't set its own — e.g. \`{force: true, notes: [{id: "a", content: "..."}, {id: "b", content: "...", if_updated_at: "..."}]}\` forces item "a" but still enforces the precondition on item "b" (its own \`if_updated_at\` wins). Per-item values always take precedence over the top-level default.
- **Idempotent upsert via \`if_missing: "create"\`** — when the note doesn't exist, create it from this same payload (content/path/tags/metadata become the create fields; OC precondition skipped — nothing to conflict with). Response carries \`created: true\`. Useful for nightly sync loops that don't know ahead of time whether the note exists. Default \`"fail"\` (current behavior — missing note errors). See vault#309.
- \`include_content\` (default \`true\`) — set \`false\` to receive a lean index shape (\`id\`, \`path\`, \`createdAt\`, \`updatedAt\`, \`createdBy\`, \`createdVia\`, \`lastUpdatedBy\`, \`lastUpdatedVia\`, \`tags\`, \`metadata\`, \`byteSize\`, \`preview\`, \`displayTitle\`) instead of full content. Useful for agents making frequent small edits to large notes (e.g. via \`append\` or \`content_edit\`) where re-receiving the body is the dominant cost. \`validation_status\` is preserved on the lean shape when present. \`displayTitle\` is the note's first non-empty content line (heading markers stripped, ~120 chars max), \`null\` when content is empty — never stored, computed fresh from content already in hand.

Write-attribution (vault#298): every result carries \`createdBy\`/\`createdVia\` (the principal + interface of the first write) and \`lastUpdatedBy\`/\`lastUpdatedVia\` (the most recent write). NULL on notes written before attribution existed. Filter on them with \`created_by\`/\`last_updated_by\`/\`created_via\`/\`last_updated_via\`. When the write was signed with a Nostr key (the hub's NIP-98 door), the \`*Via\` value is \`nostr:<64-hex-pubkey>\` — \`createdBy\` stays the hub USER, so the pubkey is what distinguishes two agents sharing that user.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID, path, or (fallback, only when id/path both miss and exactly one note matches) its H1 title" },
          content: { type: "string", description: "New content (full replace). Mutually exclusive with `append`/`prepend` and `content_edit`." },
          append: { type: "string", description: "Text to append to the end of the note. Atomic at the SQL layer — concurrent appends are safe. Mutually exclusive with `content` and `content_edit`. No precondition required." },
          prepend: { type: "string", description: "Text to prepend to the start of the note. Atomic at the SQL layer. Mutually exclusive with `content` and `content_edit`. May combine with `append`. No precondition required." },
          content_edit: {
            type: "object",
            properties: {
              old_text: { type: "string", description: "Exact text to find. Must match exactly once in the note's current content." },
              new_text: { type: "string", description: "Replacement text." },
            },
            required: ["old_text", "new_text"],
            description: "Find-and-replace one occurrence. Errors if `old_text` is not found or matches multiple locations. Mutually exclusive with `content` and `append`/`prepend`.",
          },
          path: { type: "string", description: "New path" },
          extension: { type: "string", description: "Change the note's file extension (vault#328). Allowed but caller-owned — you're responsible for content validity if you switch a non-empty note's extension. Lowercase alphanumeric, 1–16 chars; \"parachute\" prefix reserved." },
          metadata: { type: "object", description: "Metadata to merge (keys are merged, not replaced wholesale). A value of `null` deletes that key (RFC 7386 merge-patch) — e.g. `{\"new_key\": \"v\", \"old_key\": null}` renames in one call. Omitting a key preserves its existing value." },
          created_at: { type: "string", description: "New created_at timestamp" },
          if_updated_at: { type: "string", description: "Optimistic concurrency check: the updated_at value you last read. Rejects with a conflict error if the note has been modified since. Required unless `force: true` is set or the call is `append`/`prepend`-only." },
          force: { type: "boolean", description: "Waive the *requirement to supply* `if_updated_at` and run the update unconditionally. Use only for bulk migrations or scripted writes where concurrency is known-safe. Note: this does not override an `if_updated_at` you actually pass — if you supply both, the precondition still applies and a mismatch returns a conflict error." },
          if_missing: { type: "string", enum: ["fail", "create"], description: "What to do when the note (by `id`/path) doesn't exist. `\"fail\"` (default) — error, current behavior. `\"create\"` — create the note from this same payload (content/path/tags/metadata become the create fields; the response carries `created: true`). Skips the `if_updated_at` precondition on the create branch (nothing to conflict with). Idempotent for sync loops that don't know ahead of time whether the note exists. See vault#309." },
          state_transition: {
            type: "object",
            properties: {
              field: { type: "string", description: "Metadata field to transition." },
              from: { description: "Required current value. The transition only commits if the field currently equals this. A missing field is a conflict; pass `null` to match a field that is absent or explicitly null." },
              to: { description: "New value to set when the `from` precondition holds." },
            },
            required: ["field", "from", "to"],
            description: "Atomic compare-and-set state transition (vault#299). If the metadata `field` currently equals `from`, set it to `to` and commit; otherwise the write is rejected with a `transition_conflict` error (a missing field counts as a conflict; `from: null` matches absent-or-null). A transition-ONLY update needs no `if_updated_at`/`force` — the compare-and-set is the precondition. Combinable with other field updates (they land in the same atomic UPDATE), but a combined call still needs `if_updated_at`/`force` for the OTHER fields — the CAS only guards the transitioned field. Use this to advance a state machine race-safely in one round trip instead of read → check → conditional update.",
          },
          tags: {
            type: "object",
            properties: {
              add: { type: "array", items: { type: "string" } },
              remove: { type: "array", items: { type: "string" } },
            },
            description: "Tags to add/remove",
          },
          links: {
            type: "object",
            properties: {
              add: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    target: { type: "string", description: "Target note ID, path, or (fallback) H1 title" },
                    relationship: { type: "string" },
                  },
                  required: ["target", "relationship"],
                },
              },
              remove: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    target: { type: "string", description: "Target note ID, path, or (fallback) H1 title" },
                    relationship: { type: "string" },
                  },
                  required: ["target", "relationship"],
                },
              },
            },
            description: "Links to add/remove. `add[].target` resolves with the SAME semantics as a [[wikilink]] (vault#555) — ID, then exact path, then basename, then (only on a clean miss, and only when exactly one note matches) an H1-title fallback — and lazily backfills (queued) when the target arrives later; the response carries an `unresolved_link` warning naming the target in the meantime, never a silent drop.",
          },
          include_content: {
            type: "boolean",
            description: "Response shape opt-out. Default `true` (returns the full Note with content). Set `false` to receive the lean index shape (drops `content`, adds `byteSize`, a whitespace-collapsed `preview`, and a computed `displayTitle`). `validation_status` is preserved on the lean shape when present. Applies uniformly to single and batch responses.",
          },
          include_links: {
            type: "boolean",
            description: "Echo the note's hydrated inbound + outbound links on the response (vault feedback #8). Links are *also* echoed automatically whenever the update itself mutated links (`links.add`/`links.remove`), so you rarely need to set this — its purpose is to fetch the current link set on an update that didn't touch links. Default: `false` (and absent from the response unless mutated or requested). Mirrors `query-notes`'s `include_links`. This top-level flag applies to the single-note form only; for a batch, set `include_links` on each note object in `notes` (a top-level `include_links` is ignored when `notes` is present).",
          },
          // Batch
          notes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                append: { type: "string" },
                prepend: { type: "string" },
                content_edit: {
                  type: "object",
                  properties: {
                    old_text: { type: "string" },
                    new_text: { type: "string" },
                  },
                  required: ["old_text", "new_text"],
                },
                path: { type: "string" },
                extension: { type: "string", description: "Change the note's file extension (vault#328). See top-level docs." },
                metadata: { type: "object" },
                created_at: { type: "string" },
                if_updated_at: { type: "string", description: "Optimistic concurrency check for this item; rejects with a conflict error if the note has been modified since. Required unless `force: true` is set on this item or the item is `append`/`prepend`-only." },
                force: { type: "boolean", description: "Waive the *requirement to supply* `if_updated_at` for this item. Does not override an `if_updated_at` you actually pass — a supplied precondition still applies and a mismatch conflicts." },
                if_missing: { type: "string", enum: ["fail", "create"], description: "Per-item: see top-level `if_missing` docs. Each batch item carries its own setting." },
                state_transition: {
                  type: "object",
                  properties: {
                    field: { type: "string" },
                    from: {},
                    to: {},
                  },
                  required: ["field", "from", "to"],
                  description: "Per-item compare-and-set state transition (vault#299). See top-level `state_transition` docs.",
                },
                tags: { type: "object" },
                links: { type: "object" },
                include_links: { type: "boolean", description: "Per-item: echo hydrated links on this item's response (vault feedback #8). Also implied when this item mutates links." },
              },
              required: ["id"],
            },
            description: "Array of note updates for batch",
          },
        },
      },
      condition: "core",
    },
    {
      name: "delete-note",
      // `write` — same destructive verb as update-note. Aaron's call
      // 2026-05-27: "delete- in write; right now the only admin gated
      // thing is tokens." Reserving `admin` for "operator-only
      // capabilities" (token mgmt + future config writes). A future
      // finer-grained model might split `vault:write:no-delete` for
      // genuinely append-only callers — gating WITHIN write rather
      // than promoting deletes out of it.
      requiredVerb: "write",
      description: "Permanently delete a note and all its tags and links. Accepts ID, path, or (fallback, only when id/path both miss and exactly one note matches) its H1 title.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note ID, path, or (fallback, only when id/path both miss and exactly one note matches) its H1 title" },
        },
        required: ["id"],
      },
      condition: "core",
    },
    {
      name: "list-tags",
      requiredVerb: "read",
      description: `List tags with usage counts. Each row carries \`count\` (notes carrying the EXACT tag) and \`expanded_count\` (vault#550 — distinct notes matching the tag OR any transitive descendant under the default subtypes expansion; use this to see a parent tag's true rollup when its notes are actually tagged with a more specific child). Pass \`tag\` to get a single tag's full record (description, fields, relationships, parent_names, timestamps) — errors with \`error_type: "tag_not_found"\` (plus a \`did_you_mean\` hint when a close match exists) if the tag has no identity row and no notes. Pass \`include_schema: true\` to include the full record for every tag. NOTE (vault#555): this list includes zero-membership tags (\`count: 0\` — a declared schema never yet applied, or a tag every note was since untagged from), so its length can run higher than \`vault-info\`'s stats \`tagCount\`, which counts only tags at least one note currently carries.`,
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Get details for a single tag" },
          include_schema: { type: "boolean", description: "Include full tag record (description, fields, relationships, parent_names, timestamps) for each tag (default: false)" },
        },
      },
      condition: "core",
    },
    {
      name: "update-tag",
      // `admin` (was `write`) — this PR: update-tag defines a tag's SCHEMA
      // (description, indexed-field types, relationship vocabulary,
      // hierarchy parents), which every note carrying the tag inherits.
      // That's structure/taxonomy curation, not content authorship — the
      // same distinction that keeps content out of admin and structure out
      // of write. See the `generateMcpTools` doc comment above for the full
      // re-tier rationale + BREAKING note.
      requiredVerb: "admin",
      description: "Create or update a tag's identity row: description, indexed-field schemas, relationship-vocabulary map, and hierarchy parents. If the tag doesn't exist, it's created. Fields are merged (new keys added, existing keys replaced); relationships and parent_names are replaced wholesale when provided. Pass null for fields/relationships/parent_names to clear that column. See parachute-vault/docs/contracts/tag-data-model.md.",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Tag name" },
          description: { type: "string", description: "Human-readable description of what this tag means" },
          fields: {
            type: "object",
            description: 'Metadata fields notes with this tag should have. E.g., { "status": { "type": "string", "enum": ["active", "archived"], "strict": true, "default": "active" } }. Constraints are ADVISORY by default (violations surface as validation_status warnings; the write still succeeds). Mark a field `strict: true` to ENFORCE all its constraints — type + enum + required + cardinality flip to hard write rejections (vault#299). Mark a field `indexed: true` to make it queryable — an indexed field\'s TYPE is ALWAYS enforced (a type-mismatched write is REJECTED, independent of `strict`) because a bad-typed value silently poisons range-query ordering (vault#553).',
            additionalProperties: {
              type: "object",
              properties: {
                type: { type: "string", description: "Field type: string, boolean, integer, number, array, object, reference, date — all eight are accepted for storage + advisory validation; any OTHER value is rejected outright (error_type invalid_field_type, vault#555 — bundled with every other violation in the same call, see the `update-tag` tool description). Only string/integer/boolean/reference/date are INDEXABLE (see `indexed` below); declaring `indexed: true` with number/array/object is rejected (unsupported_indexed_type / invalid_indexed_field). `reference` is a DUAL-WRITE type (typed-reference-field): the value is stored + validated exactly like `string` (pass a note id, path, or title), AND create-note/update-note additionally resolve that value to a note and maintain a graph `links` edge from this note to it, with `relationship` set to the field name — kept in sync on every write that changes the field (a new value re-points the link; clearing the field drops it). A target that doesn't resolve yet is queued and backfills automatically, same as a structured `links` entry — see `docs/design/typed-reference-field.md`. `date` stores/validates exactly like `string`, but the value must be an ISO-8601 date (`2026-07-09`) or full timestamp (`2026-07-09T00:00:00.000Z`) — an unparseable value is a type_mismatch (advisory) or a rejected write (`strict: true` / `indexed: true`), same treatment as any other type mismatch. A full timestamp carrying an explicit `±HH:MM` offset is normalized to canonical UTC (`Z`-suffixed) on write — the offset is accepted, but not persisted verbatim — so indexed `date` fields sort/filter correctly under the TEXT comparison `gt`/`gte`/`lt`/`lte`/`date_filter`/`order_by` all use; a bare date (no time component) is left as-is." },
                description: { type: "string" },
                enum: { type: "array", items: { type: "string" }, description: "Allowed values. Does NOT auto-backfill — a note that omits this field stays without it unless `default` is also set (vault#553; the pre-0.7.0 behavior of silently defaulting to the first enum value is retired). Set `default` explicitly if you want backfill." },
                default: { description: "Explicit backfill value (vault#553) applied when a note gains this tag without setting the field. Must conform to this field's own `type` (and `enum`, if declared) — a non-conforming default is rejected (invalid_default / invalid_field_default) rather than silently stored. Omit entirely to leave the field ABSENT (not backfilled) on notes that don't set it — this is what makes `exists:false` a trustworthy \"never set\" query." },
                indexed: { type: "boolean", description: "When true, a generated column + index are maintained on notes.metadata.<field>, making it queryable via metadata operator objects and order_by. Global: all tags declaring the field must agree on both type and indexed. Only string/integer/boolean/reference/date are indexable. Indexed ⇒ a type-mismatched write is HARD-REJECTED (schema_validation), not just warned — vault#553." },
                strict: { type: "boolean", description: "vault#299. Default false (advisory). When true, ALL of this field's declared constraints (type + enum + required + cardinality) are ENFORCED — a violating write is rejected with a schema_validation error, not just warned. All-or-nothing per field; free-form fields on a strict tag simply leave strict off. Note: `indexed: true` fields enforce their TYPE constraint regardless of this flag (vault#553)." },
                required: { type: "boolean", description: "vault#299. The field must be present + non-null on a note with this tag. Advisory unless `strict: true`." },
                cardinality: { type: "string", enum: ["one", "many"], description: "vault#299. 'one' (scalar, default) or 'many' (array). Advisory unless `strict: true`." },
              },
              required: ["type"],
            },
          },
          relationships: {
            type: "object",
            description: 'Opaque relationship-vocabulary map: keys are relationship names, values are arbitrary JSON the declaring app interprets. Vault stores and returns the values verbatim and does NOT enforce any inner shape — only that this is a JSON object (a map), not an array or primitive. Replaces any prior map wholesale when provided; pass null to clear. The historical typed shape { "lives_in": { "target_tag": "place", "cardinality": "one" } } is still a valid value, as is any app-defined shape e.g. { "works-on": { "from": "person", "to": "project" } }.',
            additionalProperties: true,
          },
          parent_names: {
            type: "array",
            items: { type: "string" },
            description: "Tag names this tag is a child of, for the query-time hierarchy. Replaces any prior parent list. Pass [] (empty array) or null to clear. E.g., parent_names: [\"manual\", \"note\"] makes this tag a descendant of both.",
          },
        },
        required: ["tag"],
      },
      condition: "core",
    },
    {
      name: "delete-tag",
      // `admin` (was `write` — Aaron's 2026-05-27 call reserved admin for
      // token mgmt + future config writes; deletes were write-tier
      // mutations, see delete-note's rationale). Superseded by this PR:
      // delete-tag removes a tag's identity row + schema and untags it
      // vault-wide — that's structure/taxonomy curation, the same class as
      // update-tag/rename-tag/merge-tags, not content authorship. See the
      // `generateMcpTools` doc comment above for the full re-tier rationale
      // + BREAKING note.
      requiredVerb: "admin",
      description: "Delete a tag, remove it from all notes, and delete its schema. Notes themselves are NOT deleted — just untagged. Refused with error_type \"tag_referenced_as_parent\" (vault#552) when another tag's parent_names still names this one — pass cascade OR detach (either — both mean the same thing: strip the stale reference from the referencing tag(s)' parent_names, never delete them) to proceed anyway. Also refused with error_type \"tag_in_use_by_tokens\" (vault#555 fix — this case existed pre-#555 but was undocumented here; see \"merge-tags\" for the identical guard) when the tag is referenced by a tag-scoped token's allowlist — revoke or re-mint the token(s) first. A no-op on a tag with no identity row and no notes returns {deleted: false, notes_untagged: 0} rather than erroring.",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Tag name to delete" },
          cascade: { type: "boolean", description: "Proceed even though another tag's parent_names references this one, stripping the reference. Synonym of detach." },
          detach: { type: "boolean", description: "Same as cascade — proceed and strip the stale parent_names reference from referencing tag(s)." },
        },
        required: ["tag"],
      },
      condition: "core",
    },
    {
      name: "rename-tag",
      // `admin` (was `write`) — this PR: an atomic cascading rename across
      // note memberships, other tags' parent_names, tokens' allowlists,
      // indexed-field declarer lists, and inline #tag mentions is structural
      // taxonomy surgery, not content authorship. Same tier as
      // update-tag/delete-tag/merge-tags. See the `generateMcpTools` doc
      // comment above for the full re-tier rationale + BREAKING note.
      requiredVerb: "admin",
      description:
        "Atomically rename a tag across EVERY surface that references it: note memberships, OTHER tags' parent_names, tag-scoped tokens' allowlists, indexed-field declarer lists, inline #tag mentions in note bodies, and _tags/<name> config-note paths — all in one transaction. THIS is the fix for the manual retag→delete dance (create the new tag, retag notes, delete the old one): that dance silently orphans parent_names references (the renamed-away tag stays a live query surface via subtype expansion while list-tags reports it at count 0, and the new tag misses every child-tagged note) and leaves stale #tag mentions behind. Sub-tags rename recursively — renaming \"task\" to \"todo\" also renames \"task/work\" to \"todo/work\". Does NOT rewrite metadata values that happen to equal the old tag name (e.g. metadata.epic: \"task\") — that's a distinct drift class the doctor tool's dead_tag_metadata_reference finding flags heuristically; rename-tag's job is structural (tags/note_tags/parent_names/tokens/content), not a blind string search-and-replace over arbitrary metadata.",
      inputSchema: {
        type: "object",
        properties: {
          old_name: { type: "string", description: "The tag to rename. Aliases: from, tag." },
          new_name: { type: "string", description: "The new name. Alias: to." },
          from: { type: "string", description: "Alias for old_name." },
          to: { type: "string", description: "Alias for new_name." },
          tag: { type: "string", description: "Alias for old_name." },
        },
      },
      condition: "core",
    },
    {
      name: "merge-tags",
      // `admin` (was `write`) — this PR: merging N source tags into a
      // target (retagging every note, dropping the sources' identity rows)
      // is structural taxonomy surgery, not content authorship. Same tier
      // as update-tag/delete-tag/rename-tag. See the `generateMcpTools` doc
      // comment above for the full re-tier rationale + BREAKING note.
      requiredVerb: "admin",
      description:
        "Atomically merge one or more source tags into a target tag: every note carrying any source is retagged with the target, then the source tags (and their identity rows — description/fields/relationships/parent_names) are dropped. target is created if it doesn't exist yet; target's own schema is preserved (sources' schemas are consumed, not merged field-by-field). Sources that don't exist are reported at count 0. Refused with error_type \"tag_in_use_by_tokens\" if a source is referenced by a tag-scoped token — revoke or re-mint it first.",
      inputSchema: {
        type: "object",
        properties: {
          sources: { type: "array", items: { type: "string" }, description: "Tag names to merge away into target." },
          target: { type: "string", description: "The tag that survives; sources are retagged onto it and dropped." },
        },
        required: ["sources", "target"],
      },
      condition: "core",
    },
    {
      name: "find-path",
      requiredVerb: "read",
      description: "Find the shortest path between two notes in the link graph. Accepts IDs, paths, or (fallback, only when id/path both miss and exactly one note matches) H1 titles. Returns null if no path exists, else `{path, relationships, nodes, edges}`: `path` (note IDs, source→target) and `relationships` (relationships[i] connects path[i] to path[i+1]) are the original id-only shape; `nodes` (vault#550, additive) hydrates each id in `path` with the note's own `path` field — `[{id, path}]` in the same order; `edges` (additive) is the self-contained hop list — `[{source, target, relationship, sourcePath, targetPath}]` — for rendering the chain without cross-referencing `nodes`.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Starting note ID, path, or (fallback) H1 title" },
          target: { type: "string", description: "Destination note ID, path, or (fallback) H1 title" },
          max_depth: { type: "number", description: "Max path length (default 5)" },
        },
        required: ["source", "target"],
      },
      condition: "core",
    },
    {
      name: "vault-info",
      // `read` so vault:read callers can fetch stats. The
      // description-update branch performs an inner ADMIN-check (see
      // overrideVaultInfo in src/mcp-tools.ts) — do not promote this to
      // `admin` or read-only callers lose the stats projection. Was an
      // inner write-check pre-this-PR; writing the vault's own
      // description/config is curation, not content, so it moved to the
      // same admin tier as the other structure-curation tools (update-tag
      // et al) — see the `generateMcpTools` doc comment above.
      requiredVerb: "read",
      description: "Get a comprehensive vault projection: name, description, `coordinates` (this vault's own REST/MCP URL templates — `{name, base_url, rest_api, mcp}`, always present), tags-with-schemas (own + effective parents/fields per #270 inheritance), indexed metadata fields catalog, query hints, `map` (front-door structural orientation, always present — see below), and (when a seeded onboarding guide exists) a `getting_started` note pointer. Pass `include_stats: true` to add note/tag/link counts and the monthly distribution as a `stats` field. Pass `description` to update the vault description (changes how AI agents behave in future sessions) — requires the `vault:admin` scope for this vault even though the tool itself is read-gated (vault#555 originally required `vault:write` here; a later PR tightened it to `vault:admin` since a description edit is curation, not content — a `vault:read`-or-`vault:write`-only caller passing `description` gets a `Forbidden` rejection, not a silent no-op). Call this anytime mid-session to refresh schema context. NOTE (vault#555): the stats `tagCount` counts only tags at least one note currently carries (`COUNT(DISTINCT tag_name)` over note-tag memberships) — `list-tags`'s row count can run higher because it also lists zero-membership tags (an identity row from a declared schema or a since-untagged tag). Neither is wrong; they answer different questions. `map` — `{ total_notes, tags: [{name, count}], path_buckets: [{name, count}], unfiled_notes }` — is a compact, counts-only structural rollup (no content) meant to orient a fresh reader in this ONE call, no `include_stats` needed: every tag currently in use with its membership count, and every top-level path segment (the text before the first `/`) with how many notes live under it, plus how many notes carry no path at all. For a tag-scoped token, `map.tags`/`map.path_buckets`/`map.total_notes`/`map.unfiled_notes` cover only notes reachable through an in-scope tag — same confidentiality posture as the `tags`/`indexed_fields` catalogs above.",
      inputSchema: {
        type: "object",
        properties: {
          include_stats: { type: "boolean", description: "Include note count, tag count, attachment/link counts, and the monthly note distribution (default: false)" },
          description: { type: "string", description: "If provided, updates the vault description" },
        },
      },
      // execute is overridden in mcp-tools.ts where vault config is available
      condition: "core",
    },
    {
      name: "prune-schema",
      // `admin` — a destructive schema-maintenance op, same tier as
      // manage-token. Operator-only; hidden from read/write sessions.
      requiredVerb: "admin",
      description:
        "Drop orphaned indexed-field columns + indexes whose declaring tags no longer exist (the result of a deleted tag never releasing its fields). Dry-run by default — returns the drop plan without mutating. Pass `apply: true` to execute. A field co-declared by a still-live tag is never dropped; only the dead declarers are trimmed from its set. Generated columns are derived from notes.metadata JSON, so a drop loses only the index, never source data — declare the field again to rebuild it.",
      inputSchema: {
        type: "object",
        properties: {
          apply: {
            type: "boolean",
            description: "Execute the prune. Default false (dry-run — report what would be dropped without changing anything).",
          },
        },
      },
      condition: "core",
    },
    {
      name: "doctor",
      // `read` (was `admin` — the original reasoning: same tier as
      // prune-schema, a diagnostic over the WHOLE vault's taxonomy, not
      // scoped to any one tag's write authority). Superseded by this PR:
      // doctor never mutates and is ALREADY tag-scope-restricted at the MCP
      // layer (see `applyTagScopeWrappers`'s `doctor` wrapper in
      // src/mcp-tools.ts, which re-runs the scan against the caller's
      // allowlist) — it's a read, not a curation op, and read-scoped
      // monitoring/tending jobs need to be able to run it without an admin
      // credential. The REST `GET /api/doctor` endpoint (routing.ts) is
      // re-tiered to `read` too, so both doors agree — no MCP/REST divergence.
      requiredVerb: "read",
      description:
        "Read-only integrity scan across the tag/metadata taxonomy — run this after any bulk tag reorg (rename/merge/delete/subtree move) to confirm nothing leaked. Returns {findings, summary, scanned_at} — findings is an array, each entry {type, severity, subject, detail, remedy} — NEVER auto-fixes; apply the suggested remedy (usually rename-tag/merge-tags/update-tag/prune-schema) yourself. Finding types: dangling_parent_name (a parent_names entry naming a tag with no identity row), parent_names_cycle (a tag reaching itself through its ancestor chain — traversal tolerates this, but it's dishonest hierarchy state), mixed_type_indexed_field (a note's metadata value for an indexed field has a JSON type disagreeing with the field's declared storage type — the ordering/filtering-goes-silently-wrong precursor), orphaned_indexed_field_declarer (an indexed field naming a dead declarer tag — see prune-schema), and dead_tag_metadata_reference (HEURISTIC, always carries heuristic:true — a metadata value that looks like a stale reference to a renamed/merged/deleted tag, inferred from sibling notes using the same metadata key with values that ARE live tags; can never be certain since vault keeps no tag-rename history).",
      inputSchema: { type: "object", properties: {} },
      condition: "core",
    },
    {
      name: "request-attachment-upload",
      requiredVerb: "write",
      description:
        "Mint a short-lived, single-use upload URL for a note attachment. Bytes never pass through this tool — you get back a URL (+ a ready-to-run `curl_example`) your runtime's shell spends directly; no MCP session credential is needed to spend it. Provide the target `note` (id or path), the `filename`, and its exact `size_bytes` — declared here and enforced at spend (a mismatch, or exceeding the 100 MiB REST upload cap, fails the mint or the upload). `mime_type` is inferred from the filename's extension when omitted. Pass `transcribe: true` for an audio file to enqueue it exactly like the REST attach flow does; `segment_index` additionally splits one recording across several attachments on the same note (voice W2 — see that field's description). The ticket's `expires_at` scales with declared size (10 minutes base + 10s per MiB, capped at 30 minutes) and can be spent exactly once — a failed curl means re-minting, not retrying the same URL.",
      inputSchema: {
        type: "object",
        properties: {
          note: { type: "string", description: "Target note ID or path" },
          filename: { type: "string", description: "Original filename — sanitized for a blocked extension (active-content types: .html/.svg/.xml/.js/.css/…) and used to infer the MIME type when `mime_type` is omitted." },
          size_bytes: {
            type: "number",
            description: `Declared upload size in bytes. Must be > 0 and <= ${MAX_TICKET_UPLOAD_BYTES} (100 MiB — the same ceiling REST's own /storage/upload enforces). The spend endpoint rejects (413) any upload that exceeds this declared size.`,
          },
          mime_type: { type: "string", description: "MIME type to store on the attachment row. Inferred from `filename`'s extension when omitted (`application/octet-stream` for an uncurated extension)." },
          transcribe: { type: "boolean", description: "Opt into transcription for an audio attachment — mirrors the REST `POST /notes/:id/attachments` `transcribe` flag." },
          segment_index: {
            type: "number",
            description: "Only meaningful alongside `transcribe: true`. An integer >= 0 that marks this attachment as one part of a multi-part recording linked to the same note — each part resolves into its own `_Transcript pending (part N)._` marker (N = segment_index + 1) instead of overwriting a shared bare marker. A malformed value (non-integer, negative, non-number) is silently ignored, falling back to the un-segmented bare marker.",
          },
        },
        required: ["note", "filename", "size_bytes"],
      },
      condition: "attachment-tickets",
    },
    {
      name: "request-attachment-download",
      requiredVerb: "read",
      description:
        "Mint a short-lived, single-use download URL for an existing attachment's bytes. Bytes never pass through this tool — you get back a URL (+ a ready-to-run `curl_example`) your runtime's shell spends directly; no MCP session credential is needed to spend it. Pass the `attachment_id` from a note's `include_attachments: true` rows (query-notes) or `GET .../attachments`. The ticket's `expires_at` follows the same size-scaled window as upload tickets (10 minutes base, up to 30) and can be spent exactly once.",
      inputSchema: {
        type: "object",
        properties: {
          attachment_id: { type: "string", description: "The attachment's id (from a note's attachment rows)" },
        },
        required: ["attachment_id"],
      },
      condition: "attachment-tickets",
    },
    {
      name: "read-attachment",
      requiredVerb: "read",
      description:
        "Read an attachment's content directly into this conversation (the model lane — bytes DO pass through this tool, unlike request-attachment-upload/download). Behavior depends on mime type: text/* (+ json/ndjson/yaml — csv/markdown are already text/*) returns a byte-windowed `content` slice using the exact query-notes content_offset/content_length/content_next_offset pagination contract (default 65536 bytes / 64 KiB, max 262144 / 256 KiB per call — loop, feeding content_next_offset back as content_offset, for more). image/* returns a real image you can see, capped at 4 MiB raw (over-cap refuses with a pointer to request-attachment-download; content_offset/content_length don't apply to images). audio/video never send bytes — you get back a transcript pointer (transcribe_status, note_id, and a transcript_note when one exists) instead of the audio itself. PDF and other binary formats aren't directly readable here — mint a download ticket with request-attachment-download and process the file with your own runtime.",
      inputSchema: {
        type: "object",
        properties: {
          attachment_id: {
            type: "string",
            description: "The attachment's id (from a note's attachment rows, e.g. include_attachments: true on query-notes)",
          },
          content_offset: {
            type: "number",
            description: "Text attachments only. Byte offset to start reading from (UTF-8 bytes). Defaults to 0.",
          },
          content_length: {
            type: "number",
            description: "Text attachments only. Byte budget for this call. Defaults to 65536 (64 KiB); max 262144 (256 KiB).",
          },
        },
        required: ["attachment_id"],
      },
      condition: "attachment-bytes",
    },
];
