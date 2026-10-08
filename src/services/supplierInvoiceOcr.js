'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { pathToFileURL } = require('url');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { createWorker, OEM } = require('tesseract.js');

const MAX_PDF_PAGES = 8;
const MAX_PAGE_PIXELS = 18_000_000;
const OCR_TARGET_WIDTH = 2_200;
const OCR_CACHE_DIR = path.join(os.tmpdir(), 'alrifai-erp-ocr');

let workerPromise = null;
let queuedJob = Promise.resolve();

function ensureLanguageData() {
  const target = path.join(OCR_CACHE_DIR, 'lang');
  fs.mkdirSync(target, { recursive: true });
  for (const code of ['ara', 'eng']) {
    const packageData = require(`@tesseract.js-data/${code}`);
    const source = path.join(packageData.langPath, `${code}.traineddata.gz`);
    const destination = path.join(target, `${code}.traineddata.gz`);
    if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
  }
  return target;
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const langPath = ensureLanguageData();
      const worker = await createWorker(['ara', 'eng'], OEM.LSTM_ONLY, {
        langPath,
        cachePath: path.join(OCR_CACHE_DIR, 'cache'),
        gzip: true,
        logger: () => {},
      });
      await worker.setParameters({
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
      return worker;
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

function targetDimensions(width, height) {
  const scale = Math.min(
    Math.max(1, OCR_TARGET_WIDTH / width),
    3,
    Math.sqrt(MAX_PAGE_PIXELS / Math.max(1, width * height)),
    6_000 / Math.max(1, height),
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function normalizeCanvas(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const gray = Math.round(
      (pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114 - 128) * 1.15 + 128,
    );
    const value = Math.max(0, Math.min(255, gray));
    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
  }
  context.putImageData(image, 0, 0);
  return canvas.toBuffer('image/png');
}

async function imageBufferToPng(buffer) {
  let image;
  try {
    image = await loadImage(buffer);
  } catch (_) {
    throw new Error('تعذرت قراءة الصورة. استخدم PNG أو JPG أو WEBP واضحة.');
  }
  if (!image.width || !image.height || image.width * image.height > 80_000_000) {
    throw new Error('أبعاد الصورة أكبر من الحد الآمن للمعالجة.');
  }
  const { width, height } = targetDimensions(image.width, image.height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return normalizeCanvas(canvas);
}

async function pdfBufferToPngPages(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let document;
  try {
    const pdfjsEntry = path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
    const standardFontDataUrl = pathToFileURL(`${path.resolve(pdfjsEntry, '../../standard_fonts')}${path.sep}`).href;
    document = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      isEvalSupported: false,
      // Keep PDF.js text on the native canvas text path. Its custom Path2D
      // glyph fallback is incompatible with @napi-rs/canvas.
      disableFontFace: false,
      standardFontDataUrl,
    }).promise;
  } catch (_) {
    throw new Error('تعذرت قراءة ملف PDF. تأكد أن الملف سليم وغير محمي بكلمة مرور.');
  }
  if (!document.numPages || document.numPages > MAX_PDF_PAGES) {
    await document.destroy();
    throw new Error(`الحد الأقصى ${MAX_PDF_PAGES} صفحات لكل فاتورة.`);
  }

  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const dimensions = targetDimensions(base.width, base.height);
      const scale = dimensions.width / base.width;
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      if (width * height > MAX_PAGE_PIXELS) {
        page.cleanup();
        throw new Error('إحدى صفحات PDF أكبر من الحد الآمن للمعالجة.');
      }
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      await page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise;
      pages.push(normalizeCanvas(canvas));
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  return pages;
}

function normalizeLabel(value) {
  return String(value || '')
    .replace(/[٠-٩۰-۹]/g, (digit) => String(digit >= '۰' && digit <= '۹' ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) : '٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, '');
}

function parseAmount(value) {
  let text = String(value || '')
    .replace(/[٠-٩۰-۹]/g, (digit) => String(digit >= '۰' && digit <= '۹' ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) : '٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[٬\s]/g, '')
    .replace(/[٫]/g, '.')
    .replace(/[ججمكريالدولار$€£٪%]/g, '');
  if (!/^[+-]?\d[\d.,]*$/.test(text)) return null;
  if (text.includes(',') && text.includes('.')) {
    const decimal = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
    text = decimal === ',' ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (text.includes(',')) {
    const decimals = text.length - text.lastIndexOf(',') - 1;
    text = decimals > 0 && decimals <= 2 ? text.replace(',', '.') : text.replace(/,/g, '');
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

const COLUMN_HINTS = {
  name: ['اسم الصنف', 'الصنف', 'المنتج', 'بيان الصنف', 'الوصف', 'product name', 'description'],
  code: ['كود الصنف', 'كود المنتج', 'باركود', 'sku', 'barcode', 'item code', 'item no', 'item number'],
  qty: ['الكمية', 'كمية', 'عدد', 'qty', 'quantity'],
  unit_cost: ['سعر الوحدة', 'سعر القطعة', 'تكلفة الوحدة', 'سعر التكلفة', 'u.price', 'u price', 'unit price', 'unit cost', 'price'],
  discount_pct: ['نسبة الخصم', 'خصم %', 'discount'],
  line_total: ['الإجمالي', 'الاجمالي', 'إجمالي الصنف', 'المبلغ', 'amount', 'total'],
  index: ['no.', 'serial no', 's/n', 'row no', 'sl no'],
};

function detectHeader(lines) {
  let best = null;
  for (let index = 0; index < Math.min(lines.length, 35); index += 1) {
    const line = lines[index];
    const normalizedLine = normalizeLabel(line.words.map((word) => word.text).join(' '));
    const centers = {};
    let score = 0;
    for (const [field, hints] of Object.entries(COLUMN_HINTS)) {
      const matched = hints.find((hint) => normalizedLine.includes(normalizeLabel(hint)));
      if (!matched) continue;
      const matchedNorm = normalizeLabel(matched);
      const words = line.words.filter((word) => {
        const norm = normalizeLabel(word.text);
        return norm && (norm === matchedNorm || (norm.length >= 4 && matchedNorm.includes(norm)) || (matchedNorm.length >= 4 && norm.includes(matchedNorm)) || (matchedNorm.length >= 3 && norm.startsWith(matchedNorm)));
      });
      if (!words.length) continue;
      centers[field] = words.reduce((sum, word) => sum + word.left + word.width / 2, 0) / words.length;
      score += field === 'name' || field === 'qty' || field === 'unit_cost' ? 2 : 1;
    }
    if ((centers.name !== undefined || centers.code !== undefined) && score >= 4 && (!best || score > best.score)) best = { index, centers, score };
  }
  return best;
}

function groupTsvLines(tsv, pageNumber) {
  const rows = new Map();
  const allLines = String(tsv || '').split(/\r?\n/);
  for (let index = 1; index < allLines.length; index += 1) {
    const parts = allLines[index].split('\t');
    if (parts.length < 12 || Number(parts[0]) !== 5) continue;
    const text = parts.slice(11).join('\t').trim();
    const confidence = Number(parts[10]);
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
    const key = `${parts[1]}-${parts[2]}-${parts[3]}-${parts[4]}`;
    if (!rows.has(key)) rows.set(key, { page: pageNumber, top: Number(parts[7]) || 0, words: [] });
    rows.get(key).words.push({
      text,
      confidence,
      left: Number(parts[6]) || 0,
      top: Number(parts[7]) || 0,
      width: Number(parts[8]) || 0,
      height: Number(parts[9]) || 0,
      wordNum: Number(parts[5]) || 0,
    });
  }
  return [...rows.values()].sort((a, b) => a.top - b.top);
}

function closestField(word, centers) {
  let selected = null;
  let distance = Infinity;
  for (const [field, center] of Object.entries(centers)) {
    const current = Math.abs(word.left + word.width / 2 - center);
    if (current < distance) { selected = field; distance = current; }
  }
  return selected;
}

function makeRow(line, assigned, confidence, sequence) {
  const cellText = Object.fromEntries(Object.entries(assigned).map(([field, words]) => [
    field,
    words.sort((a, b) => a.wordNum - b.wordNum).map((word) => word.text).join(' ').trim(),
  ]));
  const rawText = line.words.sort((a, b) => a.wordNum - b.wordNum).map((word) => word.text).join(' ').trim();
  const numericCandidates = line.words
    .map((word) => ({ value: parseAmount(word.text), word }))
    .filter((entry) => entry.value !== null && entry.value > 0);
  const hasHeaderMapping = Boolean(assigned.qty?.length || assigned.unit_cost?.length);
  let qty = parseAmount(cellText.qty);
  let unitCost = parseAmount(cellText.unit_cost);
  let lineTotal = parseAmount(cellText.line_total);
  let confidencePct = Math.max(0, Math.min(100, Math.round(confidence)));
  let inferredQuantity = false;

  if (!hasHeaderMapping && numericCandidates.length >= 2) {
    const ordered = [...numericCandidates].sort((a, b) => a.value - b.value);
    qty = qty || ordered[0].value;
    unitCost = unitCost || ordered[1].value;
    lineTotal = lineTotal || (ordered.length > 2 ? ordered[ordered.length - 1].value : null);
    confidencePct = Math.min(confidencePct, 44);
  }

  // When a quantity digit is merged into a neighboring code column, recover it
  // only when invoice arithmetic provides an exact, independently readable ratio.
  if (qty === null && lineTotal !== null && unitCost > 0) {
    const quantityFromTotals = lineTotal / (unitCost * (1 - (parseAmount(cellText.discount_pct) || 0) / 100));
    const roundedQuantity = Math.round(quantityFromTotals * 10_000) / 10_000;
    if (Number.isFinite(roundedQuantity) && roundedQuantity > 0 && roundedQuantity <= 1_000_000) {
      qty = roundedQuantity;
      inferredQuantity = true;
      confidencePct = Math.min(confidencePct, 64);
    }
  }

  const inferredWords = line.words
    .filter((word) => parseAmount(word.text) === null)
    .sort((a, b) => a.wordNum - b.wordNum)
    .map((word) => word.text);
  const name = cellText.name || inferredWords.join(' ').trim();
  const code = cellText.code || '';
  const discount = parseAmount(cellText.discount_pct);
  if (!name && !code) return null;
  const calculated = qty !== null && unitCost !== null
    ? Math.round((qty * unitCost * (1 - (discount || 0) / 100) + Number.EPSILON) * 100) / 100
    : null;
  return {
    source_row: sequence,
    page: line.page,
    name,
    code,
    qty_ordered: qty,
    unit_cost: unitCost,
    discount_pct: discount || 0,
    line_total: calculated ?? lineTotal,
    ocr_line_total: lineTotal,
    confidence: confidencePct,
    raw_text: rawText,
    needs_review: !hasHeaderMapping || inferredQuantity || !name || qty === null || unitCost === null,
  };
}

function parseTsv(tsv, pageNumber, sequenceStart = 0, inheritedHeader = null) {
  const lines = groupTsvLines(tsv, pageNumber);
  const detectedHeader = detectHeader(lines);
  const header = detectedHeader || inheritedHeader;
  const items = [];
  let lastItem = null;
  for (let index = detectedHeader ? detectedHeader.index + 1 : 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNorm = normalizeLabel(line.words.map((word) => word.text).join(' '));
    if (['الاجمالي', 'اجمالي', 'subtotal', 'grandtotal', 'total'].some((word) => lineNorm.includes(normalizeLabel(word)))) continue;
    const assigned = {};
    if (header) {
      for (const word of line.words) {
        const field = closestField(word, header.centers);
        if (!field) continue;
        (assigned[field] ||= []).push(word);
      }
    }
    const averageConfidence = line.words.reduce((sum, word) => sum + word.confidence, 0) / Math.max(1, line.words.length);
    const row = makeRow(line, assigned, averageConfidence, sequenceStart + items.length + 1);
    if (row && (row.qty_ordered !== null || row.unit_cost !== null)) {
      items.push(row);
      lastItem = row;
    } else if (row && lastItem && row.raw_text) {
      lastItem.name = `${lastItem.name} ${row.name || row.raw_text}`.trim();
      lastItem.raw_text = `${lastItem.raw_text} | ${row.raw_text}`;
      lastItem.needs_review = true;
    }
  }
  return { items, headerDetected: Boolean(detectedHeader), header: detectedHeader || inheritedHeader };
}

function pdfTextToTsv(items, pageNumber) {
  const spans = (items || []).filter(item => String(item.str || '').trim() && Array.isArray(item.transform));
  if (!spans.length) return '';
  const positioned = spans.map((item, index) => ({ text: String(item.str).replace(/[\t\r\n]+/g, ' ').trim(), x: Number(item.transform[4]) || 0, y: Number(item.transform[5]) || 0, width: Math.max(1, Math.abs(Number(item.width) || 1)), height: Math.max(1, Math.abs(Number(item.height) || 1)), index })).filter(item => item.text);
  positioned.sort((a, b) => b.y - a.y || a.x - b.x || a.index - b.index);
  const lines = [];
  for (const span of positioned) {
    const line = lines.find(candidate => Math.abs(candidate.y - span.y) <= Math.max(1.5, Math.min(candidate.height, span.height) * 0.3));
    if (line) { line.spans.push(span); line.height = Math.max(line.height, span.height); }
    else lines.push({ y: span.y, height: span.height, spans: [span] });
  }
  lines.sort((a, b) => b.y - a.y);
  const rows = ['level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'];
  lines.forEach((line, lineIndex) => {
    line.spans.sort((a, b) => a.x - b.x || a.index - b.index);
    line.spans.forEach((span, wordIndex) => rows.push(`5\t${pageNumber}\t1\t1\t${lineIndex + 1}\t${wordIndex + 1}\t${Math.round(span.x * 10)}\t${Math.round(-line.y * 10)}\t${Math.round(span.width * 10)}\t${Math.round(span.height * 10)}\t100\t${span.text}`));
  });
  return rows.join('\n');
}

function extractSourceTotal(items) {
  const spans = (items || []).filter(item => String(item.str || '').trim() && Array.isArray(item.transform));
  const totals = [];
  for (const label of spans) {
    if (!normalizeLabel(label.str).includes('total')) continue;
    const lineValues = spans.filter(item => Math.abs((Number(item.transform?.[5]) || 0) - (Number(label.transform?.[5]) || 0)) <= 2).map(item => parseAmount(item.str)).filter(value => value !== null && value >= 0);
    if (lineValues.length) totals.push(Math.max(...lineValues));
  }
  return totals.length ? totals[totals.length - 1] : null;
}

function extractSourceTotalFromTsv(tsv) {
  const totals = [];
  for (const line of groupTsvLines(tsv, 1)) {
    const text = line.words.map(word => word.text).join(' ');
    if (!normalizeLabel(text).includes('total') && !normalizeLabel(text).includes('الاجمالي') && !normalizeLabel(text).includes('الإجمالي')) continue;
    const values = line.words.map(word => parseAmount(word.text)).filter(value => value !== null && value >= 0);
    if (values.length) totals.push(Math.max(...values));
  }
  return totals.length ? totals[totals.length - 1] : null;
}

function buildResult(allItems, pageResults, headerDetected, sourceTotal = null) {
  if (!allItems.length) throw new Error('لم يتم العثور على بنود قابلة للقراءة. جرّب صورة أوضح أو ملف Excel/CSV.');
  const calculatedTotal = Math.round((allItems.reduce((sum, item) => sum + (Number(item.line_total) || 0), 0) + Number.EPSILON) * 100) / 100;
  const totalMismatch = sourceTotal !== null && Math.abs(calculatedTotal - sourceTotal) > 0.01;
  return {
    items: allItems, page_count: pageResults.length, page_results: pageResults,
    header_detected: headerDetected, source_total: sourceTotal, calculated_total: calculatedTotal,
    review_warnings: [
      ...(!headerDetected ? ['لم يتم التعرف على عناوين الأعمدة بدقة؛ راجع الكمية وسعر الوحدة لكل بند.'] : []),
      ...(allItems.some(item => item.needs_review || item.confidence < 70) ? ['هناك بنود منخفضة الثقة أو ناقصة وتحتاج مراجعة قبل الاعتماد.'] : []),
      ...(totalMismatch ? [`إجمالي البنود المحسوب (${calculatedTotal.toFixed(2)}) لا يطابق إجمالي الفاتورة (${sourceTotal.toFixed(2)}). راجع البنود قبل إنشاء أمر الشراء.`] : []),
    ],
  };
}

function createPdfPageCanvas(page) {
  const base = page.getViewport({ scale: 1 });
  const dimensions = targetDimensions(base.width, base.height);
  const viewport = page.getViewport({ scale: dimensions.width / base.width });
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  if (width * height > MAX_PAGE_PIXELS) throw new Error('إحدى صفحات PDF أكبر من الحد الآمن للمعالجة.');
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
  return { canvas, context, viewport };
}

async function renderPdfPageWithPoppler(buffer, pageNumber) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alrifai-ocr-pdf-'));
  const inputPath = path.join(tempDir, 'invoice.pdf');
  const outputPrefix = path.join(tempDir, 'page');
  try {
    fs.writeFileSync(inputPath, buffer);
    await execFileAsync(process.env.PDFTOPPM_PATH || 'pdftoppm', [
      '-f', String(pageNumber), '-l', String(pageNumber), '-r', '300', '-png', '-singlefile', inputPath, outputPrefix,
    ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    return imageBufferToPng(fs.readFileSync(`${outputPrefix}.png`));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('تعذر تحويل صفحة PDF الممسوحة؛ أداة التحويل الاحتياطية غير متاحة على الخادم.');
    throw new Error(`تعذر تحويل صفحة PDF رقم ${pageNumber} للقراءة. جرّب حفظ الفاتورة كصورة أو Excel.`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function processPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjsEntry = path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const standardFontDataUrl = pathToFileURL(`${path.resolve(pdfjsEntry, '../../standard_fonts')}${path.sep}`).href;
  let document;
  try {
    document = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, disableFontFace: false, standardFontDataUrl }).promise;
  } catch (_) { throw new Error('تعذرت قراءة ملف PDF. تأكد أن الملف سليم وغير محمي بكلمة مرور.'); }
  if (!document.numPages || document.numPages > MAX_PDF_PAGES) {
    await document.destroy();
    throw new Error(`الحد الأقصى ${MAX_PDF_PAGES} صفحات لكل فاتورة.`);
  }
  let worker = null;
  const allItems = []; const pageResults = [];
  let header = null; let headerDetected = false; let sourceTotal = null;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageSourceTotal = extractSourceTotal(textContent.items);
      if (pageSourceTotal !== null) sourceTotal = pageSourceTotal;
      const textParsed = parseTsv(pdfTextToTsv(textContent.items, pageNumber), pageNumber, allItems.length, header);
      const usableTextRows = textParsed.items.filter(item => item.qty_ordered !== null && item.unit_cost !== null);
      let parsed = textParsed; let confidence = 100; let method = 'text';
      if (!usableTextRows.length) {
        if (!textContent.items.some(item => String(item.str || '').trim())) {
          const operators = await page.getOperatorList();
          const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintSolidColorImageMask]);
          const hasImages = operators.fnArray.some(operator => imageOps.has(operator));
          if (!hasImages && operators.fnArray.length < 20) {
            pageResults.push({ page: pageNumber, confidence: 100, item_count: 0, method: 'blank' });
            page.cleanup();
            continue;
          }
        }
        method = 'ocr';
        let normalized;
        try {
          const { canvas, context, viewport } = createPdfPageCanvas(page);
          await page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise;
          normalized = normalizeCanvas(canvas);
        } catch (_) {
          normalized = await renderPdfPageWithPoppler(buffer, pageNumber);
        }
        worker ||= await getWorker();
        const { data } = await worker.recognize(normalized, {}, { tsv: true });
        const ocrTotal = extractSourceTotalFromTsv(data.tsv);
        if (sourceTotal === null && ocrTotal !== null) sourceTotal = ocrTotal;
        parsed = parseTsv(data.tsv, pageNumber, allItems.length, header);
        confidence = Math.round(data.confidence || 0);
      } else parsed.items = usableTextRows;
      if (parsed.header) header = parsed.header;
      headerDetected ||= parsed.headerDetected;
      allItems.push(...parsed.items);
      pageResults.push({ page: pageNumber, confidence, item_count: parsed.items.length, method });
      page.cleanup();
    }
  } finally { await document.destroy(); }
  return buildResult(allItems, pageResults, headerDetected, sourceTotal);
}

async function processPages(pages) {
  const worker = await getWorker();
  const allItems = [];
  const pageResults = [];
  let headerDetected = false;
  let header = null;
  let sourceTotal = null;
  for (let index = 0; index < pages.length; index += 1) {
    const { data } = await worker.recognize(pages[index], {}, { tsv: true });
    const pageTotal = extractSourceTotalFromTsv(data.tsv);
    if (pageTotal !== null) sourceTotal = pageTotal;
    const parsed = parseTsv(data.tsv, index + 1, allItems.length, header);
    if (parsed.header) header = parsed.header;
    allItems.push(...parsed.items);
    headerDetected ||= parsed.headerDetected;
    pageResults.push({ page: index + 1, confidence: Math.round(data.confidence || 0), item_count: parsed.items.length, method: 'ocr' });
  }
  return buildResult(allItems, pageResults, headerDetected, sourceTotal);
}

async function recognizeSupplierInvoice({ buffer, extension }) {
  const job = queuedJob.then(async () => {
    if (extension === 'pdf') return processPdf(buffer);
    return processPages([await imageBufferToPng(buffer)]);
  });
  queuedJob = job.catch(() => {});
  return job;
}

module.exports = { recognizeSupplierInvoice, parseAmount };
