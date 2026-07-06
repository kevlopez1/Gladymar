/**
 * Genera el PDF de una cotización (con el logo de Gladymar).
 */
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { bs, type Cotizacion } from "./cotizacion.js";

const ROJO = "#d8232a";
const GRIS = "#6b7280";
const TINTA = "#1b1f24";

/**
 * Genera el PDF en public/cotizaciones/ y devuelve la ruta relativa (para servirla).
 */
export function generarCotizacionPDF(cot: Cotizacion): Promise<string> {
  const dir = path.join(process.cwd(), "public", "cotizaciones");
  fs.mkdirSync(dir, { recursive: true });
  const rel = `cotizaciones/${cot.numero}.pdf`;
  const abs = path.join(process.cwd(), "public", rel);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 46 });
    const stream = fs.createWriteStream(abs);
    doc.pipe(stream);
    const W = doc.page.width;
    const L = 46;
    const R = W - 46;

    const logo = path.join(process.cwd(), "public", "gladymar-logo.png");
    try { if (fs.existsSync(logo)) doc.image(logo, L, 40, { width: 54 }); } catch { /* sin logo */ }
    doc.fillColor(TINTA).font("Helvetica-Bold").fontSize(22).text("COTIZACIÓN", L + 66, 46);
    doc.fillColor(GRIS).font("Helvetica").fontSize(10).text("Cerámica Gladymar S.A.", L + 66, 72);
    doc.font("Helvetica-Bold").fillColor(ROJO).fontSize(11).text(cot.numero, R - 160, 48, { width: 160, align: "right" });
    doc.font("Helvetica").fillColor(GRIS).fontSize(9).text(`Fecha: ${cot.fecha}`, R - 160, 66, { width: 160, align: "right" });
    doc.text("Válida por 15 días", R - 160, 78, { width: 160, align: "right" });

    doc.moveTo(L, 100).lineTo(R, 100).strokeColor("#e5e7eb").lineWidth(1).stroke();

    doc.fillColor(GRIS).font("Helvetica").fontSize(9).text("CLIENTE", L, 112);
    doc.fillColor(TINTA).font("Helvetica-Bold").fontSize(13).text(cot.cliente, L, 124);
    if (cot.ciudad) doc.fillColor(GRIS).font("Helvetica").fontSize(10).text(cot.ciudad, L, 142);

    let y = 172;
    const cX = { desc: L, cant: R - 250, uni: R - 190, pu: R - 130, sub: R };
    doc.rect(L, y - 6, R - L, 22).fill(ROJO);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    doc.text("DESCRIPCIÓN", cX.desc + 6, y);
    doc.text("CANT.", cX.cant, y, { width: 50, align: "right" });
    doc.text("UNIDAD", cX.uni + 6, y, { width: 55, align: "left" });
    doc.text("P. UNIT.", cX.pu - 40, y, { width: 70, align: "right" });
    doc.text("SUBTOTAL", cX.sub - 90, y, { width: 90, align: "right" });
    y += 24;

    doc.font("Helvetica").fontSize(9.5);
    for (const it of cot.items) {
      const h = Math.max(18, doc.heightOfString(it.descripcion, { width: cX.cant - cX.desc - 12 }) + 6);
      doc.fillColor(TINTA).text(it.descripcion, cX.desc + 6, y, { width: cX.cant - cX.desc - 12 });
      doc.fillColor(TINTA).text(String(it.cantidad), cX.cant, y, { width: 50, align: "right" });
      doc.fillColor(GRIS).text(it.unidad, cX.uni + 6, y, { width: 55, align: "left" });
      doc.fillColor(TINTA).text(bs(it.precioUnit), cX.pu - 40, y, { width: 70, align: "right" });
      doc.font("Helvetica-Bold").text(bs(it.subtotal), cX.sub - 90, y, { width: 90, align: "right" });
      doc.font("Helvetica");
      y += h;
      doc.moveTo(L, y - 3).lineTo(R, y - 3).strokeColor("#eef0f2").lineWidth(0.5).stroke();
    }

    y += 8;
    doc.rect(R - 220, y, 220, 30).fill("#f6f7f8");
    doc.fillColor(GRIS).font("Helvetica-Bold").fontSize(11).text("TOTAL", R - 214, y + 9);
    doc.fillColor(ROJO).font("Helvetica-Bold").fontSize(15).text(bs(cot.total), R - 150, y + 6, { width: 144, align: "right" });

    y += 50;
    doc.fillColor(GRIS).font("Helvetica-Oblique").fontSize(8.5).text(
      "Precios REFERENCIALES / estimados, sujetos a confirmación del asesor de Gladymar. No constituye factura ni documento fiscal. Disponibilidad y condiciones finales a confirmar por un asesor.",
      L, y, { width: R - L, align: "left" },
    );

    doc.fillColor(ROJO).font("Helvetica-Bold").fontSize(9).text("Más que cerámicas, fabricamos emociones.", L, doc.page.height - 60, { width: R - L, align: "center" });
    doc.fillColor(GRIS).font("Helvetica").fontSize(8).text("Cerámica Gladymar S.A. · gladymar.com.bo", L, doc.page.height - 46, { width: R - L, align: "center" });

    doc.end();
    stream.on("finish", () => resolve(rel));
    stream.on("error", reject);
  });
}
