/**
 * VaultSchema tests (vault#283) — the Schema editor.
 *
 * Covers: tag list renders with badges; selecting a tag loads + renders the
 * fields editor + effective-fields preview + indexed catalog; editing a field
 * + Save calls PUT /api/tags/:name with the right body (full merged fields);
 * the conformance warning fires when tightening (and Save-anyway proceeds).
 *
 * `lib/schema-api.ts` is mocked for the wire surface; `lib/scope.ts` is
 * mocked so admin-vs-read gating is controllable per test.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as schemaApi from "../lib/schema-api.ts";
import * as scope from "../lib/scope.ts";
import { VaultSchema, validateRowsClientSide } from "./VaultSchema.tsx";

/** Render the per-vault-mount Schema editor inside a router. */
function renderSchema(vaultName = "journal") {
  return render(
    <MemoryRouter initialEntries={[`/vault/${vaultName}/schema`]}>
      <VaultSchema vaultName={vaultName} />
    </MemoryRouter>,
  );
}

// Preserve HttpError + the real constants/helpers; stub the network fns.
vi.mock("../lib/schema-api.ts", async () => {
  const actual = await vi.importActual<typeof import("../lib/schema-api.ts")>(
    "../lib/schema-api.ts",
  );
  return {
    ...actual,
    listSchemaTags: vi.fn(),
    getTagRecord: vi.fn(),
    getEffectiveSchema: vi.fn(),
    saveTag: vi.fn(),
    checkConformance: vi.fn(),
  };
});
vi.mock("../lib/scope.ts");

const tagsFixture = (): schemaApi.TagListEntry[] => [
  {
    name: "task",
    count: 12,
    description: "A unit of work",
    fields: {
      status: { type: "string", enum: ["open", "done"], indexed: true },
      due: { type: "string" },
    },
    relationships: null,
    parent_names: null,
    created_at: null,
    updated_at: null,
  },
  {
    name: "person",
    count: 3,
    description: null,
    fields: { name: { type: "string", strict: true, required: true } },
    relationships: null,
    parent_names: null,
    created_at: null,
    updated_at: null,
  },
];

const recordFixture = (): schemaApi.TagRecordResult => ({
  name: "task",
  count: 12,
  description: "A unit of work",
  fields: {
    status: { type: "string", enum: ["open", "done"], indexed: true },
    due: { type: "string" },
  },
  relationships: null,
  parent_names: null,
  created_at: null,
  updated_at: null,
});

const effectiveFixture = (): schemaApi.EffectiveSchemaResult => ({
  name: "task",
  parents: [],
  effective_parents: [],
  fields: {
    status: { type: "string", enum: ["open", "done"], indexed: true },
    due: { type: "string" },
  },
  effective_fields: {
    status: { type: "string", enum: ["open", "done"], indexed: true },
    due: { type: "string" },
  },
  indexed_fields: [{ name: "status", type: "string", tags: ["task"] }],
});

beforeEach(() => {
  vi.mocked(scope.hasAdminScope).mockReturnValue(true);
  vi.mocked(schemaApi.listSchemaTags).mockResolvedValue(tagsFixture());
  vi.mocked(schemaApi.getTagRecord).mockResolvedValue(recordFixture());
  vi.mocked(schemaApi.getEffectiveSchema).mockResolvedValue(effectiveFixture());
  vi.mocked(schemaApi.saveTag).mockResolvedValue(recordFixture());
  vi.mocked(schemaApi.checkConformance).mockResolvedValue({
    tag: "task",
    total_notes: 12,
    violating_notes: 0,
    checked_fields: ["status", "due"],
    sample: [],
  });
});

describe("VaultSchema — tag list", () => {
  it("renders the tag list with badges", async () => {
    renderSchema();
    await waitFor(() => expect(screen.getByText("task")).toBeInTheDocument());
    expect(screen.getByText("person")).toBeInTheDocument();
    // task has 1 indexed field + a schema badge.
    expect(screen.getAllByText("schema").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("1 indexed")).toBeInTheDocument();
    // person carries a strict field.
    expect(screen.getByText("strict")).toBeInTheDocument();
  });

  it("prompts to select a tag before one is chosen", async () => {
    renderSchema();
    await waitFor(() => expect(screen.getByText("task")).toBeInTheDocument());
    expect(
      screen.getByText(/select a tag to view or edit its schema/i),
    ).toBeInTheDocument();
  });
});

