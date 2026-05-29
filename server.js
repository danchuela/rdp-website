import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const port = Number(process.env.PORT || 3000);
const rootDir = resolve(".");
const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const rateBuckets = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8"
};

const assistantInstructions = `
Eres el asistente de RDP, Reliable Data Products.
Respondes en castellano, con tono profesional, claro, directo y cercano.
Hablas como el equipo fundador, pero sin fingir que eres una persona concreta.

RDP construye soluciones reales de IA, datos e integraciones para empresas:
- RAG, chatbots y asistentes sobre documentación interna.
- Agentes IA para operar 24/7 en tareas repetitivas.
- Automatizaciones inteligentes conectadas a procesos y herramientas.
- APIs e integraciones con CRMs, ERPs, hojas de cálculo, bases de datos y sistemas internos.
- Visión por computador, OCR, lectura de imágenes, vídeo y documentos.
- Analítica avanzada, dashboards, modelos predictivos y data products.

Forma de trabajar:
- Primero se entiende el problema y se detectan oportunidades reales.
- Después se diseña una solución útil, medible y mantenible.
- Se construye con entregas cortas, despliegue, observabilidad y seguimiento.
- Se prioriza privacidad, trazabilidad, calidad del dato, explicabilidad y adopción real.

Objetivo comercial:
- Ayuda a aclarar qué quiere mejorar la persona.
- Haz preguntas concretas cuando falte contexto.
- Si encaja, invita a reservar una llamada o dejar datos de contacto.
- No inventes precios, clientes, certificaciones ni compromisos legales.
- Si una pregunta requiere revisión humana, dilo y deriva al equipo.
`.trim();

function jsonResponse(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function getCorsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "vary": "Origin"
    };
  }
  return {};
}

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(req, limit = 24, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const ip = getClientIp(req);
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  return bucket.count > limit;
}

async function readJsonBody(req, maxBytes = 32_000) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) {
      const error = new Error("Body too large");
      error.status = 413;
      throw error;
    }
  }
  if (!body) return {};
  return JSON.parse(body);
}

function cleanText(value, maxLength = 1200) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-10)
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: cleanText(message?.content, 1600)
    }))
    .filter((message) => message.content.length > 0);
}

async function callOpenAI(messages) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: openaiModel,
      instructions: assistantInstructions,
      input: messages,
      temperature: 0.45,
      max_output_tokens: 650
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || "OpenAI request failed";
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }

  const directText = typeof data.output_text === "string" ? data.output_text : "";
  const nestedText = Array.isArray(data.output)
    ? data.output
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
    : "";

  return (directText || nestedText || "").trim();
}

async function sendContactEmail(payload) {
  if (!process.env.RESEND_API_KEY || !process.env.CONTACT_TO || !process.env.CONTACT_FROM) {
    return { delivered: false, reason: "Email delivery is not configured" };
  }

  const subject = `Nuevo contacto RDP: ${payload.name || "sin nombre"}`;
  const text = [
    "Nuevo mensaje desde rdp-ia.com",
    "",
    `Nombre: ${payload.name || "-"}`,
    `Email: ${payload.email || "-"}`,
    `Empresa: ${payload.company || "-"}`,
    "",
    payload.message || "-"
  ].join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.CONTACT_FROM,
      to: [process.env.CONTACT_TO],
      reply_to: payload.email,
      subject,
      text
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || "Email delivery failed");
    error.status = response.status;
    throw error;
  }

  return { delivered: true };
}

async function handleChat(req, res, corsHeaders) {
  if (!process.env.OPENAI_API_KEY) {
    return jsonResponse(res, 503, { error: "OPENAI_API_KEY is not configured" }, corsHeaders);
  }
  if (isRateLimited(req)) {
    return jsonResponse(res, 429, { error: "Demasiados mensajes. Prueba de nuevo en unos minutos." }, corsHeaders);
  }

  const body = await readJsonBody(req);
  const messages = cleanMessages(body.messages);
  if (messages.length === 0) {
    return jsonResponse(res, 400, { error: "Envía al menos un mensaje." }, corsHeaders);
  }

  const reply = await callOpenAI(messages);
  return jsonResponse(res, 200, {
    reply: reply || "Ahora mismo no he podido generar una respuesta clara. Déjanos tus datos y lo revisamos."
  }, corsHeaders);
}

async function handleContact(req, res, corsHeaders) {
  if (isRateLimited(req, 12, 30 * 60 * 1000)) {
    return jsonResponse(res, 429, { error: "Demasiados envíos. Prueba de nuevo más tarde." }, corsHeaders);
  }

  const body = await readJsonBody(req, 18_000);
  const payload = {
    name: cleanText(body.nombre || body.name, 120),
    email: cleanText(body.email, 180),
    company: cleanText(body.empresa || body.company, 180),
    message: cleanText(body.mensaje || body.message, 3500)
  };

  if (!payload.name || !payload.email || !payload.message) {
    return jsonResponse(res, 400, { error: "Nombre, email y mensaje son obligatorios." }, corsHeaders);
  }

  const delivery = await sendContactEmail(payload);
  if (!delivery.delivered) {
    console.log("Contact lead received without email delivery configured:", payload);
  }

  return jsonResponse(res, 200, {
    ok: true,
    delivered: delivery.delivered,
    message: delivery.delivered
      ? "Mensaje enviado. Te responderemos pronto."
      : "Mensaje registrado en el servidor. Falta configurar el envío por email."
  }, corsHeaders);
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const requestPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(rootDir, safePath);

  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    const extension = extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": mimeTypes[extension] || "application/octet-stream",
      "cache-control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable"
    });
    res.end(file);
  } catch {
    const index = await readFile(join(rootDir, "index.html"));
    res.writeHead(200, { "content-type": mimeTypes[".html"], "cache-control": "no-cache" });
    res.end(index);
  }
}

const server = createServer(async (req, res) => {
  const corsHeaders = getCorsHeaders(req);

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (req.url === "/health") {
      return jsonResponse(res, 200, { ok: true }, corsHeaders);
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      return await handleChat(req, res, corsHeaders);
    }

    if (req.method === "POST" && req.url === "/api/contact") {
      return await handleContact(req, res, corsHeaders);
    }

    if (req.method === "GET" || req.method === "HEAD") {
      return await serveStatic(req, res);
    }

    return jsonResponse(res, 405, { error: "Method not allowed" }, corsHeaders);
  } catch (error) {
    const status = error.status || 500;
    console.error(error);
    return jsonResponse(res, status, {
      error: status >= 500 ? "Error interno del servidor." : error.message
    }, corsHeaders);
  }
});

server.listen(port, () => {
  console.log(`RDP server running on port ${port}`);
});
