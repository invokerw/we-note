const cacheKey = "wenote-codex-catalog-version";
const fallback = "0.157.1";
const stable = /^\d+\.\d+\.\d+$/;
type RecordVersion = { day: string; version: string };
let pending: Promise<string> | undefined;
let memory: RecordVersion | undefined;

async function check(day: string) {
  let cached = memory;
  try {
    cached = JSON.parse(localStorage.getItem(cacheKey) || "null") ?? cached;
  } catch {
    /* storage unavailable */
  }
  let version =
    cached && stable.test(cached.version) ? cached.version : fallback;
  if (cached?.day === day) return version;
  try {
    const response = await fetch(
      "https://registry.npmjs.org/@openai%2fcodex/latest",
      {
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-cache",
        signal: AbortSignal.timeout(4000),
      },
    );
    if (response.ok) {
      const release = await response.json();
      if (typeof release.version === "string" && stable.test(release.version))
        version = release.version;
    }
  } catch {
    /* keep the last known stable release when offline */
  }
  memory = { day, version };
  try {
    localStorage.setItem(cacheKey, JSON.stringify(memory));
  } catch {
    /* use session cache */
  }
  return version;
}
export function catalogVersion(now = new Date()): Promise<string> {
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].join("-");
  const update = () => check(day);
  async function oncePerOrigin(): Promise<string> {
    if (!globalThis.navigator?.locks) return update();
    try {
      return await navigator.locks.request(cacheKey, update);
    } catch {
      return update();
    }
  }
  return (pending ??= oncePerOrigin().finally(() => {
    pending = undefined;
  }));
}
