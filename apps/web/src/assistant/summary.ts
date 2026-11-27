function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

// A gateway may stream deltas, send only completed summary parts, or do both.
// Keep a separate collector per provider request. Pi's generic thinking blocks can include private data.
export function publicSummary() {
  const items = new Map<string, string[]>();
  return (value: unknown): string | undefined => {
    const event = record(value),
      item = record(event.item);
    const key = String(event.item_id ?? item.id ?? event.output_index ?? 0);
    let changed = false;
    function setPart(index: unknown, text: unknown, append = false) {
      if (
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index > 4096 ||
        typeof text !== "string" ||
        !text
      )
        return;
      const parts = items.get(key) ?? [];
      const next = append ? (parts[index] ?? "") + text : text;
      if (next === parts[index]) return;
      parts[index] = next;
      items.set(key, parts);
      changed = true;
    }
    const index = event.summary_index ?? 0;
    switch (event.type) {
      case "response.reasoning_summary_text.delta":
        setPart(index, event.delta, true);
        break;
      case "response.reasoning_summary_text.done":
        setPart(index, event.text);
        break;
      case "response.reasoning_summary_part.done": {
        const part = record(event.part);
        if (part.type === "summary_text") setPart(index, part.text);
        break;
      }
      case "response.output_item.done":
        if (item.type === "reasoning" && Array.isArray(item.summary))
          item.summary.forEach((value, index) => {
            const part = record(value);
            if (part.type === "summary_text") setPart(index, part.text);
          });
    }
    if (changed) return Array.from(items.values()).flat().join("\n\n");
  };
}
