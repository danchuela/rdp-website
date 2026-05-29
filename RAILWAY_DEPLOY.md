# Despliegue en Railway

Este proyecto puede funcionar como web estática y como backend en Railway.

## Variables necesarias

- `OPENAI_API_KEY`: clave privada de OpenAI. Nunca debe ir en `index.html`.
- `OPENAI_MODEL`: modelo usado por el chat. Valor recomendado inicial: `gpt-4.1-mini`.
- `ALLOWED_ORIGINS`: dominios permitidos para llamar a la API. Ejemplo:
  `https://rdp-ia.com,https://www.rdp-ia.com`

## Contacto por email

El endpoint `/api/contact` recibe mensajes aunque no haya email configurado, pero para enviarlos a un buzón necesitas Resend:

- `RESEND_API_KEY`
- `CONTACT_TO`
- `CONTACT_FROM`

Mientras no estén configuradas, Railway guardará el lead en logs y la web avisará de que falta configurar el envío.

## Rutas

- `/`: web de RDP.
- `/api/chat`: chatbot conectado a OpenAI.
- `/api/contact`: formulario de contacto.
- `/health`: healthcheck de Railway.

## Dominio

Para que `rdp-ia.com` use el backend, el dominio debe apuntar a Railway, no a GitHub Pages. En Railway hay que añadir el dominio custom y después copiar los DNS que Railway indique en Porkbun.
