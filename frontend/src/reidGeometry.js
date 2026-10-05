export const fitBoxWithinBounds = (points, width, height) => {
  if (!Array.isArray(points) || points.length !== 2 || !(width > 0) || !(height > 0)) return points
  const [a, b] = points
  if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite)) return points

  const boxWidth = Math.min(Math.abs(b.x - a.x), width)
  const boxHeight = Math.min(Math.abs(b.y - a.y), height)
  const left = Math.max(0, Math.min(width - boxWidth, Math.min(a.x, b.x)))
  const top = Math.max(0, Math.min(height - boxHeight, Math.min(a.y, b.y)))
  const right = left + boxWidth
  const bottom = top + boxHeight

  return [
    { ...a, x: a.x <= b.x ? left : right, y: a.y <= b.y ? top : bottom },
    { ...b, x: a.x <= b.x ? right : left, y: a.y <= b.y ? bottom : top },
  ]
}
