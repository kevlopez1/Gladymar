# 🤖 Agente de WhatsApp – Cerámica Gladymar

Agente de inteligencia artificial para atención al cliente de **Cerámica Gladymar S.A.** (Bolivia) por **WhatsApp**. Responde consultas sobre productos (porcelanato, cerámica, sanitarios, griferías, complementos), precios referenciales, ubicación y horarios de sucursales, y deriva a un asesor humano cuando hace falta.

Construido con:
- **WhatsApp Cloud API (Meta)** — canal oficial.
- **Claude (Anthropic)** vía la Messages API con *tool use* y *prompt caching*.
- **Node.js + TypeScript + Express**.

---

## 🏢 Sobre Gladymar (resumen)

- Fabricante líder de cerámica y porcelanato en Bolivia, +38 años, parte del Grupo Industrial Roda.
- Pionera en porcelanato "en seco" (sin agua) y formatos de hasta 90x90 cm.
- **Gladymar Plus**: tienda de acabados finos más grande de Latinoamérica (Santa Cruz).
- Sucursales en **Santa Cruz, La Paz y Cochabamba**. Web: [gladymar.com.bo](https://gladymar.com.bo).

> ⚠️ Los datos de sucursales, teléfonos y precios incluidos son de **fuentes públicas** y **referenciales**. Verifícalos y actualízalos con el equipo de Gladymar antes de producción (`src/knowledge/`).

---

## 📂 Estructura

```
src/
├── index.ts              # Servidor Express: webhook GET/POST + healthcheck
├── config.ts             # Carga y valida variables de entorno
├── agent/
│   ├── brain.ts          # Cerebro: Claude + loop de herramientas + multi-turno
│   ├── systemPrompt.ts   # Persona e instrucciones del agente
│   └── tools.ts          # Herramientas: productos, sucursales, escalar a humano
├── knowledge/            # Base de conocimiento de Gladymar (EDITAR aquí)
│   ├── company.ts
│   ├── sucursales.ts
│   └── productos.ts
├── session/
│   └── store.ts          # Historial de conversación por usuario (en memoria)
└── whatsapp/
    ├── client.ts         # Envío de mensajes (Graph API)
    └── webhook.ts        # Verificación y parseo de mensajes entrantes
scripts/
└── chat.ts               # Simulador de consola (probar sin WhatsApp)
```

---

## 🚀 Puesta en marcha

### 1. Requisitos
- Node.js 20 o superior.
- Una **API key de Anthropic** → [console.anthropic.com](https://console.anthropic.com).
- Una **cuenta de WhatsApp Business** y una app en [developers.facebook.com](https://developers.facebook.com).

### 2. Instalar y configurar
```bash
npm install
cp .env.example .env
# Edita .env con tus credenciales reales
```

### 3. Probar el agente SIN WhatsApp (recomendado primero)
Solo necesitas `ANTHROPIC_API_KEY` en tu `.env` (las credenciales de WhatsApp son opcionales).

**Opción A — Demo web (réplica de WhatsApp):** ideal para mostrar a clientes/gerencia.
```bash
npm run dev   # o: npm run build && npm start
```
Abre **http://localhost:3000/** : verás una interfaz idéntica a WhatsApp donde puedes chatear con el agente en vivo.

**Opción B — Consola:**
```bash
npm run chat
```
Chatea como si fueras un cliente. Comandos: `/reset`, `/salir`.

### 4. Levantar el servidor
```bash
npm run dev      # desarrollo (recarga automática)
# o en producción:
npm run build && npm start
```
El servidor escucha en `http://localhost:3000` (configurable con `PORT`).

---

## 🔗 Conectar con WhatsApp Cloud API

1. En [Meta for Developers](https://developers.facebook.com): crea una app → agrega el producto **WhatsApp**.
2. En **WhatsApp → API Setup** obtén:
   - **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **Access Token** (temporal de 24h para pruebas, o uno permanente vía System User) → `WHATSAPP_ACCESS_TOKEN`
3. Expón tu servidor con HTTPS público. En desarrollo puedes usar:
   ```bash
   npx ngrok http 3000
   ```
4. En **WhatsApp → Configuration → Webhook**:
   - **Callback URL**: `https://TU-DOMINIO/webhook`
   - **Verify token**: el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`.
   - Suscríbete al campo **`messages`**.
5. Envía un WhatsApp al número de prueba y el agente responderá.

---

## ⚙️ Configuración (`.env`)

| Variable | Descripción |
|---|---|
| `PORT` | Puerto del servidor (default 3000). |
| `ANTHROPIC_API_KEY` | API key de Anthropic. **Obligatoria.** |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` (máxima calidad), `claude-sonnet-4-6` (equilibrio, recomendado), o `claude-haiku-4-5` (económico). |
| `WHATSAPP_ACCESS_TOKEN` | Token de la Graph API. |
| `WHATSAPP_PHONE_NUMBER_ID` | ID del número de WhatsApp. |
| `WHATSAPP_API_VERSION` | Versión de la Graph API (default `v21.0`). |
| `WHATSAPP_VERIFY_TOKEN` | Token de verificación del webhook (lo inventas tú). |
| `SESSION_TTL_MINUTES` | Minutos de inactividad antes de reiniciar una conversación. |
| `SURVEY_URL` | Enlace de la encuesta de satisfacción. |
| `SURVEY_DELAY_MINUTES` | Minutos de inactividad para enviar la encuesta (0 = desactivar). |
| `MANUAL_ASENTAMIENTO_URL` | Enlace público al PDF del Manual de Asentamiento (vacío = no se adjunta). |

---

## 🧠 Cómo funciona

1. Meta entrega los mensajes entrantes a `POST /webhook`.
2. `brain.ts` arma el historial del usuario y llama a Claude con:
   - el **prompt del sistema** (persona + base de conocimiento + menú), **cacheado** para reducir costo y latencia;
   - las **herramientas** (`mostrar_menu`, `buscar_productos`, `buscar_sucursales`, `info_tema`, `registrar_solicitud`).
3. Si Claude pide una herramienta, se ejecuta y se le devuelve el resultado (loop hasta la respuesta final).
4. La respuesta se envía por WhatsApp y el historial se guarda por número (multi-turno, con expiración por TTL).
5. **Encuesta de satisfacción**: tras `SURVEY_DELAY_MINUTES` de inactividad (fin de conversación), se envía automáticamente el enlace de la encuesta una sola vez.
6. **Manual de Asentamiento**: si el cliente lo solicita y `MANUAL_ASENTAMIENTO_URL` está configurado, el agente adjunta el PDF (Tríptico de Colocación).

---

## 🧭 Menú de atención

El agente guía al cliente con este menú (definido en `src/knowledge/menu.ts`). Entiende tanto números (ej. `2.3`) como lenguaje natural:

1. **Diseñar mi espacio** → 1.1 Roomvo · 1.2 Contactar asesor
2. **Cotizar productos** → 2.1 Catálogo · 2.2 Asesoramiento · 2.3 Diferencias cerámica/porcelanato · 2.4 Pegamento recomendado · 2.5 Contactar asesor
3. **Seguimiento de pedidos** → 3.1 Contactar asesor (por el momento)
4. **Soporte y reclamos** → 4.1 Ubicaciones · 4.2 Teléfonos · 4.3 Horarios · 4.4 Manual de asentamiento · 4.5 Registro de reclamos · 4.6 Soluciones a problemas frecuentes · 4.7 Agendar visita técnica

> El agente **no genera cotizaciones**: conecta al cliente con un asesor de ventas.
> Los contenidos/enlaces marcados *POR CONFIRMAR* (Roomvo, manual de asentamiento, soluciones oficiales, contactos de áreas) están en `src/knowledge/temas.ts` y `src/knowledge/contactos.ts` para completarse con datos oficiales.

## 📊 Registro de clientes en Google Sheets

Cada interacción del agente se registra como una fila en tu hoja de Google Sheets (fecha, teléfono, nombre, mensaje, respuesta, tipo de solicitud, detalle y si se derivó a un asesor).

Se usa un **Google Apps Script** ligado a la hoja (no requiere credenciales en el servidor):

1. Crea una hoja en Google Sheets. En la primera fila pon los encabezados:
   `Fecha | Teléfono | Nombre | Mensaje | Respuesta | Tipo solicitud | Prioridad | Detalle | Escalado`
2. Menú **Extensiones → Apps Script** y pega:
   ```javascript
   function doPost(e) {
     var hoja = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
     var d = JSON.parse(e.postData.contents);
     hoja.appendRow([
       d.fecha, d.telefono, d.nombre || "", d.mensaje, d.respuesta,
       d.tipo_solicitud || "", d.prioridad || "", d.detalle || "", d.escalado ? "Sí" : "No"
     ]);
     return ContentService
       .createTextOutput(JSON.stringify({ ok: true }))
       .setMimeType(ContentService.MimeType.JSON);
   }
   ```
3. **Implementar → Nueva implementación → Aplicación web**. Ejecutar como *tú*; acceso *Cualquier usuario*. Copia la URL.
4. Pega esa URL en `.env` como `SHEETS_WEBHOOK_URL`.

Si `SHEETS_WEBHOOK_URL` queda vacío, el registro se desactiva (solo consola).

> Para producción de alto volumen o mayor control, esto puede migrarse a la API de Google Sheets con una cuenta de servicio.

## 🛠️ Personalización

- **Productos / sucursales / empresa**: edita los archivos en `src/knowledge/`.
- **Personalidad y reglas**: edita `src/agent/systemPrompt.ts`.
- **Nuevas capacidades** (ej. consultar stock real, crear cotizaciones): agrega una herramienta en `src/agent/tools.ts` con su esquema y su implementación.
- **Persistencia para producción**: `InMemorySessionStore` guarda el historial en memoria (se pierde al reiniciar y no escala a múltiples instancias). Implementa la interfaz `SessionStore` con Redis o una base de datos para producción seria.

---

## ✅ Notas para producción

- Usa un **Access Token permanente** (System User) en lugar del temporal de 24h.
- Considera **verificar la firma** de los webhooks de Meta (header `X-Hub-Signature-256`) con tu *App Secret*.
- Para alto volumen, `claude-sonnet-4-6` o `claude-haiku-4-5` reducen costos significativamente.
- Reemplaza el almacén de sesiones en memoria por uno persistente (Redis/DB).
- Revisa y mantén actualizada la base de conocimiento en `src/knowledge/`.

---

## 📜 Comandos

| Comando | Acción |
|---|---|
| `npm run chat` | Simulador de consola (sin WhatsApp). |
| `npm run dev` | Servidor en modo desarrollo. |
| `npm run build` | Compila TypeScript a `dist/`. |
| `npm start` | Ejecuta el servidor compilado. |
| `npm run typecheck` | Verifica tipos sin compilar. |
