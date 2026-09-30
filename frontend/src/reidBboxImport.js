const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff'])
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, 'mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv'])
export const CAMERA_BURN_IN_OFFSET_MS = 1000

const extension = (name) => String(name || '').split('.').pop().toLocaleLowerCase()
const normalizedPath = (value) => String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').toLocaleLowerCase()
const pathParts = (file) => normalizedPath(file.webkitRelativePath || file.name).split('/').filter(Boolean)
const baseName = (value) => normalizedPath(value).split('/').pop()
const stem = (value) => baseName(value).replace(/\.[^.]+$/, '')

export const mediaFilesFromSelection = (files) => Array.from(files || []).filter((file) => MEDIA_EXTENSIONS.has(extension(file.name)))

export const discoverImageBboxSets = (files) => {
  const selected = Array.from(files || [])
  const images = selected.filter((file) => IMAGE_EXTENSIONS.has(extension(file.name)))
  const bboxFiles = selected.filter((file) => /_bbox\.jsonl$/i.test(file.name))
  return bboxFiles.flatMap((bboxFile) => {
    const datasetName = bboxFile.name.replace(/_bbox\.jsonl$/i, '')
    const bboxParts = pathParts(bboxFile)
    const directoryParts = bboxParts.slice(0, -1)
    const containingFolder = directoryParts.at(-1)
    const normalizedDatasetName = datasetName.toLocaleLowerCase()
    const imageDirectoryParts = containingFolder === normalizedDatasetName
      ? directoryParts
      : [...directoryParts, normalizedDatasetName]
    let datasetImages = images.filter((file) => {
      const imageParts = pathParts(file)
      return imageDirectoryParts.every((part, index) => imageParts[index] === part)
    })
    if (!directoryParts.length && bboxFiles.length === 1) datasetImages = images
    return datasetImages.length ? [{ bboxFile, datasetName, imageFiles: datasetImages }] : []
  })
}

export const parseImageBboxRows = async (file) => (await file.text()).split(/\r?\n/).flatMap((line, index) => {
  if (!line.trim()) return []
  let row
  try { row = JSON.parse(line) } catch { throw new Error(`${file.name} 第 ${index + 1} 行格式錯誤`) }
  if (Array.isArray(row.detections)) return [{ ...row, detections: row.detections }]
  if (Array.isArray(row.bbox_xywh)) return [{ ...row, detections: [row] }]
  return []
})

export const discoverAisFiles = (files) => Array.from(files || []).filter((file) => /_ais\.jsonl$/i.test(file.name))

export const parseAisRows = async (file) => (await file.text()).split(/\r?\n/).flatMap((line, index) => {
  if (!line.trim()) return []
  let row
  try { row = JSON.parse(line) } catch { throw new Error(`${file.name} 第 ${index + 1} 行格式錯誤`) }
  const pixel = row.pixel_xy
  const timestamp = Date.parse(row.ais_recorded_harbor_ts)
  if (row.mmsi === undefined || row.mmsi === null || !Array.isArray(pixel) || pixel.length !== 2 || !Number.isFinite(timestamp)) return []
  const x = Number(pixel[0]), y = Number(pixel[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return []
  return [{ mmsi: String(row.mmsi), x, y, timestamp, recordedAt: row.ais_recorded_harbor_ts, shipName: row.ship_name || '' }]
})

export const fileDirectory = (file) => pathParts(file).slice(0, -1).join('/')

export const datasetStartTime = (datasetName) => {
  const match = String(datasetName || '').match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_\d+)?$/)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const timestamp = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`)
  return Number.isFinite(timestamp) ? timestamp : null
}

export const datasetFrameTime = (datasetName, videoPtsSeconds) => {
  const start = datasetStartTime(datasetName)
  const offset = Number(videoPtsSeconds)
  return start !== null && Number.isFinite(offset) ? start + offset * 1000 + CAMERA_BURN_IN_OFFSET_MS : null
}

const rowImagePath = (row) => {
  for (const key of ['file_name', 'filename', 'image_name', 'image_path', 'image_file', 'source_image']) {
    if (typeof row[key] === 'string' && row[key].trim()) return row[key]
  }
  if (typeof row.image === 'string') return row.image
  return typeof row.image?.file_name === 'string' ? row.image.file_name : ''
}

const trailingNumber = (value) => {
  const match = stem(value).match(/(\d+)(?:\D*)$/)
  return match ? Number(match[1]) : null
}

export const matchBboxRowsToRecords = (rows, records) => {
  const unusedRows = new Set(rows.map((_, index) => index))
  return records.flatMap((record) => {
    const recordPaths = [record.relativePath, record.originalFilename, record.filename].filter(Boolean).map(normalizedPath)
    const recordBaseNames = recordPaths.map(baseName)
    let rowIndexes = rows.flatMap((row, index) => {
      if (!unusedRows.has(index)) return []
      const source = normalizedPath(rowImagePath(row))
      return source && (recordPaths.includes(source) || recordBaseNames.includes(baseName(source))) ? [index] : []
    })
    if (!rowIndexes.length) {
      const recordNumber = trailingNumber(record.originalFilename || record.filename)
      if (recordNumber !== null) rowIndexes = rows.flatMap((row, index) => unusedRows.has(index) && Number.isInteger(row.frame_index) && row.frame_index === recordNumber ? [index] : [])
    }
    if (!rowIndexes.length) return []
    rowIndexes.forEach((index) => unusedRows.delete(index))
    return [{ record, row: { ...rows[rowIndexes[0]], detections: rowIndexes.flatMap((index) => rows[index].detections) } }]
  })
}

export const selectionPath = (file) => normalizedPath(file.webkitRelativePath || file.name)
