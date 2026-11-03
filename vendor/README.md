# vendor

`rnnoise.js` + `rnnoise.wasm` — RNNoise (Xiph, BSD-3-Clause) compiled to WebAssembly by
[jitsi/rnnoise-wasm](https://github.com/jitsi/rnnoise-wasm) (Apache-2.0), commit cb529a5.
The only change: the trailing `export default` line was removed so it loads with `importScripts` in a worker.
