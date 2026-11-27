import { deviceKey } from "../../web/src/deviceKey";

// Only the active account retains a refresh credential. Bind ciphertext to its
// owner so restoring a different account's settings cannot reuse the token.
export async function encryptRefresh(owner, refresh) {
  const key = await deviceKey(true);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(owner) },
    key,
    new TextEncoder().encode(refresh),
  );
  return { iv: [...iv], data: [...new Uint8Array(data)] };
}
export async function decryptRefresh(owner, saved) {
  const key = await deviceKey(false);
  const data = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(saved.iv),
      additionalData: new TextEncoder().encode(owner),
    },
    key,
    Uint8Array.from(saved.data),
  );
  return new TextDecoder().decode(data);
}
