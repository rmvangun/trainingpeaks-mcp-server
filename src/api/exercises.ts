import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { strengthApi } from "../api.js";

// ─── Strength exercise catalog (api.peakswaresb.com/rx/activity) ─────────────
//
// The Strength Builder front end loads its whole catalog in one call —
// GET /rx/activity/v1/libraryContent returns { exercises, blocks, muscleGroups }
// — and filters client side. There is no server-side search endpoint, so this
// mirrors that: fetch once, cache, filter here.
//
// Note the id field is `exerciseId`, not `id`, and it is the numeric string
// that create_strength_workout wants.

export interface CatalogExercise {
  exerciseId: string;
  title: string;
  canEdit: boolean;
  isGarminSupported: boolean;
  ownerId: number | null;
  searchText: string;
  searchAttributes: {
    alternateTitles: string[];
    primaryMuscleGroups: string[];
    secondaryMuscleGroups: string[];
  };
}

export interface CatalogParameter {
  parameter: string;
  title: string;
  category: string;
  unit: { title: string; abbreviation: string; unit: string };
  range: unknown;
}

export interface LibraryContent {
  exercises: CatalogExercise[];
  blocks: { blockType: string }[];
  muscleGroups: { title?: string; name?: string }[];
}

const CACHE_TTL_MS = 30 * 60 * 1000;
let cache: { at: number; content: LibraryContent } | null = null;

export function clearCatalogCache(): void {
  cache = null;
}

export async function getLibraryContent(): Promise<LibraryContent> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.content;
  }
  const resp = await strengthApi<{ data: LibraryContent; errors?: Record<string, unknown> }>({
    method: "get",
    path: "/rx/activity/v1/libraryContent",
  });
  const content = resp.data ?? (resp as unknown as LibraryContent);
  cache = { at: Date.now(), content };
  return content;
}

export async function getExerciseParameters(): Promise<CatalogParameter[]> {
  const resp = await strengthApi<{ data: CatalogParameter[] }>({
    method: "get",
    path: "/rx/activity/v1/parameters/exercise",
  });
  return resp.data ?? (resp as unknown as CatalogParameter[]);
}

function muscleGroupName(g: { title?: string; name?: string }): string {
  return g.title ?? g.name ?? String(g);
}

/**
 * Ranked so an exact title beats a prefix, which beats a substring, which
 * beats a hit only in searchText (muscle-group words live there, so a bare
 * "chest" would otherwise outrank "Chest Fly").
 */
function score(ex: CatalogExercise, terms: string[]): number {
  const title = ex.title.toLowerCase();
  const alts = (ex.searchAttributes?.alternateTitles ?? []).map((a) => a.toLowerCase());
  const haystack = (ex.searchText ?? ex.title).toLowerCase();
  const joined = terms.join(" ");

  if (!terms.every((t) => haystack.includes(t) || title.includes(t) || alts.some((a) => a.includes(t)))) {
    return 0;
  }
  if (title === joined) return 100;
  if (alts.includes(joined)) return 90;
  if (title.startsWith(joined)) return 80;
  if (title.includes(joined)) return 70;
  if (terms.every((t) => title.includes(t))) return 60;
  if (terms.every((t) => alts.some((a) => a.includes(t)))) return 50;
  return 10;
}

