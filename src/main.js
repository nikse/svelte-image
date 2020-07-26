const svelte = require('svelte/compiler')
const sharp = require('sharp')
const path = require('path')
const util = require('util')
const fs = require('fs')
const crypto = require('crypto')
const axios = require('axios')

let options = {
  optimizeAll: true, // optimize all images discovered in img tags

  // Case insensitive. Only files whose extension exist in this array will be
  // processed by the <img> tag (assuming `optimizeAll` above is true). Empty
  // the array to allow all extensions to be processed. However, only jpegs and
  // pngs are explicitly supported.
  imgTagExtensions: ['jpg', 'jpeg', 'png'],

  // Same as the above, except that this array applies to the Image Component.
  // If the images passed to your image component are unknown, it might be a
  // good idea to populate this array.
  componentExtensions: [],

  inlineBelow: 10000, // inline all images in img tags below 10kb

  compressionLevel: 8, // png quality level

  quality: 70, // jpeg/webp quality level

  tagName: 'Image', // default component name

  sizes: [400, 800, 1200], // array of sizes for srcset in pixels

  // array of screen size breakpoints at which sizes above will be applied.
  // first size does not use breakpoint
  breakpoints: [375, 768, 1024],

  outputDir: 'g/',

  publicDir: './static/',

  placeholder: 'trace', // or "blur", or false

  // WebP options [sharp docs](https://sharp.pixelplumbing.com/en/stable/api-output/#webp)
  webpOptions: {
    quality: 75,
    lossless: false,
    force: true
  },

  webp: true,

  // Potrace options for SVG placeholder
  trace: {
    background: '#fff',
    color: '#002fa7',
    threshold: 120
  },

  // Whether to download and optimize remote images loaded from a url
  optimizeRemote: true,

  // use ratio padding (true/false)
  ratio: true,

  // load retina sizes (true/false)
  retina: true
}

async function downloadImage(url, folder = '.') {
  const { headers } = await axios.head(url)
  const hash = crypto.createHash('sha1').update(url).digest('hex')
  const existing = fs.readdirSync(folder).find((e) => e.startsWith(hash))
  if (existing) {
    return existing
  }

  const [type, ext] = headers['content-type'].split('/')
  if (type !== 'image') return null

  const filename = `${hash}.${ext}`
  const saveTo = path.resolve(folder, filename)

  if (fs.existsSync(path)) return filename

  const writer = fs.createWriteStream(saveTo)
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream'
  })
  response.data.pipe(writer)

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(filename))
    writer.on('error', reject)
  })
}

function getPathsObject(nodeSrc) {
  const inPath = path.resolve(options.publicDir, nodeSrc)
  const outDir = path.dirname(
    path.resolve(options.publicDir, options.outputDir, nodeSrc)
  )
  const filename = path.basename(inPath)
  const outUrl = path.relative(options.publicDir, path.join(outDir, filename))

  return {
    inPath,
    outDir,
    outPath: path.join(outDir, filename),
    outUrl,
    getResizePaths: (size) => {
      const filenameWithSize = getFilenameWithSize(inPath, size)
      return {
        outPath: path.join(outDir, filenameWithSize),
        outUrl: path.join(path.dirname(outUrl), filenameWithSize),
        outPathWebp: path.join(outDir, getWebpFilenameWithSize(inPath, size))
      }
    }
  }
}

async function getBase64(pathname, inlined = false) {
  let size = 64

  if (inlined) {
    size = (await sharp(pathname).metadata()).size
  }

  const s = await sharp(pathname).resize(size).toBuffer()

  return 'data:image/png;base64,' + s.toString('base64')
}

const optimizeSVG = async (svg) => {
  const svgo = require(`svgo`)
  const res = new svgo({
    multipass: true,
    floatPrecision: 0,
    datauri: 'base64'
  })

  const { data } = await res.optimize(svg)
  return data
}

async function getTrace(pathname) {
  const potrace = require('potrace')
  const trace = util.promisify(potrace.trace)

  const s = await sharp(pathname)
    .resize(options.trace.size || 500)
    .toBuffer()

  const res = await trace(s, options.trace)

  return optimizeSVG(res)
}

function getProp(node, attr) {
  const prop = (node.attributes || []).find((a) => a.name === attr)
  return prop ? prop.value : undefined
}

