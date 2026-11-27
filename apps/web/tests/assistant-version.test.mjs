import test from "node:test";
import assert from "node:assert/strict";
import { catalogVersion } from "../src/assistant/clientVersion.ts";
test("local day cache, concurrent startup, next day update, malformed or offline fallback", async () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (k) => values.get(k),
    setItem: (k, v) => values.set(k, v),
  };
  let calls = 0,
    version = "1.2.3";
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.credentials, "omit");
    if (!version) throw Error();
    return Response.json({ version });
  };
  const first = new Date(2026, 10, 27, 23, 59);
  assert.deepEqual(
    await Promise.all([catalogVersion(first), catalogVersion(first)]),
    ["1.2.3", "1.2.3"],
  );
  assert.equal(await catalogVersion(first), "1.2.3");
  assert.equal(calls, 1);
  version = "1.2.4";
  assert.equal(await catalogVersion(new Date(2026, 10, 28)), "1.2.4");
  assert.equal(calls, 2);
  version = "bad";
  assert.equal(await catalogVersion(new Date(2026, 10, 29)), "1.2.4");
  version = "";
  assert.equal(await catalogVersion(new Date(2026, 10, 30)), "1.2.4");
});
