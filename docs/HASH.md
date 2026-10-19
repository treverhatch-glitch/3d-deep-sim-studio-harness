# Hashing

The example sim uses a 32-bit FNV-1a hash. That is enough for the harness fixtures.

For a real game, prefer a 64-bit hash (two FNV lanes or a library) before you store golden files you cannot afford to collide.

Current harness choice: stay on 32-bit so existing golden files stay valid. Do not silently change the hash width.
