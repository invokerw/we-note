import assert from "node:assert/strict";
import test from "node:test";
import { readAppearance, resolveScheme } from "../src/appearance.ts";

const defaults = { mode: "system", lightStart: "07:00", darkStart: "19:00" };
test("new devices follow the system and legacy explicit settings survive", () => {
  assert.deepEqual(readAppearance(null, null), defaults);
  for (const mode of ["light", "dark"])
    assert.deepEqual(readAppearance(null, mode), { ...defaults, mode });
  const stored = { mode: "schedule", lightStart: "20:00", darkStart: "06:00" };
  assert.deepEqual(readAppearance(JSON.stringify(stored), "dark"), stored);
  for (const invalid of ["{", "null", '{"mode":"unknown"}'])
    assert.deepEqual(readAppearance(invalid, null), defaults);
  for (const time of ["24:00", "", "19:00"]) {
    assert.deepEqual(
      readAppearance(
        JSON.stringify({ ...defaults, mode: "schedule", lightStart: time }),
        null,
      ),
      { ...defaults, mode: "schedule" },
    );
  }
});
test("schedule includes each start minute and wraps across midnight", () => {
  const at = (clock) => new Date(`2026-11-25T${clock}:00`);
  for (const [lightStart, darkStart] of [
    ["07:00", "19:00"],
    ["19:00", "07:00"],
  ]) {
    const p = { mode: "schedule", lightStart, darkStart };
    for (const [clock, expected] of [
      ["00:00", "dark"],
      ["06:59", "dark"],
      ["07:00", "light"],
      ["18:59", "light"],
      ["19:00", "dark"],
      ["23:59", "dark"],
    ]) {
      const reversed = lightStart > darkStart;
      assert.equal(
        resolveScheme(p, false, at(clock)),
        reversed ? (expected === "dark" ? "light" : "dark") : expected,
      );
    }
  }
  for (const systemDark of [true, false]) {
    assert.equal(
      resolveScheme(defaults, systemDark, at("12:00")),
      systemDark ? "dark" : "light",
    );
    for (const mode of ["light", "dark"])
      assert.equal(
        resolveScheme({ ...defaults, mode }, systemDark, at("12:00")),
        mode,
      );
  }
});
