# Visual Retrieval Model Evaluation

Status: evaluation gate, not a shipping-model commitment.

MOSA's current text search already covers explicit keywords, supported Chinese conversational phrasing, and a small audited design vocabulary. The remaining retrieval gap is pixel-grounded intent: composition, subject position, color placement, and other facts that are not present in Prompt or metadata.

## Product constraints

Any model considered for MOSA visual retrieval must satisfy all of these constraints before product integration:

- Local inference after installation of an optional model pack. User assets must not be uploaded for retrieval.
- Model weights and runtime must be legally usable for product development and potential commercial distribution. A strong benchmark score cannot override a restrictive model license.
- The base MOSA desktop package must not silently grow by hundreds of megabytes. Model packs should remain optional and live outside the user's asset library so normal library backup/restore does not duplicate model weights.
- Image embeddings are computed in the background. The renderer must not own a long-running inference loop.
- Query and indexing results must use the same pinned model/version and preprocessing configuration. A model update requires an embedding-version migration rather than mixing vector spaces.
- Missing or stale image embeddings must degrade to existing lexical search instead of hiding assets.

## Current candidate screen

The following screen was checked on 2026-09-18. Re-check upstream licenses and files before any model download or redistribution.

| Candidate | Current status | Why |
| --- | --- | --- |
| Google SigLIP2 Base | **Benchmark candidate** | The published model repos identify Apache-2.0 and SigLIP2 is explicitly multilingual and intended for image-text retrieval. Full-precision Base weights are roughly 1.5 GB, while community ONNX conversions include smaller quantized variants; actual MOSA accuracy and Apple Silicon latency still need measurement. |
| Apple MobileCLIP2 | **Excluded from product evaluation** | The model-weight license is limited to research purposes and explicitly excludes product development and commercial products/services. Its efficiency does not override that restriction. |
| Jina CLIP v2 | **Excluded from bundled/local product use without separate license** | The downloadable model is CC BY-NC 4.0; the model card directs commercial users to separate commercial channels. |
| BAAI AltCLIP | **Deferred on footprint** | The model card permits commercial redistribution under CreativeML OpenRAIL-M conditions, but the current checkpoint is multi-gigabyte and does not fit the first model-pack budget without a verified smaller conversion. |

Primary upstream references:

- SigLIP2 model: https://huggingface.co/google/siglip2-base-patch16-224
- SigLIP2 ONNX conversion: https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX
- MobileCLIP2 model license: https://github.com/apple-aiml-research/ml-mobileclip/blob/main/LICENSE_MODELS
- Jina CLIP v2 model card/license: https://huggingface.co/jinaai/jina-clip-v2
- AltCLIP model card/license: https://huggingface.co/BAAI/AltCLIP

## Candidate report contract

Model experiments must emit a JSON report using schema `mosa.visual-retrieval-candidate/1`:

```json
{
  "schema": "mosa.visual-retrieval-candidate/1",
  "candidate": {
    "id": "siglip2-base-example",
    "model_id": "upstream/model-id",
    "license_id": "apache-2.0",
    "license_source": "https://example.invalid/license",
    "commercial_product_use": true,
    "model_pack_bytes": 400000000,
    "runtime_bytes": 80000000
  },
  "environment": {
    "platform": "darwin",
    "arch": "arm64",
    "device": "Apple Silicon model"
  },
  "measurements": {
    "cold_start_ms": 2200,
    "warm_query_ms": [120, 125, 130],
    "image_index_ms": [130, 140, 145],
    "vector_search_ms": [35, 40, 42],
    "peak_rss_mb": 900
  },
  "queries": [
    {
      "id": "visual-right-side-person",
      "ranked_asset_ids": ["asset-a", "asset-b"]
    }
  ]
}
```

Run:

```bash
npm run qa:visual-retrieval-candidate -- --input /absolute/path/to/candidate-report.json
```

The evaluator joins candidate results to `test/fixtures/retrieval-acceptance.json`; a candidate cannot choose easier query IDs.

## Provisional gate

The current hard gate is deliberately conservative:

- commercial/product-use license confirmed;
- model pack <= 512 MiB;
- added runtime <= 256 MiB;
- peak RSS <= 1536 MiB;
- cold start <= 8 s;
- warm text-query P95 <= 250 ms;
- image-index P95 <= 250 ms/image;
- exact vector Top-K P95 <= 60 ms at the target library scale;
- synthetic visual Hit@1 >= 75%;
- synthetic visual Hit@5 = 100%.

Passing this gate only earns a candidate the next stage. The current visual fixture is intentionally small and synthetic; it is not enough evidence to ship a model. Before release, expand it with a private, opt-in evaluation corpus outside the repository and report aggregate metrics only. Never commit user assets or derived embeddings.

## Vector-search baseline

The first implementation should prefer exact search until scale proves otherwise. Run:

```bash
npm run benchmark:vector-search
```

The benchmark uses 50,000 normalized 512-dimensional vectors by default. It measures only Top-K vector scanning, not model encoding. If exact search remains within the interaction budget, MOSA avoids an ANN index, another native dependency, and index-rebuild complexity in the first release.

Environment overrides:

```bash
MOSA_VECTOR_BENCH_ASSETS=100000 MOSA_VECTOR_BENCH_DIMENSION=768 npm run benchmark:vector-search
```

## Integration sequence after a candidate passes

1. Pin the model, tokenizer/preprocessor, conversion revision, checksums, and license notice in a model-pack manifest.
2. Keep model weights in desktop `userData`, not in `MOSA Library`.
3. Add a background embedding worker and versioned SQLite embedding metadata.
4. Backfill image embeddings incrementally with pause/resume and thermal/battery awareness.
5. Encode only the query at search time, then exact-scan normalized vectors.
6. Merge visual results with the existing lexical result set without replacing explicit keyword matches.
7. Add user controls to remove the optional model pack and derived embeddings without touching original assets or provenance.

Do not implement automatic model downloads until licensing, checksum verification, disk-space handling, and explicit user consent are part of the same change.
