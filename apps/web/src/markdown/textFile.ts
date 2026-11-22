export function changedRange(old: string, next: string) {
  let start = 0,
    oldEnd = old.length,
    newEnd = next.length;
  while (start < oldEnd && start < newEnd && old[start] === next[start])
    start++;
  while (
    oldEnd > start &&
    newEnd > start &&
    old[oldEnd - 1] === next[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  return { start, oldEnd, newEnd };
}

/** Keep the source bytes' BOM and line endings while the editor works with LF. */
export class TextFile {
  private bom: string;
  private endings: string[];
  readonly newline: string;
  text: string;

  constructor(raw: string) {
    this.bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = raw.slice(this.bom.length);
    this.endings = body.match(/\r\n|\n|\r/g) || [];
    this.newline = this.endings[0] || "\n";
    this.text = body.replace(/\r\n|\r/g, "\n");
  }

  edit(next: string) {
    const old = this.text;
    if (old === next) return;
    const { start, oldEnd, newEnd } = changedRange(old, next);
    const count = (s: string) => s.split("\n").length - 1;
    const removed = count(old.slice(start, oldEnd)),
      added = count(next.slice(start, newEnd));
    if (removed !== added) {
      const first = count(old.slice(0, start));
      const replacement = this.endings.slice(
        first,
        first + Math.min(removed, added),
      );
      const ending =
        this.endings[first] || this.endings[first - 1] || this.newline;
      while (replacement.length < added) replacement.push(ending);
      this.endings = this.endings
        .slice(0, first)
        .concat(replacement, this.endings.slice(first + removed));
    }
    this.text = next;
  }
  serialize() {
    let line = 0;
    return (
      this.bom +
      this.text.replace(/\n/g, () => this.endings[line++] || this.newline)
    );
  }
}
