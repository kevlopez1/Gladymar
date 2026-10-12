# Messenger e Instagram: cómo quedó conectado

Notas de lo que costó conectar los DM de Gladymar, para que nadie vuelva a
perder días en lo mismo. Los dos errores de abajo dicen algo distinto de lo que
pasa, y leerlos literalmente lleva al lugar equivocado.

## Los dos errores y lo que significaban de verdad

```
(#190) This method must be called with a Page Access Token
```

El token de System User tenía todos los permisos. El problema no eran los
permisos: Meta exige un token **de la página**, y un token de System User no lo
es por más accesos que tenga. El token de página no se genera en ninguna
pantalla del panel — se le **pide** a Meta con el de System User:

```
GET /v23.0/{PAGE_ID}?fields=access_token
Authorization: Bearer {TOKEN_DE_SYSTEM_USER}
```

Como viene de un System User, no caduca. El bot lo deriva solo al arrancar
(`src/meta/tokenPagina.ts`), así que **no hay un secreto nuevo que cargar**. Si
alguna vez hiciera falta fijarlo a mano, existe `META_PAGE_TOKEN`.

```
Object with ID '1784140...' does not exist, cannot be loaded
due to missing permissions, or does not support this operation
```

Ese id era el de la cuenta de Instagram, y la cuenta estaba perfectamente
conectada. Instagram tiene dos configuraciones y no son intercambiables:

| | Objeto al que se le habla | Token | Dominio |
|---|---|---|---|
| **Facebook login** (el de Gladymar) | la **página**, con `platform=instagram` | de página | `graph.facebook.com` |
| Instagram login | la cuenta de Instagram | propio de IG | `graph.instagram.com` |

Con Facebook login, los DM de Instagram **no** se piden a la cuenta de
Instagram: se piden a la página. Pegarle a la cuenta devuelve ese "does not
exist" que se lee como una cuenta desconectada y es solo la puerta equivocada.

## Las dos suscripciones que hay que no confundir

Son distintas y hacen falta las dos:

1. **En el panel de la app** (Webhooks → objeto `page` / `instagram`): dice qué
   eventos quiere escuchar *la app*.
2. **`POST /{PAGE_ID}/subscribed_apps`**: dice que los quiere de **esa página**.

Faltaba la segunda. El panel mostraba todo suscrito y al webhook no llegaba un
solo POST — mientras los de WhatsApp entraban por la misma URL y con el mismo
verify token, que es lo que confirmaba que el servidor estaba bien. Requiere el
token de página, por eso no se podía hacer antes. Ahora el bot la hace sola al
arrancar.

## Dos caminos, no uno

- **Webhook**: Meta avisa. Es el camino normal.
- **Sondeo** (`src/meta/sondeo.ts`): el bot pregunta cada tanto, con
  `META_SONDEO_SEGUNDOS`. Existe porque mandar y enterarse son cosas distintas:
  el token puede alcanzar de sobra para responder y aun así el bot no enterarse
  nunca de que alguien escribió.

Si el webhook entrega, el sondeo queda de respaldo y no molesta: los mensajes ya
atendidos se recuerdan, así que nadie recibe dos respuestas.

## Para diagnosticar

`GET /admin/meta-dm?key=…&canal=instagram` informa los tres pasos por separado
—token, suscripción, conversaciones—, porque cuando algo no anda, saber cuál de
los tres falló es la mitad del arreglo. Con `&suscribir=1` además vuelve a
suscribir la página.
