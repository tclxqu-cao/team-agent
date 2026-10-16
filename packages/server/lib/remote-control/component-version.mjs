export const componentVersionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/;

export function compareComponentVersions(left, right) {
  const parts = (version) => {
    const match = componentVersionPattern.exec(version);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])] : [-1];
  };
  const a = parts(left), b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? 1 : -1;
  }
  return 0;
}
