const PDFDocument = require('pdfkit');

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_MARGIN = 28.35;

function createOutstandingPdf(images) {
  if (!Array.isArray(images) || images.length === 0) throw new Error('صفحات كشف PDF غير موجودة');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', autoFirstPage: false, compress: true, info: { Title: 'Outstanding balances report' } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      for (const image of images) {
        doc.addPage({ size: 'A4', margins: 0 });
        doc.image(image, CONTENT_MARGIN, CONTENT_MARGIN, { width: PAGE_WIDTH - CONTENT_MARGIN * 2, height: PAGE_HEIGHT - CONTENT_MARGIN * 2 });
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { createOutstandingPdf };
