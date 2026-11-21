// The only guest import is bounded linear memory. No host functions or WASI.
self.onmessage = async ({ data }) => {
  try {
    const code = new Uint8Array(data.code);
    for (let i = 8; i < code.length;) {
      const section = code[i++];
      let size = 0,
        byte = 0,
        shift = 0;
      do {
        if (i >= code.length || shift > 28) throw Error("无效 WASM 段");
        byte = code[i++];
        size += (byte & 127) * 2 ** shift;
        shift += 7;
      } while (byte & 128);
      if ([4, 5, 8, 13].includes(section))
        throw Error("不支持私有表、内存、启动函数或异常标签");
      i += size;
    }
    const mod = await WebAssembly.compile(code);
    const imports = WebAssembly.Module.imports(mod);
    if (
      imports.length !== 1 ||
      imports[0].kind !== "memory" ||
      imports[0].module !== "env" ||
      imports[0].name !== "memory"
    )
      throw Error("插件只可导入 env.memory");
    const memory = new WebAssembly.Memory({ initial: 512, maximum: 512 });
    const guest = await WebAssembly.instantiate(mod, { env: { memory } });
    for (const op of data.required)
      if (typeof guest.exports[op] !== "function")
        throw Error(`缺少 ${op} 接口`);
    if (data.op === "check") {
      self.postMessage({});
      return;
    }
    const buf = new Uint8Array(memory.buffer);
    buf.set(data.input, 0);
    const result = (guest.exports[data.op] as CallableFunction)(
      0,
      data.input.length,
    );
    if (typeof result !== "bigint") throw Error("插件返回值应为 i64");
    const offset = Number(BigInt.asUintN(64, result) >> 32n),
      length = Number(result & 0xffffffffn);
    if (length > 16 << 20 || offset + length > buf.length)
      throw Error("插件输出超出范围");
    const output = buf.slice(offset, offset + length);
    self.postMessage({ output }, { transfer: [output.buffer] });
  } catch (e) {
    self.postMessage({ error: String(e) });
  }
};
