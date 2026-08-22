/** Axis-aligned box geometry helpers shared by the fixture tools. */

/* --------------------------------- geometry --------------------------------- */
// Axis-aligned box -> 24 verts (4 per face, flat normals) + 36 indices.
export function box(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const faces = [
    { n: [0, 0, 1],  v: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] }, // +z
    { n: [0, 0, -1], v: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] }, // -z
    { n: [1, 0, 0],  v: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] }, // +x
    { n: [-1, 0, 0], v: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] }, // -x
    { n: [0, 1, 0],  v: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] }, // +y
    { n: [0, -1, 0], v: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] }, // -y
  ];
  const positions = [], normals = [], indices = [];
  faces.forEach((f, fi) => {
    f.v.forEach((v) => { positions.push(...v); normals.push(...f.n); });
    const b = fi * 4;
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { positions, normals, indices };
}

export function mergeParts(parts) {
  const positions = [], normals = [], indices = [];
  for (const p of parts) {
    const off = positions.length / 3;
    positions.push(...p.positions);
    normals.push(...p.normals);
    for (const i of p.indices) indices.push(i + off);
  }
  return { positions, normals, indices };
}