function getPropData(node, attr) {
  const [value] = getProp(node, attr) || [{}]
  const { data, expression, type } = value || {}

  // AttributeShorthand??
  if (type === 'MustacheTag') {
    const { elements, value: expressionValue } = expression

    if (elements) {
      return elements.map((element) => element.value)
    }

    return expressionValue
  }

  return data
}

function getPropDataOrOption(node, attr) {
  const value = getPropData(node, attr)
  if (value !== undefined) return value
  return options[attr]
}

function getBreakpointsOption(node) {
  return getPropDataOrOption(node, 'breakpoints')
}

function getPlaceholderOption(node) {
  return getPropDataOrOption(node, 'placeholder')
}

function getRatioOption(node) {
  const width = getPropData(node, 'width')
  if (width !== undefined) return false
  return getPropDataOrOption(node, 'ratio')
}

function getSizesOption(node) {
  const width = getPropData(node, 'width')
  if (width !== undefined) {
    return [parseInt(width, 10)]
  }
  const option = getPropDataOrOption(node, 'sizes')
  return Array.isArray(option) ? option : JSON.parse(option)
}

function getSrc(node) {
  try {
    return getProp(node, 'src') || [{}]
  } catch (err) {
    console.log('Was unable to retrieve image src', err)
    return [{}]
  }
}

// Checks beginning of string for double leading slash, or the same preceeded by
// http or https
const IS_EXTERNAL = /^(https?:)?\/\//i

/**
 * Returns a boolean indicating if the filename has one of the extensions in the
 * array. If the array is empty, all files will be accepted.
 *
 * @param {string} filename the name of the image file to be parsed
 * @param {Array<string>} extensions Either of options.imgTagExtensions or
 * options.componentExtensions
 * @returns {boolean}
 */
function fileHasCorrectExtension(filename, extensions) {
  return extensions.length === 0
    ? true
    : extensions
        .map((x) => x.toLowerCase())
        .includes(filename.split('.').pop().toLowerCase())
}

function willNotProcess(reason) {
  return {
    willNotProcess: true,
    reason,
    paths: undefined
  }
}

function willProcess(nodeSrc) {
  return {
    willNotProcess: false,
    reason: undefined,
    paths: getPathsObject(nodeSrc)
  }
}

async function getProcessingPathsForNode(node) {
  const [value] = getSrc(node)

  if (!(value && value.data)) {
    return willNotProcess('The `src` is blank')
  }
  // dynamic or empty value
  if (value.type === 'MustacheTag' || value.type === 'AttributeShorthand') {
    return willNotProcess(`Cannot process a dynamic value: ${value.type}`)
  }
  if (
    node.name === 'img' &&
    !fileHasCorrectExtension(value.data, options.imgTagExtensions)
  ) {
    return willNotProcess(
      `The <img> tag was passed a file (${
        value.data
      }) whose extension is not one of ${options.imgTagExtensions.join(', ')}`
    )
  }
  if (
    node.name === options.tagName &&
    !fileHasCorrectExtension(value.data, options.componentExtensions)
  ) {
    return willNotProcess(
      `The ${options.tagName} component was passed a file (${
        value.data
      }) whose extension is not one of ${options.componentExtensions.join(
        ', '
      )}`
    )
  }

  // TODO:
  // resolve imported path
  // refactor externals

  let removedDomainSlash
  if (IS_EXTERNAL.test(value.data)) {
    if (!options.optimizeRemote) {
      return willNotProcess(`The \`src\` is external: ${value.data}`)
    } else {
      removedDomainSlash = await downloadImage(
        value.data,
        options.publicDir
      ).catch((e) => {
        console.error(e.toString())

        return null
      })

      if (removedDomainSlash === null) {
        return willNotProcess(`The url of is not an image: ${value.data}`)
      }
    }
  } else {
    removedDomainSlash = value.data.replace(/^\/([^\/])/, '$1')
  }

  const fullPath = path.resolve(options.publicDir, removedDomainSlash)

  if (fs.existsSync(fullPath)) {
    return willProcess(removedDomainSlash)
  } else {
    return willNotProcess(`The image file does not exist: ${fullPath}`)
  }
}

function getBasename(p) {
  return path.basename(p, path.extname(p))
}

function getRelativePath(p) {
  return path.relative(options.publicDir, p)
}

function getFilenameWithSize(p, size) {
  return `${getBasename(p)}-${size}${path.extname(p)}`
}

