// =============================================
//  server.js — Backend Transcriptor IA
//  Stack: Node.js + Express + Groq Whisper
// =============================================

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Groq = require("groq-sdk");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || "25");

// ── Groq client ────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Middleware ─────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Carpeta temporal de uploads ────────────────────────────────
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// ── Multer: configuración de subida ───────────────────────────
const ALLOWED_TYPES = [
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
  "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/ogg",
  "audio/flac", "audio/webm",
  "video/mp4", "video/webm", "video/ogg", "video/quicktime",
  "video/x-msvideo", "video/mpeg",
];

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) return cb(null, true);
    const ext = path.extname(file.originalname).toLowerCase();
    const validExts = [".mp3", ".mp4", ".wav", ".m4a", ".ogg", ".flac", ".webm", ".mov", ".avi", ".mpeg"];
    if (validExts.includes(ext)) return cb(null, true);
    cb(new Error(`Formato no soportado: ${file.mimetype || ext}`));
  },
});

// ── Helper: limpiar archivo temporal ──────────────────────────
function cleanup(filePath) {
  fs.unlink(filePath, (err) => {
    if (err) console.warn("No se pudo eliminar archivo temporal:", filePath);
  });
}

// ── Helper: construir prompt para post-procesamiento ──────────
function buildPostPrompt(transcript, opts, lang, speakers) {
  const parts = [];

  if (opts.includes("transcripcion")) {
    parts.push(`1. TRANSCRIPCIÓN COMPLETA:\n${transcript}`);
  }
  if (opts.includes("resumen")) {
    parts.push(`2. RESUMEN EJECUTIVO: Genera un resumen conciso de los puntos más importantes del contenido anterior en ${lang}.`);
  }
  if (opts.includes("subtitulos")) {
    parts.push(`3. SUBTÍTULOS SRT: Convierte la transcripción en formato SRT numerado (00:00:00,000 --> 00:00:05,000) estimando tiempos. Máximo 2 líneas por bloque.`);
  }
  if (opts.includes("puntos_clave")) {
    parts.push(`4. PUNTOS CLAVE: Lista los 5-10 takeaways más importantes en viñetas (•) en ${lang}.`);
  }
  if (opts.includes("blog")) {
    parts.push(`5. POST DE BLOG: Redacta un artículo completo basado en el contenido, con título, introducción, desarrollo en secciones y conclusión. En ${lang}.`);
  }

  const speakerNote =
    speakers === "1"
      ? "Hay un solo hablante."
      : speakers === "2"
      ? "Puede haber 2 hablantes; si los detectas, diferéncialos con [Persona 1] y [Persona 2]."
      : "Pueden haber varios hablantes; identifícalos como [Hablante 1], [Hablante 2], etc.";

  return `Eres un experto en procesamiento de transcripciones. ${speakerNote}

El idioma de salida solicitado es: ${lang}.

Procesa el siguiente contenido y proporciona EXACTAMENTE las secciones pedidas, con el encabezado de sección en mayúsculas seguido de dos saltos de línea:

${parts.join("\n\n")}`;
}

// ══════════════════════════════════════════════════════════════
//  RUTA: POST /api/transcribe
// ══════════════════════════════════════════════════════════════
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo." });
    }

    const { outputTypes, language, speakers } = req.body;
    const opts = outputTypes ? JSON.parse(outputTypes) : ["transcripcion"];
    const lang = language || "español";
    const spk = speakers || "1";

    console.log(`[${new Date().toISOString()}] Transcribiendo: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)}MB)`);

    // ── Paso 1: Groq Whisper — Speech to Text ─────────────────
    const audioStream = fs.createReadStream(filePath);

    const whisperResponse = await groq.audio.transcriptions.create({
      file: audioStream,
      model: "whisper-large-v3",
      language: lang === "español" ? "es"
               : lang === "inglés" ? "en"
               : lang === "portugués" ? "pt"
               : lang === "francés" ? "fr"
               : lang === "alemán" ? "de"
               : undefined,
      response_format: "text",
    });

    const rawTranscript = whisperResponse || "";

    if (!rawTranscript.trim()) {
      cleanup(filePath);
      return res.status(422).json({ error: "No se detectó voz en el archivo. Verifica que contenga audio audible." });
    }

    // Si solo piden transcripción, devolver directo
    if (opts.length === 1 && opts[0] === "transcripcion") {
      cleanup(filePath);
      return res.json({ result: rawTranscript.trim(), words: rawTranscript.trim().split(/\s+/).length });
    }

    // ── Paso 2: Groq LLM — Post-procesamiento ─────────────────
    const postPrompt = buildPostPrompt(rawTranscript, opts, lang, spk);

    const gptResponse = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: postPrompt }],
      max_tokens: 2000,
      temperature: 0.3,
    });

    const processed = gptResponse.choices[0]?.message?.content || rawTranscript;

    cleanup(filePath);

    return res.json({
      result: processed.trim(),
      rawTranscript: rawTranscript.trim(),
      words: processed.trim().split(/\s+/).length,
    });

  } catch (err) {
    if (filePath) cleanup(filePath);
    console.error("Error en transcripción:", err.message || err);

    if (err?.status === 401) {
      return res.status(401).json({ error: "API Key de Groq inválida. Revisa tu archivo .env" });
    }
    if (err?.status === 413 || err?.message?.includes("too large")) {
      return res.status(413).json({ error: `Archivo demasiado grande. El límite es ${MAX_MB}MB.` });
    }
    if (err?.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `Archivo demasiado grande. El límite es ${MAX_MB}MB.` });
    }

    return res.status(500).json({ error: "Error interno al procesar el archivo. " + (err.message || "") });
  }
});

// ── RUTA: GET /api/health ──────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    groq: !!process.env.GROQ_API_KEY,
    maxFileMB: MAX_MB,
    timestamp: new Date().toISOString(),
  });
});

// ── Fallback: servir index.html ────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Iniciar servidor ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎙️  Transcriptor IA corriendo en http://localhost:${PORT}`);
  console.log(`   Groq Key:   ${process.env.GROQ_API_KEY ? "✅ configurada" : "❌ falta en .env"}`);
  console.log(`   Tamaño max: ${MAX_MB}MB\n`);
});
