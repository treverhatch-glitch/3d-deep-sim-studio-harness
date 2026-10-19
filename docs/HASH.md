# Hashing

The example sim uses a 64-bit FNV-style hash (two 32-bit lanes). New games should do the same from the first golden file.

Do not silently change the hash width after golden or regression files exist. If you change it, regenerate those files in the same commit.
