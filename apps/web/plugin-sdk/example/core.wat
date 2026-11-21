(module
  (import "env" "memory" (memory 512 512))
  ;; The on-disk representation is WN1 followed by LF and the UTF-8 document.
  (func (export "open") (param $ptr i32) (param $len i32) (result i64)
    (if (i32.lt_u (local.get $len) (i32.const 4)) (then unreachable))
    (if (i32.ne (i32.load (local.get $ptr)) (i32.const 0x0a314e57)) (then unreachable))
    (i64.or (i64.shl (i64.extend_i32_u (i32.add (local.get $ptr) (i32.const 4))) (i64.const 32))
            (i64.extend_i32_u (i32.sub (local.get $len) (i32.const 4)))))
  (func (export "serialize") (param $ptr i32) (param $len i32) (result i64)
    (memory.copy (i32.add (local.get $ptr) (i32.const 4)) (local.get $ptr) (local.get $len))
    (i32.store (local.get $ptr) (i32.const 0x0a314e57))
    (i64.extend_i32_u (i32.add (local.get $len) (i32.const 4)))))
