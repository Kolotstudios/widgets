# Models

## fcpe.onnx — singing pitch tracker for the karaoke studio

- FCPE (Fast Context-based Pitch Estimation) by CNChTu, `torchfcpe` 0.0.4, bundled model `fcpe_c_v001` — MIT License.
- ONNX export with the front end inside the graph: [Scicom-intl/fcpe-onnx](https://huggingface.co/Scicom-intl/fcpe-onnx) — MIT License.
- Input: 16 kHz mono float32 `[1, N]`. Output: salience `[1, T, 360]`, frame i at i·10 ms + 5 ms, bins evenly spaced in cents from 32.7 to 1975.5 Hz.
- Used by `ks-dsp.js` (`nf0`) through onnxruntime-web; the YIN tracker is the fallback.
