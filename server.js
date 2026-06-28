// =============================================
//  server.js — Backend Transcriptor IA
//  Stack: Node.js + Express + Groq + yt-dlp
// =============================================

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { execSync, exec } = require("child_process");
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

// ── Multer ─────────────────────────────────────────────────────
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

// ── Helper: limpiar archivo ────────────────────────────────────
function cleanup(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

// ── Helper: detectar si es URL de red social ──────────────────
function isSocialUrl(url) {
  return /youtube\.com|youtu\.be|tiktok\.com|instagram\.com|twitter\.com|x\.com|facebook\.com|fb\.watch/i.test(url);
}

// ── Helper: instalar yt-dlp si no está ────────────────────────
function ensureYtDlp() {
  try {
    execSync("yt-dlp --version", { stdio: "ignore" });
    return true;
  } catch {
    try {
      console.log("Instalando yt-dlp...");
      execSync("pip install yt-dlp", { stdio: "inherit" });
      return true;
    } catch {
      try {
        execSync("pip3 install yt-dlp", { stdio: "inherit" });
        return true;
      } catch {
        return false;
      }
    }
  }
}

// ── Helper: descargar audio de URL ────────────────────────────
function downloadAudio(url, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `yt-dlp -x --audio-format mp3 --audio-quality 5 --no-playlist -o "${outputPath}" "${url}"`;
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error("No se pudo descargar el audio. Verifica que la URL sea válida y pública."));
      resolve(outputPath);
    });
  });
}

// ── Helper: prompt post-procesamiento ─────────────────────────
function buildPostPrompt(transcript, opts, lang, speakers) {
  const parts = [];
  if (opts.includes("transcripcion")) parts.push(`1. TRANSCRIPCIÓN COMPLETA:\n${transcript}`);
  if (opts.includes("resumen")) parts.push(`2. RESUMEN EJECUTIVO: Genera un resumen conciso en ${lang}.`);
  if (opts.includes("subtitulos")) parts.push(`3. SUBTÍTULOS SRT: Formato SRT numerado estimando tiempos. Máximo 2 líneas por bloque.`);
  if (opts.includes("puntos_clave")) parts.push(`4. PUNTOS CLAVE: Lista 5-10 takeaways en viñetas (•) en ${lang}.`);
  if (opts.includes("blog")) parts.push(`5. POST DE BLOG: Artículo completo con título, introducción, desarrollo y conclusión en ${lang}.`);

  const speakerNote = speakers === "1" ? "Hay un solo hablante."
    : speakers === "2" ? "Puede haber 2 hablantes; diferéncialos con [Persona 1] y [Persona 2]."
    : "Pueden haber varios hablantes; identifícalos como [Hablante 1], [Hablante 2], etc.";

  return `Eres un experto en procesamiento de transcripciones. ${speakerNote}
Idioma de salida: ${lang}.
Proporciona EXACTAMENTE las secciones pedidas con el encabezado en mayúsculas:

${parts.join("\n\n")}`;
}

// ── Helper: transcribir archivo con Groq ──────────────────────
async function transcribeFile(filePath, lang) {
  const audioStream = fs.createReadStream(filePath);
  const langCode = lang === "español" ? "es" : lang === "inglés" ? "en"
    : lang === "portugués" ? "pt" : lang === "francés" ? "fr"
    : lang === "alemán" ? "de" : undefined;

  const response = await groq.audio.transcriptions.create({
    file: audioStream,
    model: "whisper-large-v3",
    language: langCode,
    response_format: "text",
  });
  return response || "";
}

