/**
 * Genera el PDF de una cotización (diseño premium, con el logo de Gladymar).
 */
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { bs, type Cotizacion } from "./cotizacion.js";

/**
 * ¿El material no es de primera calidad? En la lista de Gladymar conviven
 * "PORTAFOLIO" (primera) con "SEGUNDA", "GRANEL" y "LIQUIDACIÓN". Cotizar una
 * segunda sin decirlo es venderle al cliente algo distinto de lo que cree
 * comprar: el mismo modelo de primera cuesta bastante más.
 */
function esSegunda(status?: string): boolean {
  const s = (status || "").toUpperCase();
  return s === "SEGUNDA" || s === "GRANEL" || s === "LIQUIDACIÓN" || s === "LIQUIDACION";
}

const ROJO = "#d8232a";
const ROJO2 = "#b51d23";
const TINTA = "#161a1f";
const GRIS = "#6b7280";
const GRIS2 = "#9aa0ac";
const LINEA = "#eceef1";
const CREMA = "#f7f8fa";

/** Genera el PDF en public/cotizaciones/ y devuelve la ruta relativa (para servirla). */
export function generarCotizacionPDF(cot: Cotizacion): Promise<string> {
  const dir = path.join(process.cwd(), "public", "cotizaciones");
  fs.mkdirSync(dir, { recursive: true });
  const rel = `cotizaciones/${cot.numero}.pdf`;
  const abs = path.join(process.cwd(), "public", rel);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const stream = fs.createWriteStream(abs);
    doc.pipe(stream);
    const W = doc.page.width;
    const H = doc.page.height;
    const M = 50;
    const R = W - M;

    // Barra superior de acento
    doc.rect(0, 0, W, 6).fill(ROJO);

    // ── Encabezado ──
    const logo = path.join(process.cwd(), "public", "gladymar-logo.png");
    try { if (fs.existsSync(logo)) doc.image(logo, M, 34, { width: 50 }); } catch { /* sin logo */ }
    doc.fillColor(TINTA).font("Helvetica-Bold").fontSize(24).text("COTIZACIÓN", M + 62, 38);
    doc.fillColor(GRIS).font("Helvetica").fontSize(9.5).text("Cerámica Gladymar S.A.", M + 62, 68);
    doc.fillColor(GRIS2).fontSize(8.5).text("Acabados y porcelanato · gladymar.com.bo", M + 62, 81);

    // Badge N° / fecha (derecha)
    const bw = 150, bx = R - bw, by = 34;
    doc.roundedRect(bx, by, bw, 58, 8).fill(CREMA);
    doc.fillColor(GRIS2).font("Helvetica-Bold").fontSize(8).text("N° COTIZACIÓN", bx + 12, by + 10);
    doc.fillColor(ROJO).font("Helvetica-Bold").fontSize(12).text(cot.numero, bx + 12, by + 22);
    doc.fillColor(GRIS).font("Helvetica").fontSize(7.5).text(`Emitida: ${cot.fecha}`, bx + 12, by + 38);
    doc.fillColor(ROJO).font("Helvetica-Bold").fontSize(7.5).text("Válida por 24 horas", bx + 12, by + 47);

    // ── Cliente ──
    let y = 118;
    doc.roundedRect(M, y, R - M, 46, 8).fill(CREMA);
    doc.fillColor(GRIS2).font("Helvetica-Bold").fontSize(8).text("PREPARADO PARA", M + 14, y + 10);
    doc.fillColor(TINTA).font("Helvetica-Bold").fontSize(14).text(cot.cliente, M + 14, y + 22);
    if (cot.ciudad) doc.fillColor(GRIS).font("Helvetica").fontSize(10).text(cot.ciudad, R - 160, y + 24, { width: 146, align: "right" });

    // ── Tabla ──
    y += 66;
    const subX = R - 14;
    const cDesc = M + 14;
    const cCant = subX - 268; // ancho 40, derecha
    const cUni = subX - 214;  // ancho 46, izquierda
    const cPu = subX - 168;   // ancho 70, derecha
    const cSub = subX - 90;   // ancho 90, derecha
    const wDesc = cCant - 12 - cDesc;
    doc.roundedRect(M, y, R - M, 24, 5).fill(ROJO);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5);
    doc.text("DESCRIPCIÓN", cDesc, y + 8);
    doc.text("CANT.", cCant, y + 8, { width: 40, align: "right" });
    doc.text("UNIDAD", cUni, y + 8, { width: 46, align: "left" });
    doc.text("P. UNIT.", cPu, y + 8, { width: 70, align: "right" });
    doc.text("SUBTOTAL", cSub, y + 8, { width: 90, align: "right" });
    y += 24;

    doc.font("Helvetica").fontSize(9.5);
    cot.items.forEach((it, i) => {
      // (*) marca el ítem que no salió de la lista oficial (precio estimado).
      // (2ª) segunda selección · (*) precio estimado, fuera de la lista oficial.
      const marcas = [esSegunda(it.status) ? "(2ª)" : "", it.oficial === false ? "(*)" : ""].filter(Boolean).join(" ");
      const desc = marcas ? `${it.descripcion} ${marcas}` : it.descripcion;
      const alto = Math.max(22, doc.heightOfString(desc, { width: wDesc }) + 10);
      if (i % 2 === 1) doc.rect(M, y, R - M, alto).fill(CREMA);
      const ty = y + 6;
      doc.fillColor(TINTA).font("Helvetica").text(desc, cDesc, ty, { width: wDesc });
      doc.fillColor(TINTA).text(String(it.cantidad), cCant, ty, { width: 40, align: "right" });
      doc.fillColor(GRIS).text(it.unidad, cUni, ty, { width: 46, align: "left" });
      doc.fillColor(TINTA).text(bs(it.precioUnit), cPu, ty, { width: 70, align: "right" });
      doc.fillColor(TINTA).font("Helvetica-Bold").text(bs(it.subtotal), cSub, ty, { width: 90, align: "right" });
      y += alto;
      doc.moveTo(M, y).lineTo(R, y).strokeColor(LINEA).lineWidth(0.6).stroke();
    });

    // ── Totales ──
    y += 16;
    const tW = 230, tX = R - tW;
    doc.fillColor(GRIS).font("Helvetica").fontSize(10).text("Subtotal", tX, y, { width: tW - 6, align: "left" });
    doc.fillColor(TINTA).font("Helvetica").text(bs(cot.total), tX, y, { width: tW, align: "right" });
    y += 20;
    doc.roundedRect(tX, y, tW, 36, 8).fill(ROJO);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11).text("TOTAL", tX + 14, y + 12);
    doc.font("Helvetica-Bold").fontSize(16).text(bs(cot.total), tX + 14, y + 9, { width: tW - 28, align: "right" });

    // ── Condiciones ──
    y += 62;
    doc.fillColor(TINTA).font("Helvetica-Bold").fontSize(9).text("Condiciones", M, y);
    doc.fillColor(GRIS).font("Helvetica").fontSize(8.5).text(
      `• Esta cotización vence el ${cot.vence} (24 horas desde su emisión). Pasado ese plazo los precios se recotizan.\n` +
      (cot.departamento
        ? `• Precios de la lista oficial vigente para ${cot.departamento}.\n`
        : "• Precios de lista a nivel nacional: no se pudo determinar la región del cliente.\n") +
      (cot.items.some((i) => esSegunda(i.status))
        ? "• Los ítems marcados con (2ª) son de SEGUNDA SELECCIÓN: material comercial, no de primera calidad.\n"
        : "") +
      (cot.items.some((i) => i.oficial === false)
        ? "• Los ítems marcados con (*) no figuran en la lista oficial: su precio es estimado y lo confirma el asesor.\n"
        : "") +
      "• Precios sujetos a confirmación de disponibilidad por el asesor de Gladymar.\n" +
      "• Este documento no constituye factura ni documento fiscal.\n" +
      "• Disponibilidad, tiempos de entrega y condiciones finales a confirmar por un asesor.",
      M, y + 14, { width: R - M, lineGap: 2 },
    );

    // ── Pie ──
    doc.rect(0, H - 44, W, 44).fill(TINTA);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9).text("Más que cerámicas, fabricamos emociones.", M, H - 32, { width: R - M, align: "center" });
    doc.fillColor(GRIS2).font("Helvetica").fontSize(7.5).text("Cerámica Gladymar S.A. · Grupo Roda · gladymar.com.bo", M, H - 19, { width: R - M, align: "center" });

    doc.end();
    stream.on("finish", () => resolve(rel));
    stream.on("error", reject);
  });
}
