const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 1024);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";
const STORAGE_ROOT = process.env.STORAGE_DIR || path.join(__dirname, "storage");
const DATA_FILE = path.join(STORAGE_ROOT, "documents.json");
const SETTINGS_FILE = path.join(STORAGE_ROOT, "site-settings.json");
const UPLOAD_DIR = path.join(STORAGE_ROOT, "uploads");

const BUCKET_NAME = process.env.BUCKET || "";
const BUCKET_ENDPOINT = process.env.ENDPOINT || "";
const BUCKET_REGION = process.env.REGION || "auto";
const BUCKET_ACCESS_KEY = process.env.ACCESS_KEY_ID || "";
const BUCKET_SECRET_KEY = process.env.SECRET_ACCESS_KEY || "";
const BUCKET_READY = Boolean(BUCKET_NAME && BUCKET_ENDPOINT && BUCKET_ACCESS_KEY && BUCKET_SECRET_KEY);
const s3 = BUCKET_READY ? new S3Client({
  region: BUCKET_REGION,
  endpoint: BUCKET_ENDPOINT,
  credentials: { accessKeyId: BUCKET_ACCESS_KEY, secretAccessKey: BUCKET_SECRET_KEY }
}) : null;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");

const DEFAULT_SETTINGS = {
  announcement: {
    enabled: true,
    title: "置顶公告",
    content: "欢迎使用人民邮电出版社工具包。"
  },
  submission: {
    enabled: true,
    title: "投稿邮箱",
    email: "",
    content: "投稿前请确认作品及资料完整，并按照要求发送至指定邮箱。"
  }
};
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf8");
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12
  }
}));

async function ensureBucketCors() {
  if (!BUCKET_READY) return;
  try {
    await s3.send(new PutBucketCorsCommand({
      Bucket: BUCKET_NAME,
      CORSConfiguration: {
        CORSRules: [{
          AllowedHeaders: ["*"],
          AllowedMethods: ["GET", "HEAD", "PUT"],
          AllowedOrigins: ["*"],
          ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
          MaxAgeSeconds: 3600
        }]
      }
    }));
    console.log("Bucket CORS 已就绪");
  } catch (err) {
    console.warn("Bucket CORS 自动配置未完成：", err?.message || err);
  }
}
ensureBucketCors();

function readDocs() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function writeDocs(docs) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(docs, null, 2), "utf8");
}
function readSettings() {
  try {
    const current = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return {
      announcement: { ...DEFAULT_SETTINGS.announcement, ...(current.announcement || {}) },
      submission: { ...DEFAULT_SETTINGS.submission, ...(current.submission || {}) }
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}
function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
}
function clean(v, max = 500) {
  return String(v ?? "").trim().slice(0, max);
}
function safeOriginalName(name) {
  return path.basename(String(name || "file")).replace(/[\r\n"]/g, "_").slice(0, 240);
}
function validHttpUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    return (u.protocol === "http:" || u.protocol === "https:") ? u.toString() : null;
  } catch {
    return null;
  }
}
function adminOnly(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(401).json({ error: "未登录或登录已过期" });
}
function toBool(v, fallback = false) {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}
function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function isoDate(v, fallback = new Date().toISOString()) {
  if (!v) return fallback;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : fallback;
}
function normalizeDoc(d) {
  const kind = d.kind || (d.url ? "link" : "file");
  return {
    ...d,
    kind,
    visible: d.visible !== false,
    pinned: Boolean(d.pinned),
    recommended: Boolean(d.recommended),
    sortOrder: toNumber(d.sortOrder, 0),
    version: clean(d.version, 40),
    updatedAt: d.updatedAt || d.createdAt || "",
    downloads: toNumber(d.downloads, 0)
  };
}
function sortDocs(a0, b0) {
  const a = normalizeDoc(a0), b = normalizeDoc(b0);
  let diff = Number(b.pinned) - Number(a.pinned);
  if (diff) return diff;
  diff = Number(b.recommended) - Number(a.recommended);
  if (diff) return diff;
  diff = b.sortOrder - a.sortOrder;
  if (diff) return diff;
  return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
}

const allowed = new Set([
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
  ".zip", ".rar", ".7z", ".txt",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4"
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, Date.now() + "-" + crypto.randomBytes(4).toString("hex") + ext);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.has(ext) ? cb(null, true) : cb(new Error("不支持该文件类型"));
  }
});

