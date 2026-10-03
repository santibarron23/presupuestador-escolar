// PDF del presupuesto. Recibe líneas YA preciadas por priceLines() (precios del catálogo, nunca del cliente).
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const config = require("../config");

const LOGO = path.join(config.root, "public", "assets", "logo-lerma.png");
const BRAND = "#AFCB21";
const INK = "#1f2a14";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";
const SOFT = "#f6f8ec";
const WARN = "#9a3412";

const A4 = { w: 595.28, h: 841.89 };
const M = 40;
const W = A4.w - M * 2;

const money = (n) => "$" + Number(n).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// link: URL del presupuesto online (la arma el servidor). Se imprime con un QR para abrirlo desde el celular.
async function renderBudgetPdf({ budgetId, lines, total, pending = [], schoolName, link = null }, stream) {
  // Un QR con un link largo (presupuesto autocontenido, sin base de datos) no se puede escanear en papel.
  const qr = link && link.length <= 300 ? await QRCode.toBuffer(link, { margin: 0, width: 220, errorCorrectionLevel: "M" }).catch(() => null) : null;
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true,
    info: { Title: `Presupuesto escolar ${budgetId} - ${config.store.name}`, Author: config.store.name } });
  doc.pipe(stream);

  const date = new Date();
  const valid = new Date(date.getTime() + config.store.budgetValidityDays * 86400000);
  const fmtDate = (d) => d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  let y = 0;

  function header() {
    doc.rect(0, 0, A4.w, 6).fill(BRAND);
    if (fs.existsSync(LOGO)) doc.image(LOGO, M, 22, { height: 34 });
    else doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text(config.store.name, M, 28);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(13).text("Presupuesto de lista escolar", M, 24, { width: W, align: "right" });
    doc.fillColor(MUTED).font("Helvetica").fontSize(9)
      .text(`N° ${budgetId}  ·  ${fmtDate(date)}`, M, 42, { width: W, align: "right" });
    y = 76;
    doc.moveTo(M, y).lineTo(A4.w - M, y).lineWidth(0.5).strokeColor(LINE).stroke();
    y += 14;
  }

  function ensure(space, repeatHeader) {
    if (y + space <= A4.h - 70) return;
    doc.addPage({ size: "A4", margin: 0 });
    header();
    if (repeatHeader) repeatHeader();
  }

  header();
  if (schoolName) {
    doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(10).text(schoolName, M, y, { width: W });
    y += 18;
  }

  // Resumen
  const available = lines.filter((l) => l.available);
  doc.roundedRect(M, y, W, 54, 6).fill(SOFT);
  doc.fillColor(MUTED).font("Helvetica").fontSize(9)
    .text(`${available.length} artículos con precio${pending.length ? `  ·  ${pending.length} para consultar` : ""}`, M + 14, y + 12)
    .text(`Precios válidos hasta el ${fmtDate(valid)} o hasta agotar stock.`, M + 14, y + 28);
  doc.fillColor(MUTED).fontSize(8).text("TOTAL ESTIMADO", M, y + 12, { width: W - 14, align: "right" });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text(money(total), M, y + 24, { width: W - 14, align: "right" });
  y += 70;

  if (link) {
    const size = 58;
    if (qr) doc.image(qr, M, y, { width: size, height: size });
    const tx = M + (qr ? size + 12 : 0);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text("Abrilo online y compralo en un paso", tx, y + 6, { width: W - (tx - M) });
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5)
      .text("Escaneá el código o entrá al link: vas a ver este presupuesto con precios y stock actualizados.", tx, y + 21, { width: W - (tx - M) });
    doc.fillColor("#0d6e45").fontSize(8.5).text(link.length > 90 ? link.slice(0, 87) + "…" : link, tx, y + 34, { width: W - (tx - M), link, underline: true });
    y += size + 16;
  }

  // Tabla
  const C = { qty: 34, name: 296, unit: 80, sub: W - 34 - 296 - 80 };
  const tableHeader = () => {
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
    let x = M;
    doc.text("CANT.", x, y, { width: C.qty }); x += C.qty;
    doc.text("PRODUCTO", x, y, { width: C.name }); x += C.name;
    doc.text("P. UNIT.", x, y, { width: C.unit, align: "right" }); x += C.unit;
    doc.text("SUBTOTAL", x, y, { width: C.sub, align: "right" });
    y += 14;
    doc.moveTo(M, y).lineTo(A4.w - M, y).lineWidth(0.5).strokeColor(LINE).stroke();
    y += 6;
  };
  if (available.length) tableHeader();
  for (const l of available) {
    const title = l.name + (l.variantLabel ? ` (${l.variantLabel})` : "");
    doc.font("Helvetica").fontSize(9);
    const h = Math.max(doc.heightOfString(title, { width: C.name - 8 }), 11) + (l.requestedItem ? 11 : 0) + 8;
    ensure(h, tableHeader);
    let x = M;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9).text(String(l.packs), x, y, { width: C.qty }); x += C.qty;
    doc.font("Helvetica").fillColor(INK).text(title, x, y, { width: C.name - 8 });
    if (l.requestedItem) {
      doc.fillColor(MUTED).fontSize(7.5).text(`Pedido: ${l.requestedItem}${l.sku ? "  ·  SKU " + l.sku : ""}`, x, doc.y + 1, { width: C.name - 8 });
    }
    x += C.name;
    doc.fillColor(MUTED).fontSize(9).text(money(l.unitPrice), x, y, { width: C.unit, align: "right" }); x += C.unit;
    doc.fillColor(INK).font("Helvetica-Bold").text(money(l.subtotal), x, y, { width: C.sub, align: "right" });
    y += h;
    doc.moveTo(M, y - 4).lineTo(A4.w - M, y - 4).lineWidth(0.3).strokeColor(LINE).stroke();
  }
  if (available.length) {
    ensure(34);
    doc.rect(M, y, W, 26).fill(BRAND);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("TOTAL ESTIMADO", M + 12, y + 8);
    doc.text(money(total), M, y + 8, { width: W - 12, align: "right" });
    y += 40;
  }

  // Pendientes
  if (pending.length) {
    ensure(40);
    doc.fillColor(WARN).font("Helvetica-Bold").fontSize(11).text("Para consultar en la librería", M, y);
    y += 16;
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5)
      .text("No están en la tienda online o no encontramos uno compatible. Consultanos en la sucursal o por WhatsApp.", M, y, { width: W });
    y += 18;
    for (const p of pending) {
      const t = `${p.packs || 1} × ${p.requestedItem}${p.note ? " — " + p.note : ""}`;
      doc.font("Helvetica").fontSize(9);
      const h = doc.heightOfString(t, { width: W - 10 }) + 5;
      ensure(h);
      doc.fillColor(INK).text("•  " + t, M, y, { width: W - 10 });
      y += h;
    }
  }

  // Pie en todas las páginas
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = A4.h - 42;
    doc.moveTo(M, fy).lineTo(A4.w - M, fy).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.fillColor(MUTED).font("Helvetica").fontSize(8)
      .text(`${config.store.name}  ·  ${config.store.address}  ·  Tel. ${config.store.phone}  ·  ${config.store.website}`, M, fy + 10, { width: W - 60 })
      .text(`${i + 1} / ${range.count}`, M, fy + 10, { width: W, align: "right" });
  }
  doc.end();
}

module.exports = { renderBudgetPdf };
