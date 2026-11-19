export const comparisonLimits = Object.freeze({ rows: 16, columns: 8 });

const imageTypes = new Map(Object.entries({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp',
}));
export const evidenceImageExtensions = Object.freeze([...imageTypes.keys()]);

export function evidenceImageMime(file) {
  const name = file.split(/[\\/]/).at(-1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? imageTypes.get(name.slice(dot).toLowerCase()) : undefined;
}

export function comparisonImages(comparison) {
  return [...new Set(comparison?.rows.flatMap(row => row.images).filter(image => image !== null))];
}