function mimeFor(name = "") {
  const ext = path.extname(name).toLowerCase();
  return ({
    ".pdf":"application/pdf", ".txt":"text/plain; charset=utf-8",
    ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg",
    ".webp":"image/webp", ".gif":"image/gif", ".mp4":"video/mp4",
    ".doc":"application/msword",
    ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".ppt":"application/vnd.ms-powerpoint",
    ".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xls":"application/vnd.ms-excel",
    ".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  })[ext] || "application/octet-stream";
}
function previewMode(name = "") {
  const ext = path.extname(name).toLowerCase();
  if ([".pdf", ".txt"].includes(ext)) return "frame";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if (ext === ".mp4") return "video";
  if ([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"].includes(ext)) return "office";
  return "unsupported";
}

const css = `
:root{
  --bg:#f6f8fc;--surface:#fff;--surface2:#f9fbff;--text:#172033;--muted:#667085;
  --line:#e4e9f2;--blue:#2457d6;--blue2:#5b7ff2;--ink:#11254a;--soft:#eef4ff;
  --gold:#a96f17;--danger:#c7362f;--ok:#0b7a55;--shadow:0 18px 60px rgba(31,56,103,.08)
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:var(--text);background:linear-gradient(180deg,#f8faff 0,#f5f7fb 62%,#f7f8fa 100%)}
a{text-decoration:none;color:inherit}
button,input,textarea,select{font:inherit}
button{cursor:pointer}
.wrap{width:min(1220px,calc(100% - 34px));margin:auto}
.nav{height:76px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(228,233,242,.9)}
.brand{display:flex;align-items:center;gap:12px;font-weight:850;letter-spacing:.2px;color:var(--ink)}
.logo{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;color:#fff;font-size:13px;font-weight:900;background:linear-gradient(135deg,#173f9b,#4d74e6);box-shadow:0 8px 22px rgba(36,87,214,.25)}
.nav-meta{font-size:12px;color:#7b8495}
.hero{padding:72px 0 38px;text-align:center;position:relative}
.hero:before{content:"";position:absolute;left:50%;top:10px;width:760px;height:300px;transform:translateX(-50%);background:radial-gradient(circle,rgba(69,109,226,.12),transparent 67%);pointer-events:none}
.kicker{position:relative;display:inline-flex;gap:8px;align-items:center;padding:8px 12px;border:1px solid #dbe4f7;border-radius:999px;background:rgba(255,255,255,.86);font-size:13px;color:#51627f}
.hero h1{position:relative;font-size:clamp(40px,6vw,66px);line-height:1.08;margin:18px auto 14px;color:#10224a;letter-spacing:-1.6px}
.hero p{position:relative;max-width:720px;margin:0 auto;color:var(--muted);line-height:1.9;font-size:16px}
.search-box{position:relative;max-width:850px;margin:30px auto 0;display:grid;grid-template-columns:1fr 190px;gap:10px}
.search-box input,.search-box select,input,textarea,select{width:100%;border:1px solid #d6deeb;border-radius:13px;padding:13px 14px;background:#fff;outline:none;color:var(--text)}
.search-box input{box-shadow:0 12px 36px rgba(30,62,120,.08)}
input:focus,textarea:focus,select:focus{border-color:#7e9ae8;box-shadow:0 0 0 4px rgba(36,87,214,.08)}
.stats{display:flex;justify-content:center;gap:28px;margin:20px 0 0;color:#707b8f;font-size:13px}.stats b{color:#243b67}
.section{padding:22px 0}.section-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:16px}.section-head h2{margin:0;color:#152a52;font-size:25px}.section-head p{margin:4px 0 0;color:var(--muted);font-size:13px}
.flow-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}
.flow-card{border:1px solid var(--line);background:rgba(255,255,255,.92);border-radius:18px;padding:18px 15px;box-shadow:0 12px 38px rgba(31,56,103,.05);transition:.2s;cursor:pointer;min-height:132px}
.flow-card:hover,.flow-card.active{transform:translateY(-3px);border-color:#b8c8ef;box-shadow:0 18px 45px rgba(31,56,103,.11);background:#fff}
.step{font-size:11px;font-weight:800;color:#5570b7;letter-spacing:.8px}.flow-card h3{margin:9px 0 7px;font-size:16px;color:#1a315f}.flow-card p{margin:0;color:#7a8495;font-size:12px;line-height:1.55}
.notice-board{margin:16px 0 12px;padding:16px 18px;border:1px solid #e6d5a5;background:#fffdf6;border-radius:16px;display:flex;gap:13px;align-items:flex-start}.notice-board b{color:#71531a}.notice-board div:last-child{color:#756a53;font-size:13px;line-height:1.7;white-space:pre-wrap}
.submission-box{margin:0 0 12px;padding:18px;border:1px solid var(--line);background:#fff;border-radius:16px;display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center}.submission-box h3{margin:0 0 5px;font-size:16px}.submission-box p{margin:0;color:var(--muted);font-size:13px;line-height:1.7;white-space:pre-wrap}.email-link{padding:10px 14px;border:1px solid #cbd8f8;border-radius:11px;background:#f4f7ff;color:#2c56bf;font-weight:700}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.card{position:relative;display:flex;flex-direction:column;min-height:292px;padding:20px;border:1px solid var(--line);border-radius:20px;background:#fff;box-shadow:var(--shadow);overflow:hidden}
.card:before{content:"";position:absolute;right:-28px;top:-42px;width:120px;height:120px;border-radius:50%;background:radial-gradient(circle,rgba(66,101,207,.08),transparent 70%)}
.card-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.file-icon{width:48px;height:48px;border-radius:14px;background:#eef4ff;color:#325ac2;font-size:12px;font-weight:900;display:grid;place-items:center}.badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.badge{display:inline-flex;align-items:center;padding:5px 8px;border-radius:999px;background:#f1f4f8;color:#5e6879;font-size:11px;font-weight:700}.badge.pin{background:#fff5dc;color:#8f631a}.badge.rec{background:#edf2ff;color:#3557b7}.badge.new{background:#eaf8f0;color:#16724d}.badge.ver{background:#f8f1ff;color:#7149a6}
.card h3{margin:17px 0 8px;font-size:18px;line-height:1.45;color:#172d55}.desc{color:#697488;font-size:13px;line-height:1.72;min-height:46px}.meta{display:flex;gap:9px;flex-wrap:wrap;margin-top:auto;padding-top:18px;color:#929bad;font-size:11px}.actions-row{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px}.actions-row.one{grid-template-columns:1fr}.btn,.btn2{border:0;border-radius:11px;padding:11px 13px;font-weight:750;text-align:center}.btn{background:linear-gradient(135deg,#214fae,#5275dc);color:#fff}.btn2{background:#f4f7fc;color:#3b4c6d;border:1px solid #dfe6f0}.btn:hover{filter:brightness(.98)}
.empty{grid-column:1/-1;padding:48px;text-align:center;border:1px dashed #cfd8e8;border-radius:18px;color:#7a8495;background:#fff}
.hidden{display:none!important}
.footer{padding:48px 0 28px;color:#8a93a3;font-size:12px;text-align:center}.admin-link{opacity:.45;margin-left:12px}.admin-link:hover{opacity:1}

/* admin */
.admin{width:min(1120px,calc(100% - 34px));margin:34px auto 70px}.panel{background:#fff;border:1px solid var(--line);border-radius:20px;padding:22px;margin-bottom:18px;box-shadow:var(--shadow)}.login{max-width:450px;margin:12vh auto}.admin-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:18px}.admin-head h1{margin:0;color:#14294e}.admin-head p{margin:6px 0 0;color:var(--muted);font-size:13px}.form{display:grid;grid-template-columns:1fr 1fr;gap:14px}.full{grid-column:1/-1}label{display:block;font-size:12px;color:#536078;margin-bottom:7px;font-weight:650}textarea{min-height:96px;resize:vertical}.notice{font-size:12px;color:var(--muted)}.err{font-size:12px;color:var(--danger);margin-left:8px}.ok{font-size:12px;color:var(--ok);margin-left:8px}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.settings-card{padding:18px;border:1px solid var(--line);border-radius:16px;background:#fbfcff}.switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.check-line{display:flex;align-items:center;gap:8px;margin:0;color:#556176;font-size:13px}.check-line input{width:17px;height:17px}.admin-list{display:flex;flex-direction:column;gap:10px;margin-top:14px}.item{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center;padding:16px;border:1px solid var(--line);border-radius:15px;background:#fff}.item h3{margin:0 0 6px;font-size:15px}.item-meta{display:flex;gap:8px;flex-wrap:wrap;color:#8a93a3;font-size:11px}.admin-desc{margin-top:7px;color:#667085;font-size:12px;line-height:1.6}.item-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.mini{border:1px solid #dde4ef;background:#fff;border-radius:9px;padding:7px 9px;color:#4c5870;font-size:12px}.mini.primary{background:#f2f6ff;border-color:#cbd8f8;color:#2853b6}.mini.warn{background:#fff9ed;border-color:#eed9ad;color:#8b641f}.mini.danger{color:#bf3934}.progress{height:7px;background:#edf1f7;border-radius:99px;overflow:hidden;margin-top:9px}.progress>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2758c6,#6687e7);transition:width .15s}
.modal-mask{position:fixed;inset:0;background:rgba(17,30,55,.5);backdrop-filter:blur(5px);display:grid;place-items:center;padding:20px;z-index:999}.modal{width:min(720px,100%);max-height:92vh;overflow:auto;background:#fff;border-radius:22px;padding:24px;box-shadow:0 34px 100px rgba(10,26,54,.28)}.modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.modal-head h2{margin:0}.close-btn{width:36px;height:36px;border:1px solid var(--line);border-radius:10px;background:#fff;font-size:20px}.modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}.secondary{border:1px solid var(--line);background:#fff;border-radius:11px;padding:11px 15px;color:#48556e}.file-lock{padding:11px 13px;border:1px solid var(--line);background:#f7f9fc;border-radius:11px;color:#697488;font-size:12px}
.preview-shell{min-height:100vh;display:flex;flex-direction:column;background:#eef2f7}.preview-bar{height:64px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 20px;gap:14px}.preview-bar b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.preview-area{flex:1;display:grid;place-items:center;padding:18px}.preview-frame{width:100%;height:calc(100vh - 100px);border:0;border-radius:12px;background:#fff}.preview-img{max-width:min(1200px,96vw);max-height:calc(100vh - 110px);object-fit:contain;border-radius:10px;box-shadow:var(--shadow)}.preview-video{width:min(1200px,96vw);max-height:calc(100vh - 110px);background:#111;border-radius:12px}.preview-empty{max-width:620px;text-align:center;background:#fff;border:1px solid var(--line);border-radius:18px;padding:36px;box-shadow:var(--shadow)}
@media(max-width:980px){.flow-grid{grid-template-columns:repeat(3,1fr)}.grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:680px){.nav-meta{display:none}.hero{padding-top:48px}.search-box,.form,.settings-grid{grid-template-columns:1fr}.flow-grid{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.submission-box{grid-template-columns:1fr}.item{grid-template-columns:1fr}.item-actions{justify-content:flex-start}.full{grid-column:auto}.admin-head{flex-direction:column}.stats{gap:14px;flex-wrap:wrap}.section-head{align-items:flex-start;flex-direction:column}}
`;

const processSteps = [
  { n:"01", title:"剧本与小说", desc:"原创剧本、小说改编、剧本提示词", tokens:"剧本 小说 原创 改编" },
  { n:"02", title:"分镜脚本", desc:"镜头拆解、画面描述、分镜提示词", tokens:"分镜 脚本 镜头" },
  { n:"03", title:"角色与场景", desc:"人物、场景、三视图、一致性素材", tokens:"角色 人物 场景 三视图 一致性" },
  { n:"04", title:"视频生成", desc:"生视频工具、图生视频、视频提示词", tokens:"视频 生视频 图生视频" },
  { n:"05", title:"配音与音效", desc:"角色音色、旁白、配音与声音素材", tokens:"配音 音色 音效 旁白" },
  { n:"06", title:"剪辑后期", desc:"剪辑、字幕、包装、成片输出", tokens:"剪辑 后期 字幕 包装" }
];

const homeHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>人民邮电出版社工具包</title><style>${css}</style></head>
<body>
<div class="wrap">
  <nav class="nav">
    <div class="brand"><span class="logo">P&T</span><div>人民邮电出版社工具包<div class="nav-meta">AI漫剧课程配套资料与制作工具</div></div></div>
  </nav>

  <header class="hero">
    <span class="kicker">课程资料 · 提示词 · 模板 · AI工具</span>
    <h1>人民邮电出版社工具包</h1>
    <p>围绕 AI 漫剧完整制作流程，集中管理课程资料、提示词模板、工具入口与配套资源。需要什么，直接搜索或按制作步骤查找。</p>
    <div class="search-box">
      <input id="q" placeholder="搜索资料、提示词、模板、工具……">
      <select id="cat"><option value="">全部分类</option></select>
    </div>
    <div class="stats"><span>资源 <b id="statTotal">0</b> 项</span><span>文件 <b id="statFiles">0</b> 份</span><span>工具链接 <b id="statLinks">0</b> 个</span><span>持续更新</span></div>
  </header>

  <section class="section">
    <div class="section-head"><div><h2>按 AI 漫剧制作流程查找</h2><p>从剧本到后期，点击对应步骤快速筛选资料。</p></div><button id="clearFlow" class="btn2 hidden">清除流程筛选</button></div>
    <div class="flow-grid" id="flowGrid">
      ${processSteps.map(s=>`<button class="flow-card" data-tokens="${s.tokens}"><span class="step">STEP ${s.n}</span><h3>${s.title}</h3><p>${s.desc}</p></button>`).join("")}
    </div>
  </section>

  <section id="announcementBox" class="notice-board hidden"><span>📌</span><div><b id="announcementTitle">置顶公告</b><div id="announcementContent"></div></div></section>
  <section id="submissionBox" class="submission-box hidden"><div><h3 id="submissionTitle">投稿邮箱</h3><p id="submissionContent"></p></div><a id="submissionEmail" class="email-link"></a></section>

  <section id="featuredSection" class="section hidden">
    <div class="section-head"><div><h2>推荐资源</h2><p>优先展示课程中最常用、最值得先看的内容。</p></div></div>
    <div class="grid" id="featuredGrid"></div>
  </section>

  <section id="resourceSection" class="section">
    <div class="section-head"><div><h2>全部资料与工具</h2><p id="filterText">按更新时间与后台排序展示</p></div><span id="count" class="notice"></span></div>
    <main class="grid" id="grid"></main>
  </section>
</div>
<footer class="footer">人民邮电出版社工具包 · AI漫剧课程配套资源 <a class="admin-link" href="/admin.html">管理</a></footer>
<script>
let docs=[];let activeTokens=[];
const E=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
function sz(b=0){b=Number(b||0);if(b<1024)return b+" B";if(b<1048576)return (b/1024).toFixed(1)+" KB";if(b<1073741824)return (b/1048576).toFixed(1)+" MB";return (b/1073741824).toFixed(2)+" GB"}
function fmtDate(v){if(!v)return "";const d=new Date(v);if(!Number.isFinite(d.getTime()))return "";return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
function isNew(d){const t=new Date(d.updatedAt||d.createdAt||0).getTime();return t&&Date.now()-t<7*86400000}
function card(d){
  const isLink=d.kind==="link";const meta=[];
  if(d.version)meta.push("版本 "+E(d.version));
  if(!isLink&&d.size)meta.push(sz(d.size));
  meta.push((isLink?"访问 ":"下载 ")+Number(d.downloads||0)+" 次");
  if(d.updatedAt||d.createdAt)meta.push("更新 "+fmtDate(d.updatedAt||d.createdAt));
  let badges='';
  if(d.pinned)badges+='<span class="badge pin">置顶</span>';
  if(d.recommended)badges+='<span class="badge rec">推荐</span>';
  if(isNew(d))badges+='<span class="badge new">NEW</span>';
  badges+='<span class="badge">'+E(d.category||"其他资料")+'</span>';
  const action=isLink
    ? '<div class="actions-row one"><a class="btn" target="_blank" rel="noopener noreferrer" href="/go/'+encodeURIComponent(d.id)+'">立即前往</a></div>'
    : '<div class="actions-row"><a class="btn2" target="_blank" href="/preview/'+encodeURIComponent(d.id)+'">在线预览</a><a class="btn" href="/download/'+encodeURIComponent(d.id)+'">立即下载</a></div>';
  return '<article class="card"><div class="card-top"><div class="file-icon">'+(isLink?'LINK':E(d.type||'FILE'))+'</div><div class="badges">'+badges+'</div></div><h3>'+E(d.title)+'</h3><div class="desc">'+E(d.description||"课程配套学习资料")+'</div><div class="meta">'+meta.map(x=>'<span>'+x+'</span>').join('')+'</div>'+action+'</article>';
}
function matchesProcess(d){if(!activeTokens.length)return true;const text=((d.title||"")+" "+(d.category||"")+" "+(d.description||"")).toLowerCase();return activeTokens.some(t=>text.includes(t))}
function render(){
  const q=document.getElementById("q").value.toLowerCase().trim();const c=document.getElementById("cat").value;
  const arr=docs.filter(d=>{const text=((d.title||"")+" "+(d.description||"")+" "+(d.category||"")+" "+(d.version||"")).toLowerCase();return (!q||text.includes(q))&&(!c||d.category===c)&&matchesProcess(d)});
  document.getElementById("count").textContent="共 "+arr.length+" 项";
  document.getElementById("filterText").textContent=activeTokens.length?"已按制作流程筛选，可继续使用搜索或分类缩小范围":"按更新时间与后台排序展示";
  document.getElementById("grid").innerHTML=arr.length?arr.map(card).join(""):'<div class="empty">没有找到匹配的资料或工具</div>';
}
function renderFeatured(){const arr=docs.filter(d=>d.recommended).slice(0,6);const sec=document.getElementById("featuredSection");if(!arr.length){sec.classList.add("hidden");return}document.getElementById("featuredGrid").innerHTML=arr.map(card).join("");sec.classList.remove("hidden")}
fetch("/api/site-settings").then(r=>r.json()).then(s=>{const a=s.announcement||{};if(a.enabled&&(a.title||a.content)){document.getElementById("announcementTitle").textContent=a.title||"置顶公告";document.getElementById("announcementContent").textContent=a.content||"";document.getElementById("announcementBox").classList.remove("hidden")}const sub=s.submission||{};if(sub.enabled&&(sub.email||sub.content)){document.getElementById("submissionTitle").textContent=sub.title||"投稿邮箱";document.getElementById("submissionContent").textContent=sub.content||"";const e=document.getElementById("submissionEmail");e.textContent=sub.email||"邮箱暂未设置";if(sub.email)e.href="mailto:"+encodeURIComponent(sub.email);document.getElementById("submissionBox").classList.remove("hidden")}}).catch(()=>{});
fetch("/api/documents").then(r=>r.json()).then(x=>{docs=x;document.getElementById("statTotal").textContent=docs.length;document.getElementById("statFiles").textContent=docs.filter(d=>d.kind!=="link").length;document.getElementById("statLinks").textContent=docs.filter(d=>d.kind==="link").length;const cs=[...new Set(docs.map(d=>d.category).filter(Boolean))];document.getElementById("cat").innerHTML='<option value="">全部分类</option>'+cs.map(c=>'<option>'+E(c)+'</option>').join("");renderFeatured();render()});
document.getElementById("q").oninput=render;document.getElementById("cat").onchange=render;
document.querySelectorAll(".flow-card").forEach(btn=>btn.onclick=()=>{document.querySelectorAll(".flow-card").forEach(x=>x.classList.remove("active"));btn.classList.add("active");activeTokens=btn.dataset.tokens.toLowerCase().split(/\s+/).filter(Boolean);document.getElementById("clearFlow").classList.remove("hidden");render();document.getElementById("resourceSection").scrollIntoView({behavior:"smooth",block:"start"})});
document.getElementById("clearFlow").onclick=()=>{activeTokens=[];document.querySelectorAll(".flow-card").forEach(x=>x.classList.remove("active"));document.getElementById("clearFlow").classList.add("hidden");render()};
</script></body></html>`;

const adminHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>人民邮电出版社工具包｜资料管理后台</title><style>${css}</style></head>
<body><div class="admin">
<section id="login" class="panel login"><div class="brand"><span class="logo">P&T</span>人民邮电出版社工具包后台</div><h1>管理员登录</h1><p class="notice">登录后可上传、编辑、置顶、推荐、排序和管理资料。</p><form id="lf"><input id="pw" type="password" placeholder="管理员密码" required><button class="btn" style="width:100%;margin-top:12px">登录后台</button><div id="lm"></div></form></section>
<div id="main" class="hidden">
  <div class="admin-head"><div><h1>资料管理</h1><p>保留现有 Bucket 大文件直传，同时新增置顶、推荐、排序、版本与更新时间管理。</p></div><div class="item-actions"><a class="mini primary" href="/" target="_blank">查看前台</a><button id="lo" class="mini">退出</button></div></div>

  <section class="panel"><div class="section-head"><div><h2>页面信息设置</h2><p>公告与投稿邮箱会直接显示在首页。</p></div></div><div class="settings-grid">
    <form id="announcementForm" class="settings-card"><div class="switch-row"><strong>置顶公告</strong><label class="check-line"><input id="announcementEnabled" type="checkbox">前台显示</label></div><label>公告标题</label><input id="announcementTitleInput" placeholder="例如：重要通知"><label style="margin-top:12px">公告内容</label><textarea id="announcementContentInput"></textarea><div style="margin-top:12px"><button class="btn" type="submit">保存公告</button><span id="announcementMsg"></span></div></form>
    <form id="submissionForm" class="settings-card"><div class="switch-row"><strong>投稿邮箱</strong><label class="check-line"><input id="submissionEnabled" type="checkbox">前台显示</label></div><label>板块标题</label><input id="submissionTitleInput" placeholder="投稿邮箱"><label style="margin-top:12px">投稿邮箱地址</label><input id="submissionEmailInput" type="email" placeholder="example@email.com"><label style="margin-top:12px">投稿说明</label><textarea id="submissionContentInput"></textarea><div style="margin-top:12px"><button class="btn" type="submit">保存投稿信息</button><span id="submissionMsg"></span></div></form>
  </div></section>

  <section class="panel"><div class="section-head"><div><h2>上传新资料</h2><p>支持 Bucket 直传并显示实时上传进度。</p></div></div><form id="uf" class="form">
    <div><label>文档名称</label><input name="title" required></div><div><label>分类</label><input name="category" list="categoryOptions" required></div>
    <div><label>版本</label><input name="version" placeholder="例如 V1.0"></div><div><label>排序权重</label><input name="sortOrder" type="number" value="0"><div class="notice">数值越大越靠前</div></div>
    <div class="full"><label>简介</label><textarea name="description" placeholder="填写这份资料的介绍"></textarea></div>
    <div class="full"><label>选择文件</label><input name="file" type="file" required><p class="notice">支持 PDF、Word、PPT、Excel、压缩包、TXT、图片、MP4；单文件最大 ${MAX_UPLOAD_MB}MB。大文件直接上传到 Bucket。</p></div>
    <div><label class="check-line"><input name="pinned" type="checkbox">置顶</label></div><div><label class="check-line"><input name="recommended" type="checkbox">推荐资源</label></div>
    <div class="full"><button class="btn">上传并发布</button><span id="um"></span><div id="uploadProgress" class="progress hidden"><i></i></div></div>
  </form></section>

  <section class="panel"><div class="section-head"><div><h2>添加直达链接</h2><p>适合 AI 工具平台、教程页、网盘或其他外部资源。</p></div><span class="badge rec">LINK</span></div><form id="linkForm" class="form">
    <div><label>链接名称</label><input name="title" required></div><div><label>分类</label><input name="category" list="categoryOptions" required></div>
    <div><label>版本</label><input name="version" placeholder="可选"></div><div><label>排序权重</label><input name="sortOrder" type="number" value="0"></div>
    <div class="full"><label>简介</label><textarea name="description"></textarea></div><div class="full"><label>直达网址</label><input name="url" type="url" placeholder="https://..." required></div>
    <div><label class="check-line"><input name="pinned" type="checkbox">置顶</label></div><div><label class="check-line"><input name="recommended" type="checkbox">推荐资源</label></div>
    <div class="full"><button class="btn" type="submit">发布直达链接</button><span id="linkMsg"></span></div>
  </form></section>

  <section class="panel"><div class="section-head"><div><h2>已上传资料</h2><p>可直接编辑资料信息、推荐状态、排序、版本和更新时间。</p></div><span id="ct" class="notice"></span></div><div id="list" class="admin-list"></div></section>
</div></div>
<datalist id="categoryOptions"><option>剧本与小说</option><option>分镜脚本</option><option>角色与场景</option><option>视频生成</option><option>配音与音效</option><option>剪辑后期</option><option>AI工具</option><option>课程资料</option><option>商业变现</option></datalist>

<div id="editMask" class="modal-mask hidden"><div class="modal"><div class="modal-head"><h2>编辑资料</h2><button id="editClose" class="close-btn" type="button">×</button></div><form id="editForm" class="form"><input id="editId" type="hidden">
  <div><label>名称</label><input id="editTitle" required></div><div><label>分类</label><input id="editCategory" list="categoryOptions" required></div>
  <div><label>版本</label><input id="editVersion" placeholder="例如 V2.1"></div><div><label>排序权重</label><input id="editSortOrder" type="number"><div class="notice">数值越大越靠前</div></div>
  <div class="full"><label>简介</label><textarea id="editDescription"></textarea></div>
  <div id="editFileBlock" class="full"><label>当前文件</label><div id="editFileName" class="file-lock"></div><div class="notice" style="margin-top:6px">修改资料信息不会重新上传原文件。</div></div>
  <div id="editLinkBlock" class="full hidden"><label>直达网址</label><input id="editUrl" type="url"></div>
  <div><label class="check-line"><input id="editPinned" type="checkbox">置顶</label><label class="check-line" style="margin-top:10px"><input id="editRecommended" type="checkbox">推荐资源</label></div>
  <div><label class="check-line"><input id="editVisible" type="checkbox">前台显示</label><label style="margin-top:10px">更新时间</label><input id="editUpdatedAt" type="datetime-local"><button id="useNow" class="mini" style="margin-top:7px" type="button">使用当前时间</button></div>
  <div id="editMsg" class="full"></div><div class="modal-actions full"><button id="editCancel" class="secondary" type="button">取消</button><button class="btn" type="submit">保存修改</button></div>
</form></div></div>
<script>
const E=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));let adminDocs=[];
function fmt(v){if(!v)return "未设置";const d=new Date(v);return Number.isFinite(d.getTime())?d.toLocaleString("zh-CN",{hour12:false}):"未设置"}
function toLocalInput(v){const d=v?new Date(v):new Date();if(!Number.isFinite(d.getTime()))return "";const z=n=>String(n).padStart(2,"0");return d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate())+"T"+z(d.getHours())+":"+z(d.getMinutes())}
async function auth(){const d=await fetch("/api/me").then(r=>r.json());document.getElementById("login").classList.toggle("hidden",d.isAdmin);document.getElementById("main").classList.toggle("hidden",!d.isAdmin);if(d.isAdmin){load();loadSiteSettings()}}
document.getElementById("lf").onsubmit=async e=>{e.preventDefault();const m=document.getElementById("lm");m.className="notice";m.textContent="正在登录...";try{const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("pw").value})});const d=await r.json();if(r.ok){m.className="ok";m.textContent="登录成功";auth()}else{m.className="err";m.textContent=d.error||"登录失败"}}catch{m.className="err";m.textContent="登录请求失败"}};
document.getElementById("lo").onclick=async()=>{await fetch("/api/logout",{method:"POST"});auth()};
async function loadSiteSettings(){try{const s=await fetch("/api/admin/site-settings").then(r=>r.json());const a=s.announcement||{},sub=s.submission||{};document.getElementById("announcementEnabled").checked=!!a.enabled;document.getElementById("announcementTitleInput").value=a.title||"";document.getElementById("announcementContentInput").value=a.content||"";document.getElementById("submissionEnabled").checked=!!sub.enabled;document.getElementById("submissionTitleInput").value=sub.title||"";document.getElementById("submissionEmailInput").value=sub.email||"";document.getElementById("submissionContentInput").value=sub.content||""}catch{}}
async function patchSettings(payload,msgId){const m=document.getElementById(msgId);m.className="notice";m.textContent=" 保存中...";try{const r=await fetch("/api/admin/site-settings",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const d=await r.json().catch(()=>({}));m.className=r.ok?"ok":"err";m.textContent=r.ok?" 保存成功":" "+(d.error||"保存失败")}catch{m.className="err";m.textContent=" 保存请求失败"}}
document.getElementById("announcementForm").onsubmit=e=>{e.preventDefault();patchSettings({announcement:{enabled:document.getElementById("announcementEnabled").checked,title:document.getElementById("announcementTitleInput").value,content:document.getElementById("announcementContentInput").value}},"announcementMsg")};
document.getElementById("submissionForm").onsubmit=e=>{e.preventDefault();patchSettings({submission:{enabled:document.getElementById("submissionEnabled").checked,title:document.getElementById("submissionTitleInput").value,email:document.getElementById("submissionEmailInput").value,content:document.getElementById("submissionContentInput").value}},"submissionMsg")};

document.getElementById("uf").onsubmit=async e=>{e.preventDefault();const form=e.target,m=document.getElementById("um"),prog=document.getElementById("uploadProgress"),bar=prog.querySelector("i"),fd=new FormData(form),file=fd.get("file");if(!file||!file.name){m.className="err";m.textContent=" 请选择文件";return}m.className="notice";m.textContent=" 正在准备上传...";prog.classList.remove("hidden");bar.style.width="0%";try{const pre=await fetch("/api/admin/uploads/presign",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:file.name,size:file.size,contentType:file.type||"application/octet-stream"})});const p=await pre.json().catch(()=>({}));if(!pre.ok)throw new Error(p.error||"无法准备上传");await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open("PUT",p.uploadUrl,true);if(file.type)xhr.setRequestHeader("Content-Type",file.type);xhr.upload.onprogress=ev=>{if(ev.lengthComputable){const pct=Math.round(ev.loaded/ev.total*100);bar.style.width=pct+"%";m.textContent=" 正在上传 "+pct+"%"}};xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error("Bucket 上传失败，HTTP "+xhr.status));xhr.onerror=()=>reject(new Error("网络上传失败"));xhr.send(file)});m.textContent=" 正在保存资料信息...";const done=await fetch("/api/admin/uploads/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:p.key,title:fd.get("title"),category:fd.get("category"),description:fd.get("description"),version:fd.get("version"),sortOrder:fd.get("sortOrder"),pinned:fd.get("pinned")!==null,recommended:fd.get("recommended")!==null,originalName:file.name,type:(file.name.split(".").pop()||"FILE").toUpperCase(),size:file.size})});const d=await done.json().catch(()=>({}));if(!done.ok)throw new Error(d.error||"保存失败");m.className="ok";m.textContent=" 上传成功";bar.style.width="100%";form.reset();setTimeout(()=>prog.classList.add("hidden"),700);load()}catch(err){m.className="err";m.textContent=" "+(err.message||"上传失败");prog.classList.add("hidden")}};

document.getElementById("linkForm").onsubmit=async e=>{e.preventDefault();const m=document.getElementById("linkMsg"),fd=new FormData(e.target);m.className="notice";m.textContent=" 正在发布...";try{const r=await fetch("/api/admin/links",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:fd.get("title"),category:fd.get("category"),description:fd.get("description"),url:fd.get("url"),version:fd.get("version"),sortOrder:fd.get("sortOrder"),pinned:fd.get("pinned")!==null,recommended:fd.get("recommended")!==null})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"发布失败");m.className="ok";m.textContent=" 发布成功";e.target.reset();load()}catch(err){m.className="err";m.textContent=" "+err.message}};

async function load(){const r=await fetch("/api/admin/documents");if(r.status===401)return auth();adminDocs=await r.json();document.getElementById("ct").textContent="共 "+adminDocs.length+" 项";document.getElementById("list").innerHTML=adminDocs.length?adminDocs.map(d=>{let badges='';if(d.pinned)badges+='<span class="badge pin">置顶</span>';if(d.recommended)badges+='<span class="badge rec">推荐</span>';if(d.visible===false)badges+='<span class="badge">已隐藏</span>';if(d.version)badges+='<span class="badge ver">'+E(d.version)+'</span>';return '<div class="item"><div><h3>'+E(d.title)+' '+badges+'</h3><div class="item-meta"><span>'+E(d.category||"其他资料")+'</span><span>排序 '+Number(d.sortOrder||0)+'</span><span>'+(d.kind==="link"?'访问 ':'下载 ')+Number(d.downloads||0)+' 次</span><span>更新 '+E(fmt(d.updatedAt||d.createdAt))+'</span></div><div class="admin-desc">'+E(d.description||"")+'</div></div><div class="item-actions"><button class="mini primary" onclick="editD(\''+d.id+'\')">编辑</button><button class="mini" onclick="moveD(\''+d.id+'\',10)">上移</button><button class="mini" onclick="moveD(\''+d.id+'\',-10)">下移</button><button class="mini warn" onclick="pinD(\''+d.id+'\','+!!d.pinned+')">'+(d.pinned?'取消置顶':'置顶')+'</button><button class="mini" onclick="recD(\''+d.id+'\','+!!d.recommended+')">'+(d.recommended?'取消推荐':'推荐')+'</button><button class="mini" onclick="visD(\''+d.id+'\','+(d.visible!==false)+')">'+(d.visible===false?'显示':'隐藏')+'</button><button class="mini danger" onclick="delD(\''+d.id+'\')">删除</button></div></div>'}).join(""):'<div class="empty">还没有资料</div>'}
window.editD=id=>{const d=adminDocs.find(x=>x.id===id);if(!d)return;document.getElementById("editId").value=id;document.getElementById("editTitle").value=d.title||"";document.getElementById("editCategory").value=d.category||"";document.getElementById("editVersion").value=d.version||"";document.getElementById("editSortOrder").value=Number(d.sortOrder||0);document.getElementById("editDescription").value=d.description||"";document.getElementById("editPinned").checked=!!d.pinned;document.getElementById("editRecommended").checked=!!d.recommended;document.getElementById("editVisible").checked=d.visible!==false;document.getElementById("editUpdatedAt").value=toLocalInput(d.updatedAt||d.createdAt);const isLink=d.kind==="link";document.getElementById("editFileBlock").classList.toggle("hidden",isLink);document.getElementById("editLinkBlock").classList.toggle("hidden",!isLink);document.getElementById("editFileName").textContent=d.originalName||"原文件";document.getElementById("editUrl").value=isLink?(d.url||""):"";document.getElementById("editMsg").textContent="";document.getElementById("editMask").classList.remove("hidden")};
function closeEdit(){document.getElementById("editMask").classList.add("hidden")};document.getElementById("editClose").onclick=closeEdit;document.getElementById("editCancel").onclick=closeEdit;document.getElementById("editMask").onclick=e=>{if(e.target.id==="editMask")closeEdit()};document.getElementById("useNow").onclick=()=>document.getElementById("editUpdatedAt").value=toLocalInput(new Date());
document.getElementById("editForm").onsubmit=async e=>{e.preventDefault();const id=document.getElementById("editId").value,msg=document.getElementById("editMsg");msg.className="notice";msg.textContent="正在保存...";const payload={title:document.getElementById("editTitle").value,category:document.getElementById("editCategory").value,version:document.getElementById("editVersion").value,sortOrder:document.getElementById("editSortOrder").value,description:document.getElementById("editDescription").value,pinned:document.getElementById("editPinned").checked,recommended:document.getElementById("editRecommended").checked,visible:document.getElementById("editVisible").checked,updatedAt:document.getElementById("editUpdatedAt").value,url:document.getElementById("editLinkBlock").classList.contains("hidden")?undefined:document.getElementById("editUrl").value};try{const r=await fetch("/api/admin/documents/"+encodeURIComponent(id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"保存失败");msg.className="ok";msg.textContent="保存成功";await load();setTimeout(closeEdit,300)}catch(err){msg.className="err";msg.textContent=err.message}};
async function simplePatch(id,payload){await fetch("/api/admin/documents/"+encodeURIComponent(id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});load()}
window.pinD=(id,v)=>simplePatch(id,{pinned:!v});window.recD=(id,v)=>simplePatch(id,{recommended:!v});window.visD=(id,v)=>simplePatch(id,{visible:!v});window.moveD=(id,delta)=>fetch("/api/admin/documents/"+encodeURIComponent(id)+"/move",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({delta})}).then(load);
window.delD=async id=>{if(!confirm("确定删除这份资料吗？文件资料会同时删除实体文件。"))return;await fetch("/api/admin/documents/"+encodeURIComponent(id),{method:"DELETE"});load()};auth();
</script></body></html>`;

function previewHtml(d, req) {
  const filename = safeOriginalName(d.originalName || d.title || "preview");
  const mode = previewMode(filename);
  const fileUrl = "/preview-file/" + encodeURIComponent(d.id);
  const downloadUrl = "/download/" + encodeURIComponent(d.id);
  const title = String(d.title || filename).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
  const base = req.protocol + "://" + req.get("host");
  let body = "";
  if (mode === "frame") body = `<iframe class="preview-frame" src="${fileUrl}"></iframe>`;
  else if (mode === "image") body = `<img class="preview-img" src="${fileUrl}" alt="${title}">`;
  else if (mode === "video") body = `<video class="preview-video" controls preload="metadata" src="${fileUrl}"></video>`;
  else if (mode === "office") {
    const officeUrl = "https://view.officeapps.live.com/op/embed.aspx?src=" + encodeURIComponent(base + fileUrl);
    body = `<iframe class="preview-frame" src="${officeUrl}"></iframe>`;
  } else body = `<div class="preview-empty"><h2>此格式暂不支持在线预览</h2><p style="color:#667085;line-height:1.8">压缩包等格式需要下载后查看。</p><a class="btn" href="${downloadUrl}">立即下载</a></div>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}｜在线预览</title><style>${css}</style></head><body><div class="preview-shell"><div class="preview-bar"><b>${title}</b><div style="display:flex;gap:8px"><a class="btn2" href="/">返回首页</a><a class="btn" href="${downloadUrl}">下载</a></div></div><div class="preview-area">${body}</div></div></body></html>`;
}

app.get("/", (_, res) => res.type("html").send(homeHtml));
app.get("/admin.html", (_, res) => res.type("html").send(adminHtml));

app.post("/api/login", (req, res) => {
  if (String(req.body.password || "") === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "密码错误" });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", (req, res) => res.json({ isAdmin: Boolean(req.session?.isAdmin) }));

app.get("/api/site-settings", (req, res) => {
  const s = readSettings();
  res.json({ announcement: s.announcement, submission: s.submission });
});
app.get("/api/admin/site-settings", adminOnly, (req, res) => res.json(readSettings()));
app.patch("/api/admin/site-settings", adminOnly, (req, res) => {
  const s = readSettings();
  if (req.body.announcement) {
    const a = req.body.announcement;
    if ("enabled" in a) s.announcement.enabled = Boolean(a.enabled);
    if ("title" in a) s.announcement.title = clean(a.title, 100) || "置顶公告";
    if ("content" in a) s.announcement.content = clean(a.content, 2000);
  }
  if (req.body.submission) {
    const sub = req.body.submission;
    if ("enabled" in sub) s.submission.enabled = Boolean(sub.enabled);
    if ("title" in sub) s.submission.title = clean(sub.title, 100) || "投稿邮箱";
    if ("email" in sub) s.submission.email = clean(sub.email, 200);
    if ("content" in sub) s.submission.content = clean(sub.content, 2000);
  }
  writeSettings(s);
  res.json({ ok: true, settings: s });
});

app.get("/api/documents", (req, res) => {
  res.json(readDocs().map(normalizeDoc).filter(d => d.visible !== false).sort(sortDocs));
});
app.get("/api/admin/documents", adminOnly, (req, res) => {
  res.json(readDocs().map(normalizeDoc).sort(sortDocs));
});

app.post("/api/admin/links", adminOnly, (req, res) => {
  const title = clean(req.body.title, 100);
  const url = validHttpUrl(req.body.url);
  if (!title) return res.status(400).json({ error: "链接名称不能为空" });
  if (!url) return res.status(400).json({ error: "网址格式不正确，请填写以 http:// 或 https:// 开头的完整网址" });
  const now = new Date().toISOString();
  const doc = {
    id: crypto.randomUUID(), kind: "link", title,
    category: clean(req.body.category, 50) || "AI工具",
    description: clean(req.body.description, 500), url,
    type: "LINK", size: 0, downloads: 0, visible: true,
    pinned: toBool(req.body.pinned), recommended: toBool(req.body.recommended),
    sortOrder: toNumber(req.body.sortOrder, 0), version: clean(req.body.version, 40),
    createdAt: now, updatedAt: now
  };
  const docs = readDocs(); docs.push(doc); writeDocs(docs); res.json({ ok: true, document: doc });
});

app.post("/api/admin/uploads/presign", adminOnly, async (req, res) => {
  if (!BUCKET_READY) return res.status(503).json({ error: "Bucket 尚未连接完成" });
  const filename = safeOriginalName(req.body.filename);
  const size = Number(req.body.size || 0);
  const ext = path.extname(filename).toLowerCase();
  if (!allowed.has(ext)) return res.status(400).json({ error: "不支持该文件类型" });
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: "文件大小无效" });
  if (size > MAX_UPLOAD_MB * 1024 * 1024) return res.status(400).json({ error: `单个文件不能超过${MAX_UPLOAD_MB}MB` });
  const key = `uploads/${new Date().toISOString().slice(0,10)}/${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
  try {
    const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: clean(req.body.contentType, 120) || mimeFor(filename) });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.json({ ok: true, key, uploadUrl });
  } catch (err) {
    console.error("生成 Bucket 上传地址失败", err);
    res.status(500).json({ error: "无法生成上传地址" });
  }
});

app.post("/api/admin/uploads/complete", adminOnly, async (req, res) => {
  if (!BUCKET_READY) return res.status(503).json({ error: "Bucket 尚未连接完成" });
  const key = String(req.body.key || "").trim();
  const originalName = safeOriginalName(req.body.originalName);
  const declaredSize = Number(req.body.size || 0);
  if (!key.startsWith("uploads/")) return res.status(400).json({ error: "文件标识无效" });
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    const actualSize = Number(head.ContentLength || 0);
    if (!actualSize) return res.status(400).json({ error: "Bucket 中未找到上传文件" });
    if (declaredSize && actualSize !== declaredSize) return res.status(400).json({ error: "文件大小校验失败，请重新上传" });
    const now = new Date().toISOString();
    const ext = path.extname(originalName).replace(".", "").toUpperCase();
    const doc = {
      id: crypto.randomUUID(), kind: "file", storage: "bucket", objectKey: key,
      title: clean(req.body.title, 100) || originalName,
      category: clean(req.body.category, 50) || "其他资料",
      description: clean(req.body.description, 500), originalName,
      type: ext || clean(req.body.type, 20) || "FILE", size: actualSize,
      downloads: 0, visible: true,
      pinned: toBool(req.body.pinned), recommended: toBool(req.body.recommended),
      sortOrder: toNumber(req.body.sortOrder, 0), version: clean(req.body.version, 40),
      createdAt: now, updatedAt: now
    };
    const docs = readDocs(); docs.push(doc); writeDocs(docs); res.json({ ok: true, document: doc });
  } catch (err) {
    console.error("确认 Bucket 上传失败", err);
    res.status(500).json({ error: "确认上传失败，请稍后重试" });
  }
});

// 保留旧的服务器直传接口，确保旧部署方式仍兼容。
app.post("/api/admin/documents", adminOnly, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择文档" });
  const now = new Date().toISOString();
  const ext = path.extname(req.file.originalname).replace(".", "").toUpperCase();
  const doc = {
    id: crypto.randomUUID(), kind: "file",
    title: clean(req.body.title, 100) || req.file.originalname,
    category: clean(req.body.category, 50) || "其他资料",
    description: clean(req.body.description, 500),
    originalName: req.file.originalname, storedName: req.file.filename,
    type: ext || "FILE", size: req.file.size, downloads: 0, visible: true,
    pinned: toBool(req.body.pinned), recommended: toBool(req.body.recommended),
    sortOrder: toNumber(req.body.sortOrder, 0), version: clean(req.body.version, 40),
    createdAt: now, updatedAt: now
  };
  const docs = readDocs(); docs.push(doc); writeDocs(docs); res.json({ ok: true, document: doc });
});

app.patch("/api/admin/documents/:id", adminOnly, (req, res) => {
  const docs = readDocs(); const d = docs.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: "文档不存在" });
  if ("title" in req.body) { const v = clean(req.body.title, 100); if (!v) return res.status(400).json({ error: "名称不能为空" }); d.title = v; }
  if ("category" in req.body) d.category = clean(req.body.category, 50) || "其他资料";
  if ("description" in req.body) d.description = clean(req.body.description, 500);
  if ("version" in req.body) d.version = clean(req.body.version, 40);
  if ("sortOrder" in req.body) d.sortOrder = toNumber(req.body.sortOrder, 0);
  if ("visible" in req.body) d.visible = Boolean(req.body.visible);
  if ("pinned" in req.body) d.pinned = Boolean(req.body.pinned);
  if ("recommended" in req.body) d.recommended = Boolean(req.body.recommended);
  if ("url" in req.body && (d.kind === "link" || d.url)) {
    const url = validHttpUrl(req.body.url); if (!url) return res.status(400).json({ error: "网址格式不正确" }); d.url = url; d.kind = "link";
  }
  d.updatedAt = isoDate(req.body.updatedAt, new Date().toISOString());
  writeDocs(docs); res.json({ ok: true, document: normalizeDoc(d) });
});

app.post("/api/admin/documents/:id/move", adminOnly, (req, res) => {
  const docs = readDocs(); const d = docs.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: "文档不存在" });
  const delta = Math.max(-1000, Math.min(1000, toNumber(req.body.delta, 0)));
  d.sortOrder = toNumber(d.sortOrder, 0) + delta;
  d.updatedAt = new Date().toISOString();
  writeDocs(docs); res.json({ ok: true, document: normalizeDoc(d) });
});

app.delete("/api/admin/documents/:id", adminOnly, async (req, res) => {
  const docs = readDocs(); const i = docs.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "文档不存在" });
  const d = normalizeDoc(docs[i]);
  try {
    if (d.kind === "link") {}
    else if (d.storage === "bucket" && d.objectKey && BUCKET_READY) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: d.objectKey }));
    else if (d.storedName) { const f = path.join(UPLOAD_DIR, d.storedName); if (fs.existsSync(f)) fs.unlinkSync(f); }
  } catch (err) {
    console.error("删除实体文件失败", err); return res.status(500).json({ error: "删除文件失败，请稍后重试" });
  }
  docs.splice(i, 1); writeDocs(docs); res.json({ ok: true });
});

app.get("/go/:id", (req, res) => {
  const docs = readDocs(); const d = docs.find(x => x.id === req.params.id && x.visible !== false && (x.kind === "link" || x.url));
  if (!d) return res.status(404).send("链接不存在");
  const url = validHttpUrl(d.url); if (!url) return res.status(400).send("链接地址无效");
  d.downloads = toNumber(d.downloads, 0) + 1; writeDocs(docs); res.redirect(url);
});

app.get("/preview/:id", (req, res) => {
  const d = readDocs().map(normalizeDoc).find(x => x.id === req.params.id && x.visible !== false && x.kind !== "link");
  if (!d) return res.status(404).send("文件不存在");
  res.type("html").send(previewHtml(d, req));
});

app.get("/preview-file/:id", async (req, res) => {
  const d = readDocs().map(normalizeDoc).find(x => x.id === req.params.id && x.visible !== false && x.kind !== "link");
  if (!d) return res.status(404).send("文件不存在");
  const filename = safeOriginalName(d.originalName || d.title || "preview");
  try {
    if (d.storage === "bucket" && d.objectKey) {
      if (!BUCKET_READY) return res.status(503).send("Bucket 尚未连接");
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME, Key: d.objectKey,
        ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        ResponseContentType: mimeFor(filename)
      });
      const url = await getSignedUrl(s3, command, { expiresIn: 900 });
      return res.redirect(url);
    }
    const f = path.join(UPLOAD_DIR, d.storedName || "");
    if (!d.storedName || !fs.existsSync(f)) return res.status(404).send("文件已丢失");
    res.setHeader("Content-Type", mimeFor(filename));
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return res.sendFile(f);
  } catch (err) {
    console.error("预览失败", err); res.status(500).send("预览失败，请稍后重试");
  }
});

app.get("/download/:id", async (req, res) => {
  const docs = readDocs(); const d = docs.find(x => x.id === req.params.id && x.visible !== false && (x.kind !== "link" && !x.url));
  if (!d) return res.status(404).send("文件不存在");
  try {
    if (d.storage === "bucket" && d.objectKey) {
      if (!BUCKET_READY) return res.status(503).send("Bucket 尚未连接");
      const filename = safeOriginalName(d.originalName || d.title || "download");
      const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: d.objectKey, ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` });
      const url = await getSignedUrl(s3, command, { expiresIn: 900 });
      d.downloads = toNumber(d.downloads, 0) + 1; writeDocs(docs); return res.redirect(url);
    }
    const f = path.join(UPLOAD_DIR, d.storedName || "");
    if (!d.storedName || !fs.existsSync(f)) return res.status(404).send("文件已丢失");
    d.downloads = toNumber(d.downloads, 0) + 1; writeDocs(docs); return res.download(f, d.originalName);
  } catch (err) {
    console.error("下载失败", err); res.status(500).send("下载失败，请稍后重试");
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: `单个文件不能超过${MAX_UPLOAD_MB}MB` });
  res.status(400).json({ error: err?.message || "操作失败" });
});

app.listen(PORT, () => console.log("人民邮电出版社工具包已启动，端口：" + PORT));