// ══════════════════════════════════════════════════════════════
//  RUTA: POST /api/transcribe — subida de archivo
// ══════════════════════════════════════════════════════════════
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo." });

    const { outputTypes, language, speakers } = req.body;
    const opts = outputTypes ? JSON.parse(outputTypes) : ["transcripcion"];
    const lang = language || "español";
    const spk = speakers || "1";

    console.log(`[ARCHIVO] ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(2)}MB)`);

    const rawTranscript = await transcribeFile(filePath, lang);
    if (!rawTranscript.trim()) {
      cleanup(filePath);
      return res.status(422).json({ error: "No se detectó voz en el archivo." });
    }

    if (opts.length === 1 && opts[0] === "transcripcion") {
      cleanup(filePath);
      return res.json({ result: rawTranscript.trim(), words: rawTranscript.trim().split(/\s+/).length });
    }

    const gptResponse = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: buildPostPrompt(rawTranscript, opts, lang, spk) }],
      max_tokens: 2000,
      temperature: 0.3,
    });

    const processed = gptResponse.choices[0]?.message?.content || rawTranscript;
    cleanup(filePath);
    return res.json({ result: processed.trim(), rawTranscript: rawTranscript.trim(), words: processed.trim().split(/\s+/).length });

  } catch (err) {
    cleanup(filePath);
    console.error("Error archivo:", err.message);
    if (err?.status === 401) return res.status(401).json({ error: "API Key de Groq inválida." });
    if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: `Archivo demasiado grande. Límite: ${MAX_MB}MB.` });
    return res.status(500).json({ error: "Error al procesar el archivo. " + (err.message || "") });
  }
});

// ══════════════════════════════════════════════════════════════
//  RUTA: POST /api/transcribe-url — YouTube/TikTok/Instagram
// ══════════════════════════════════════════════════════════════
app.post("/api/transcribe-url", express.json(), async (req, res) => {
  const { url, outputTypes, language, speakers } = req.body;
  const audioPath = path.join(uploadsDir, `url-${Date.now()}.mp3`);

  try {
    if (!url || !isSocialUrl(url)) {
      return res.status(400).json({ error: "URL no válida. Soportamos YouTube, TikTok, Instagram, X y Facebook." });
    }

    const opts = outputTypes || ["transcripcion"];
    const lang = language || "español";
    const spk = speakers || "1";

    console.log(`[URL] Descargando: ${url}`);

    const ytdlpOk = ensureYtDlp();
    if (!ytdlpOk) return res.status(500).json({ error: "No se pudo inicializar el descargador de videos." });

    await downloadAudio(url, audioPath);

    if (!fs.existsSync(audioPath)) {
      return res.status(422).json({ error: "No se pudo extraer el audio del video." });
    }

    console.log(`[URL] Audio descargado, transcribiendo...`);
    const rawTranscript = await transcribeFile(audioPath, lang);

    if (!rawTranscript.trim()) {
      cleanup(audioPath);
      return res.status(422).json({ error: "No se detectó voz en el video." });
    }

    if (opts.length === 1 && opts[0] === "transcripcion") {
      cleanup(audioPath);
      return res.json({ result: rawTranscript.trim(), words: rawTranscript.trim().split(/\s+/).length });
    }

    const gptResponse = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: buildPostPrompt(rawTranscript, opts, lang, spk) }],
      max_tokens: 2000,
      temperature: 0.3,
    });

    const processed = gptResponse.choices[0]?.message?.content || rawTranscript;
    cleanup(audioPath);
    return res.json({ result: processed.trim(), rawTranscript: rawTranscript.trim(), words: processed.trim().split(/\s+/).length });

  } catch (err) {
    cleanup(audioPath);
    console.error("Error URL:", err.message);
    return res.status(500).json({ error: err.message || "Error al procesar la URL." });
  }
});

// ── RUTA: GET /api/health ──────────────────────────────────────
app.get("/api/health", (req, res) => {
  let ytdlp = false;
  try { execSync("yt-dlp --version", { stdio: "ignore" }); ytdlp = true; } catch {}
  res.json({ status: "ok", groq: !!process.env.GROQ_API_KEY, ytdlp, maxFileMB: MAX_MB, timestamp: new Date().toISOString() });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`\n🎙️  Transcriptor IA corriendo en http://localhost:${PORT}`);
  console.log(`   Groq Key:   ${process.env.GROQ_API_KEY ? "✅ configurada" : "❌ falta en .env"}`);
  console.log(`   Tamaño max: ${MAX_MB}MB\n`);
  ensureYtDlp();
});