export async function searchExercises(opts: {
  query?: string;
  muscleGroup?: string;
  customOnly?: boolean;
  limit: number;
}): Promise<CatalogExercise[]> {
  const { exercises } = await getLibraryContent();
  const terms = (opts.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const mg = opts.muscleGroup?.toLowerCase();

  let pool = exercises;
  if (opts.customOnly) {
    pool = pool.filter((e) => e.ownerId !== null || e.canEdit);
  }
  if (mg) {
    pool = pool.filter((e) => {
      const groups = [
        ...(e.searchAttributes?.primaryMuscleGroups ?? []),
        ...(e.searchAttributes?.secondaryMuscleGroups ?? []),
      ].map((g) => g.toLowerCase());
      return groups.includes(mg);
    });
  }

  if (terms.length === 0) {
    return pool.slice(0, opts.limit);
  }

  return pool
    .map((e) => ({ e, s: score(e, terms) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.e.title.localeCompare(b.e.title))
    .slice(0, opts.limit)
    .map((r) => r.e);
}

function formatExercise(e: CatalogExercise): string {
  const primary = e.searchAttributes?.primaryMuscleGroups ?? [];
  const secondary = e.searchAttributes?.secondaryMuscleGroups ?? [];
  const groups = [primary.join("/"), secondary.length ? `(${secondary.join("/")})` : ""]
    .filter(Boolean)
    .join(" ");
  const flags = [e.ownerId !== null ? "custom" : null].filter(Boolean).join(", ");
  return `  ${e.exerciseId.padEnd(6)} ${e.title}${groups ? ` — ${groups}` : ""}${flags ? ` [${flags}]` : ""}`;
}

// ─── Tool registration ───────────────────────────────────────────────────────

export function registerExerciseTools(mcp: McpServer): void {
  mcp.registerTool(
    "search_strength_exercises",
    {
      description:
        "Search the TrainingPeaks strength exercise catalog by name and/or muscle group. " +
        "Returns the numeric exerciseId that create_strength_workout requires. " +
        "Call this before create_strength_workout rather than guessing an ID.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Words to match against exercise titles, alternate titles and search text. " +
              'All words must appear. E.g. "kb swing", "goblet squat", "side plank". ' +
              "Omit to list by muscle group alone."
          ),
        muscle_group: z
          .string()
          .optional()
          .describe(
            "Restrict to a muscle group. One of: Abs, Biceps, Calves, Chest, Forearms, Glute, " +
              "Hamstrings, Lower Back, Quads, Shoulders, Triceps, Upper Back. Use list_muscle_groups to confirm."
          ),
        custom_only: z
          .boolean()
          .optional()
          .describe("Only exercises this account owns or can edit. Default false."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
      },
    },
    async ({ query, muscle_group, custom_only, limit }) => {
      const results = await searchExercises({
        query,
        muscleGroup: muscle_group,
        customOnly: custom_only,
        limit: limit ?? 20,
      });
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No exercises matched${query ? ` "${query}"` : ""}${muscle_group ? ` in ${muscle_group}` : ""}. Try fewer or different words — titles use abbreviations like "KB", "DB", "BB".`,
            },
          ],
        };
      }
      const lines = [
        `${results.length} match${results.length === 1 ? "" : "es"} (exerciseId, title, muscle groups):`,
        ...results.map(formatExercise),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  mcp.registerTool(
    "list_muscle_groups",
    {
      description:
        "List the muscle groups the strength exercise catalog uses, and the block types a strength workout can contain.",
      inputSchema: {},
    },
    async () => {
      const content = await getLibraryContent();
      const lines = [
        `Muscle groups (${content.muscleGroups.length}):`,
        ...content.muscleGroups.map((g) => `  ${muscleGroupName(g)}`),
        "",
        `Block types (${content.blocks.length}): ${content.blocks.map((b) => b.blockType).join(", ")}`,
        "",
        `Catalog size: ${content.exercises.length} exercises`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  mcp.registerTool(
    "list_strength_parameters",
    {
      description:
        "List the set parameters the strength API accepts (reps, weight, duration, distance, RPE and so on), " +
        "with their units. These are the keys to use in create_strength_workout's sets_data.",
      inputSchema: {},
    },
    async () => {
      const params = await getExerciseParameters();
      const lines = [
        `${params.length} parameters:`,
        ...params.map(
          (p) =>
            `  ${p.parameter.padEnd(22)} ${p.title}${p.unit?.abbreviation ? ` (${p.unit.abbreviation})` : ""} — category ${p.category}`
        ),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