function getWebpFilenameWithSize(p, size) {
  return `${getBasename(p)}-${size}.webp`
}

function ensureOutDirExists(outDir) {
  mkdirp(path.join(options.publicDir, getRelativePath(outDir)))
}

function insert(content, value, start, end, offset) {
  return {
    content:
      content.substr(0, start + offset) + value + content.substr(end + offset),
    offset: offset + value.length - (end - start)
  }
}

async function createSizesMap(paths, sizes) {
  const smallestSize = Math.min(...sizes)
  const meta = await sharp(paths.inPath).metadata()
  const imageSizes = smallestSize > meta.width ? [meta.width] : sizes

  return (
    await Promise.all(
      imageSizes.reduce((result, size) => {
        result.push(resize(size, paths, meta))
        if (options.retina) result.push(resize(size * 2, paths, meta))
        return result
      }, [])
    )
  ).filter(Boolean)
}

async function resize(size, paths, meta = null) {
  if (!meta) {
    meta = await sharp(paths.inPath).metadata()
  }
  const { outPath, outUrl, outPathWebp } = paths.getResizePaths(size)

  if (meta.width < size) return null

  ensureOutDirExists(paths.outDir)

  if (options.webp && !fs.existsSync(outPathWebp)) {
    await sharp(paths.inPath)
      .resize({ width: size, withoutEnlargement: true })
      .webp(options.webpOptions)
      .toFile(outPathWebp)
  }

  if (fs.existsSync(outPath)) {
    return {
      ...meta,
      filename: outUrl,
      size
    }
  }

  return {
    ...meta,
    ...(await sharp(paths.inPath)
      .resize({ width: size, withoutEnlargement: true })
      .jpeg({
        quality: options.quality,
        progressive: false,
        force: false
      })
      .png({ compressionLevel: options.compressionLevel, force: false })
      .toFile(outPath)),
    size,
    filename: outUrl
  }
}

// Pass a string, then it will call itself with an array
function mkdirp(dir) {
  if (typeof dir === 'string') {
    if (fs.existsSync(dir)) {
      return dir
    }
    return mkdirp(dir.split(path.sep))
  }

  return dir.reduce((created, nextPart) => {
    const newDir = path.join(created, nextPart)
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir)
    }
    return newDir
  }, '')
}

const pathSepPattern = new RegExp('\\' + path.sep, 'g')

const srcsetLine = (s) =>
  `${s.filename.replace(pathSepPattern, '/')} ${s.size}w`

const srcsetLineWebp = (s) =>
  srcsetLine(s)
    .replace('jpg', 'webp')
    .replace('png', 'webp')
    .replace('jpeg', 'webp')

function createOffset() {
  return ` offset=\"${options.offset}\" `
}

function createRatio(sizes) {
  return `${(1 / (sizes[0].width / sizes[0].height)) * 100}%`
}

function createSizes(sizes, breakpoints) {
  return (
    sizes
      // filter out retina sizes when calculating sizes attribute
      .reduce((result, size, index) => {
        if (options.retina && index % 2 === 1) return result
        result.push(size)
        return result
      }, [])
      // create size w/ breakpoint
      .reduce((result, data, index) => {
        const query = [`${data.size}px`]
        if (index > 0) query.unshift(`(min-width: ${breakpoints[index]}px)`)
        result.push(query.join(' '))
        return result
      }, [])
      .reverse()
      .join(', ')
  )
}

function createSrcset(sizes, lineFn = srcsetLine, tag = 'srcset') {
  const imageSizes = Array.isArray(sizes) ? sizes : [sizes]
  const srcSetValue = imageSizes
    .filter((f) => f)
    .map(lineFn)
    .join()

  return ` ${tag}=\"${srcSetValue}\" `
}

