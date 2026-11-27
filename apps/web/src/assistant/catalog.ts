import type { Config } from "./policy";
export type ModelOption = {
  id: string;
  label: string;
  levels: string[];
  defaultLevel?: string;
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
export function baseModels(payload: unknown): ModelOption[] {
  const { data } = object(payload);
  if (!Array.isArray(data)) throw Error("此服务未提供兼容的模型列表");
  const seen = new Map<string, ModelOption>();
  for (const row of data) {
    const { id, display_name } = object(row);
    if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
    seen.set(id, {
      id,
      label:
        typeof display_name === "string" && display_name ? display_name : id,
      levels: [],
    });
  }
  return [...seen.values()];
}
export function withEfforts(
  base: ModelOption[],
  payload: unknown,
): ModelOption[] {
  const { models } = object(payload);
  if (!Array.isArray(models)) return base;
  const bySlug = new Map(
    models.map((value) => {
      const row = object(value);
      return [row.slug, row];
    }),
  );
  return base.map((model) => {
    const row = bySlug.get(model.id);
    if (!Array.isArray(row?.supported_reasoning_levels)) return model;
    const levels = [
      ...new Set(
        row.supported_reasoning_levels
          .map((v) => object(v).effort)
          .filter((v): v is string => typeof v === "string" && !!v.trim()),
      ),
    ];
    const def = row.default_reasoning_level;
    return {
      ...model,
      levels,
      defaultLevel:
        typeof def === "string" && levels.includes(def) ? def : undefined,
    };
  });
}
export function reasoningPayload(
  payload: unknown,
  api: Config["api"],
  effort?: string,
) {
  if (!effort) return payload;
  const body = object(payload);
  return api === "openai-responses"
    ? { ...body, reasoning: { ...object(body.reasoning), effort } }
    : { ...body, reasoning_effort: effort };
}
