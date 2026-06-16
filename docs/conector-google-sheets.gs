/**
 * Conector Google Sheets para el Agente Gladymar.
 *
 * Pega este código en: tu Google Sheet -> Extensiones -> Apps Script.
 * Luego: Implementar -> Nueva implementación -> Tipo "Aplicación web"
 *   - Ejecutar como: Yo
 *   - Quién tiene acceso: Cualquier usuario
 * Copia la URL de la app web y ponela en Railway como SHEETS_WEBHOOK_URL.
 */
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var d = JSON.parse(e.postData.contents);

  // Encabezados (una sola vez, si la hoja está vacía).
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      "Fecha", "Teléfono", "Nombre", "Mensaje", "Respuesta",
      "Tipo de solicitud", "Prioridad", "Detalle", "Derivado a asesor"
    ]);
  }

  sheet.appendRow([
    d.fecha || "",
    d.telefono || "",
    d.nombre || "",
    d.mensaje || "",
    d.respuesta || "",
    d.tipo_solicitud || "",
    d.prioridad || "",
    d.detalle || "",
    d.escalado ? "Sí" : "No"
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