async function replaceInComponent(edited, node) {
  const { content, offset } = await edited
  const { paths, willNotProcess, reason } = await getProcessingPathsForNode(
    node
  )

  if (willNotProcess) {
    console.error(reason)
    return { content, offset }
  }

  const sizes = await createSizesMap(paths, getSizesOption(node))

  const placeholder = getPlaceholderOption(node)
  const base64 =
    placeholder &&
    (placeholder === 'blur'
      ? await getBase64(paths.inPath)
      : await getTrace(paths.inPath))

  const base = { content, offset }
  const [{ start, end }] = getSrc(node)

  // add placeholder as src if using placeholder
  const withBase64 = replaceProp({
    content,
    end: end + offset,
    start: start + offset,
    value: base64 || ''
  })

  // add/modify sizes w/ breakpoints and pixel sizes
  const withSizes = replaceOrAddProp({
    base,
    node,
    previous: withBase64,
    prop: 'sizes',
    value: createSizes(sizes, getBreakpointsOption(node))
  })

  // assumes srcset is never passed, may need to target for replacement
  // insert srcset
  const withSrcset = addProp({
    ...withSizes,
    value: createSrcset(sizes)
  })

  const withOffset = addProp({
    ...withSrcset,
    value: createOffset()
  })

  // insert ratio if needed and active
  const withRatio = ['', true].includes(getRatioOption(node))
    ? replaceOrAddProp({
        base,
        node,
        previous: withOffset,
        prop: 'ratio',
        value: createRatio(sizes)
      })
    : withOffset

  if (!options.webp) return withRatio

  // insert webp srcs
  const withWebp = addProp({
    ...withRatio,
    value: createSrcset(sizes, srcsetLineWebp, 'srcsetWebp')
  })

  return {
    ...withWebp,
    // add current nodes changes to offset
    offset: offset + withWebp.content.length - base.content.length
  }
}

function replaceOrAddProp({ base, node, previous, prop, value }) {
  const { content } = previous
  const propData = getProp(node, prop)

  if (!!propData) {
    const [{ end, start }] = propData

    // calculate diff for replace from previous changes
    const contentDiff = content.length - base.content.length
    const diff = base.offset + (start > previous.start ? contentDiff : 0)

    return replaceProp({
      content,
      end: end + diff,
      node,
      prop,
      start: start + diff,
      value: `\"${value}\"`
    })
  }

  return addProp({
    ...previous,
    value: ` ${prop}=\"${value}\" `
  })
}

function replaceProp({ content, end, start, value }) {
  return {
    ...insert(content, value, start, end, 0),
    end,
    start
  }
}

function addProp({ content, end, offset, start, value }) {
  return {
    ...insert(content, value, end + 1, end + 1, offset),
    end,
    start
  }
}

async function optimize(paths) {
  const { size } = fs.statSync(paths.inPath)
  if (options.inlineBelow && size < options.inlineBelow) {
    return getBase64(paths.inPath, true)
  }

  ensureOutDirExists(paths.outDir)

  await sharp(paths.inPath)
    .jpeg({ quality: options.quality, progressive: false, force: false })
    .webp({ quality: options.quality, lossless: true, force: false })
    .png({ compressionLevel: options.compressionLevel, force: false })
    .toFile(paths.outPath)

  return paths.outUrl
}

async function replaceInImg(edited, node) {
  const { content, offset } = await edited

  const { paths, willNotProcess } = await getProcessingPathsForNode(node)

  if (willNotProcess) {
    return { content, offset }
  }

  const [{ start, end }] = getSrc(node)

  try {
    const outUri = await optimize(paths)
    return insert(content, outUri, start, end, offset)
  } catch (e) {
    console.error(e)
    return { content, offset }
  }
}

async function replaceImages(content) {
  let ast
  const imageNodes = []

  if (!content.includes('<img') && !content.includes('<Image')) return content

  try {
    ast = svelte.parse(content)
  } catch (e) {
    console.error(e, 'Error parsing component content')
  }

  svelte.walk(ast, {
    enter: (node) => {
      if (!['Element', 'Fragment', 'InlineComponent'].includes(node.type)) {
        return
      }

      if (options.optimizeAll && node.name === 'img') {
        imageNodes.push(node)
        return
      }

      if (node.name !== options.tagName) return
      imageNodes.push(node)
    }
  })

  if (!imageNodes.length) return content

  const beforeProcessed = {
    content,
    offset: 0
  }
  const processed = await imageNodes.reduce(async (edited, node) => {
    if (node.name === 'img') {
      return replaceInImg(edited, node)
    }
    return replaceInComponent(edited, node)
  }, beforeProcessed)

  return processed.content
}

/**
 * @param {Partial<typeof options>} options
 */
function getPreprocessor(opts = {}) {
  options = {
    ...options,
    ...opts
  }

  return {
    markup: async ({ content }) => ({
      code: await replaceImages(content)
    })
  }
}

module.exports = {
  defaults: options,
  replaceImages,
  getPreprocessor
}
