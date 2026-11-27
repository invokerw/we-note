// Generate outside the transaction, then let one read/write transaction select
// the shared key, including when two tabs enable this setting for the first time.
export async function deviceKey(create: boolean): Promise<CryptoKey> {
  if (!crypto.subtle)
    throw Error(
      "当前地址无法使用本机密钥存储，请通过 HTTPS 或 localhost 打开。",
    );
  const candidate = create
    ? await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ])
    : undefined;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("wenote-model-credentials", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction("keys", create ? "readwrite" : "readonly");
      const store = tx.objectStore("keys");
      const request = store.get("device");
      let key: CryptoKey | undefined;
      request.onsuccess = () => {
        key = request.result ?? candidate;
        if (!request.result && candidate) {
          try {
            store.add(candidate, "device");
          } catch {
            tx.abort();
          }
        }
      };
      tx.oncomplete = () =>
        key
          ? resolve(key)
          : reject(Error("本机密钥不可用，请重新填写 API Key。"));
      tx.onabort = () => reject(tx.error ?? Error("无法使用本机密钥存储。"));
    });
  } finally {
    db.close();
  }
}