describe("VaultSchema — fields editor", () => {
  it("loads + renders the fields editor with the effective preview + indexed catalog", async () => {
    const user = userEvent.setup();
    renderSchema();
    await waitFor(() => expect(screen.getByText("task")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /^task/ }));

    await waitFor(() =>
      expect(schemaApi.getTagRecord).toHaveBeenCalledWith("journal", "task"),
    );
    expect(schemaApi.getEffectiveSchema).toHaveBeenCalledWith("journal", "task");

    // Field rows present (name inputs).
    const nameInputs = await screen.findAllByLabelText("Field name");
    const values = nameInputs.map((i) => (i as HTMLInputElement).value);
    expect(values).toContain("status");
    expect(values).toContain("due");

    // Effective-fields preview + indexed catalog headings render.
    expect(
      screen.getByText(/effective fields \(what a note actually gets\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/indexed fields \(what's queryable\)/i)).toBeInTheDocument();
  });

  it("Save calls PUT with the full merged fields object + description + parents", async () => {
    const user = userEvent.setup();
    renderSchema();
    await waitFor(() => expect(screen.getByText("task")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^task/ }));
    await screen.findAllByLabelText("Field name");

    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    // Conformance check runs first (no violations → proceeds to save).
    await waitFor(() => expect(schemaApi.checkConformance).toHaveBeenCalled());
    await waitFor(() => expect(schemaApi.saveTag).toHaveBeenCalled());

    const [vaultArg, tagArg, patch] = vi.mocked(schemaApi.saveTag).mock.calls[0]!;
    expect(vaultArg).toBe("journal");
    expect(tagArg).toBe("task");
    expect(patch.description).toBe("A unit of work");
    // Full merged fields — both existing fields sent (not silently dropped).
    expect(Object.keys(patch.fields ?? {})).toEqual(
      expect.arrayContaining(["status", "due"]),
    );
    expect(patch.fields?.status?.indexed).toBe(true);
    // The editor sends the full intended map → replace_fields must be set so
    // the server treats it as a replacement (a removed row actually drops the
    // field rather than being resurrected by the server-side merge).
    expect(patch.replace_fields).toBe(true);
  });

  it("removing a field drops it from the saved fields map", async () => {
    const user = userEvent.setup();
    renderSchema();
    await waitFor(() => expect(screen.getByText("task")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^task/ }));
    await screen.findAllByLabelText("Field name");

    // Remove the `due` field.
    await user.click(screen.getByRole("button", { name: /Remove field due/i }));
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(schemaApi.saveTag).toHaveBeenCalled());
    const patch = vi.mocked(schemaApi.saveTag).mock.calls[0]![2];
    expect(Object.keys(patch.fields ?? {})).toContain("status");
    expect(Object.keys(patch.fields ?? {})).not.toContain("due");
  });
});

describe("VaultSchema — conformance warning", () => {
  it("fires when tightening would break existing notes + Save-anyway proceeds", async () => {
    vi.mocked(schemaApi.checkConformance).mockResolvedValue({
      tag: "task",
      total_notes: 12,
      violating_notes: 4,
      checked_fields: ["status"],
      sample: [
        { id: "n1", path: "tasks/old", fields: [{ field: "status", reason: "enum_mismatch", message: "x" }] },
      ],
    });

    const user = userEvent.setup();
    renderSchema();
    await waitFor(() => expect(screen.getByText("task")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^task/ }));
    await screen.findAllByLabelText("Field name");

    // First Save → conformance check fires the warning, no save yet.
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() =>
      expect(screen.getByText(/4 existing notes violate this schema/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/parachute-vault schema migrate-field/i)).toBeInTheDocument();
    expect(schemaApi.saveTag).not.toHaveBeenCalled();

    // Second click ("Save anyway") proceeds.
    await user.click(screen.getByRole("button", { name: /save anyway/i }));
    await waitFor(() => expect(schemaApi.saveTag).toHaveBeenCalledTimes(1));
  });

  it("when the conformance check itself fails, the next click saves anyway", async () => {
    vi.mocked(schemaApi.checkConformance).mockRejectedValue(new Error("network down"));

    const user = userEvent.setup();
    renderSchema();
    await waitFor(() => expect(screen.getByText("task")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^task/ }));
    await screen.findAllByLabelText("Field name");

    // First Save → check throws → error + flip to "Save anyway", no save yet.
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() =>
      expect(screen.getByText(/could not check existing notes/i)).toBeInTheDocument(),
    );
    expect(schemaApi.saveTag).not.toHaveBeenCalled();

    // Second click saves directly without re-running the (failing) check.
    await user.click(screen.getByRole("button", { name: /save anyway/i }));
    await waitFor(() => expect(schemaApi.saveTag).toHaveBeenCalledTimes(1));
  });
});

describe("VaultSchema — read-only", () => {
  it("hides the Save button affordance for a non-admin token", async () => {
    vi.mocked(scope.hasAdminScope).mockReturnValue(false);
    const user = userEvent.setup();
    renderSchema();
    await waitFor(() => expect(screen.getByText("task")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^task/ }));
    await screen.findAllByLabelText("Field name");

    expect(screen.getByText(/read-only token/i)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: /^Save$/ });
    expect(save).toBeDisabled();
  });
});

describe("validateRowsClientSide", () => {
  it("flags duplicate field names", () => {
    const errs = validateRowsClientSide([
      { key: "a", name: "x", spec: { type: "string" } },
      { key: "b", name: "x", spec: { type: "string" } },
    ]);
    expect(errs.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  it("flags an indexed field with a kebab-case (invalid SQL identifier) name", () => {
    const errs = validateRowsClientSide([
      { key: "a", name: "bad-name", spec: { type: "string", indexed: true } },
    ]);
    expect(errs.some((e) => /can't be indexed/i.test(e))).toBe(true);
  });

  it("flags an indexed field with a non-indexable type", () => {
    const errs = validateRowsClientSide([
      { key: "a", name: "blob", spec: { type: "object", indexed: true } },
    ]);
    expect(errs.some((e) => /can't be indexed/i.test(e))).toBe(true);
  });

  it("passes a clean set", () => {
    const errs = validateRowsClientSide([
      { key: "a", name: "status", spec: { type: "string", indexed: true } },
      { key: "b", name: "due", spec: { type: "string" } },
    ]);
    expect(errs).toEqual([]);
  });
});
