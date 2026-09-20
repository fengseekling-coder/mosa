export function topKNormalizedEmbeddings(matrix, dimension, query, k = 20) {
  if (!(matrix instanceof Float32Array)) throw new TypeError("matrix must be a Float32Array");
  if (!(query instanceof Float32Array)) throw new TypeError("query must be a Float32Array");
  const dim = Number(dimension);
  const limit = Number(k);
  if (!Number.isInteger(dim) || dim <= 0) throw new RangeError("dimension must be a positive integer");
  if (query.length !== dim) throw new RangeError("query length must equal dimension");
  if (matrix.length % dim !== 0) throw new RangeError("matrix length must be divisible by dimension");
  if (!Number.isInteger(limit) || limit <= 0) throw new RangeError("k must be a positive integer");

  const count = matrix.length / dim;
  const size = Math.min(limit, count);
  const indices = new Int32Array(size);
  const scores = new Float64Array(size);
  indices.fill(-1);
  scores.fill(Number.NEGATIVE_INFINITY);

  for (let row = 0; row < count; row += 1) {
    let score = 0;
    const offset = row * dim;
    for (let col = 0; col < dim; col += 1) score += matrix[offset + col] * query[col];
    if (score <= scores[size - 1]) continue;

    let target = size - 1;
    while (target > 0 && score > scores[target - 1]) {
      scores[target] = scores[target - 1];
      indices[target] = indices[target - 1];
      target -= 1;
    }
    scores[target] = score;
    indices[target] = row;
  }

  return Array.from({ length: size }, (_, index) => ({
    index: indices[index],
    score: scores[index],
  }));
}

export function normalizeEmbedding(vector) {
  if (!(vector instanceof Float32Array)) throw new TypeError("vector must be a Float32Array");
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (!(norm > 0)) return vector;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}
