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

const BUCKET_NAME = process.env.BUCKET || "";
const BUCKET_ENDPOINT = process.env.ENDPOINT || "";
const BUCKET_REGION = process.env.REGION || "auto";
const BUCKET_ACCESS_KEY = process.env.ACCESS_KEY_ID || "";
const BUCKET_SECRET_KEY = process.env.SECRET_ACCESS_KEY || "";
const BUCKET_READY = Boolean(
  BUCKET_NAME && BUCKET_ENDPOINT && BUCKET_ACCESS_KEY && BUCKET_SECRET_KEY
);

const s3 = BUCKET_READY ? new S3Client({
  region: BUCKET_REGION,
  endpoint: BUCKET_ENDPOINT,
  credentials: {
    accessKeyId: BUCKET_ACCESS_KEY,
    secretAccessKey: BUCKET_SECRET_KEY
  }
}) : null;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";
const STORAGE_ROOT = process.env.STORAGE_DIR || path.join(__dirname, "storage");
const DATA_FILE = path.join(STORAGE_ROOT, "documents.json");
const SETTINGS_FILE = path.join(STORAGE_ROOT, "site-settings.json");
const UPLOAD_DIR = path.join(STORAGE_ROOT, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");

const DEFAULT_SETTINGS = {
  announcement: {
    enabled: true,
    title: "置顶公告",
    content: "欢迎使用 AI 漫剧资料库。"
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

app.use(express.json({ limit: "1mb" }));
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
          ExposeHeaders: ["ETag"],
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
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return []; }
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
function clean(v, max=500) {
  return String(v || "").trim().slice(0, max);
}

function safeOriginalName(name) {
  return path.basename(String(name || "file")).replace(/[\r\n"]/g, "_").slice(0, 240);
}
function adminOnly(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(401).json({ error: "未登录或登录已过期" });
}

function validHttpUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    return (u.protocol === "http:" || u.protocol === "https:") ? u.toString() : null;
  } catch {
    return null;
  }
}

const allowed = new Set([
  ".pdf",".doc",".docx",".ppt",".pptx",
  ".xls",".xlsx",".zip",".rar",".7z",".txt"
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

const css = `
:root{
  --bg:#f5f7fb;--text:#101828;--muted:#667085;--line:#e4e7ec;
  --p:#5b5ff0;--p2:#8b5cf6;--danger:#d92d20;--ok:#027a48
}
*{box-sizing:border-box}
body{
  margin:0;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  color:var(--text);
  background:
    radial-gradient(circle at 15% 10%,rgba(91,95,240,.13),transparent 28%),
    radial-gradient(circle at 85% 15%,rgba(139,92,246,.12),transparent 25%),
    var(--bg)
}
a{text-decoration:none;color:inherit}
button,input,textarea,select{font:inherit}
button{cursor:pointer}
.wrap{width:min(1160px,calc(100% - 32px));margin:auto}
.nav{height:72px;display:flex;align-items:center;justify-content:space-between}
.brand{font-weight:800;display:flex;align-items:center;gap:10px}
.logo{
  width:38px;height:38px;border-radius:12px;color:#fff;display:grid;place-items:center;
  background:linear-gradient(135deg,var(--p),var(--p2))
}
.hero{text-align:center;padding:70px 0 36px}
.hero h1{font-size:clamp(38px,6vw,66px);line-height:1.05;margin:15px 0}
.hero p{color:var(--muted);font-size:16px;line-height:1.8}
.tag{
  display:inline-block;background:#fff;border:1px solid var(--line);
  border-radius:999px;padding:8px 12px;color:#475467;font-size:13px
}
.tools{max-width:800px;margin:28px auto 0;display:grid;grid-template-columns:1fr 180px;gap:10px}
input,textarea,select{
  width:100%;border:1px solid #d0d5dd;border-radius:12px;padding:12px 13px;
  background:#fff;outline:none
}
textarea{min-height:110px;resize:vertical}
input:focus,textarea:focus,select:focus{
  border-color:#9b9ef8;box-shadow:0 0 0 4px rgba(91,95,240,.08)
}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:20px 0 60px}
.card{
  background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:20px;
  padding:20px;box-shadow:0 18px 55px rgba(16,24,40,.07);
  display:flex;flex-direction:column;min-height:250px
}
.file{
  width:50px;height:50px;border-radius:15px;display:grid;place-items:center;
  background:rgba(91,95,240,.1);color:var(--p);font-weight:800
}
.badge{font-size:12px;color:#475467;background:#f2f4f7;padding:5px 9px;border-radius:999px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.card h3{font-size:18px;margin:17px 0 8px}
.desc{font-size:14px;line-height:1.7;color:var(--muted)}
.meta{font-size:12px;color:#98a2b3;margin-top:auto;padding-top:15px}
.btn{
  display:inline-flex;justify-content:center;align-items:center;border:0;border-radius:12px;
  padding:11px 14px;background:linear-gradient(135deg,var(--p),var(--p2));
  color:#fff;font-weight:700
}
.card .btn{margin-top:13px}
.empty{
  grid-column:1/-1;padding:50px;text-align:center;color:var(--muted);
  background:#fff;border:1px dashed #d0d5dd;border-radius:18px
}
.notice-board{
  margin:12px 0 18px;padding:18px 20px;border-radius:18px;
  background:linear-gradient(135deg,rgba(255,248,225,.98),rgba(255,252,242,.98));
  border:1px solid #f4d98a;box-shadow:0 14px 42px rgba(146,105,16,.08)
}
.notice-board .notice-title{
  display:flex;align-items:center;gap:8px;margin:0 0 8px;
  font-size:16px;font-weight:800;color:#7a5310
}
.notice-board .notice-content{
  color:#6b5a35;line-height:1.75;font-size:14px;white-space:pre-wrap
}
.submission-box{
  margin:0 0 22px;padding:20px;border-radius:18px;background:#fff;
  border:1px solid var(--line);box-shadow:0 14px 42px rgba(16,24,40,.06);
  display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center
}
.submission-box h3{margin:0 0 7px;font-size:17px}
.submission-box p{margin:0;color:var(--muted);font-size:14px;line-height:1.7;white-space:pre-wrap}
.email-link{
  display:inline-flex;align-items:center;justify-content:center;min-width:190px;
  padding:11px 15px;border-radius:12px;border:1px solid #c7c9ff;
  background:#f7f7ff;color:#4548ce;font-weight:700;word-break:break-all
}
.settings-grid{
  display:grid;grid-template-columns:1fr 1fr;gap:18px
}
.settings-card{
  border:1px solid var(--line);border-radius:16px;padding:18px;background:#fbfcfe
}
.switch-row{
  display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px
}
.switch-row input[type="checkbox"]{width:18px;height:18px}


/* ===== V2：首页重新设计（仅前台） ===== */
.home-page{
  min-height:100vh;
  background:
    radial-gradient(circle at 8% -5%,rgba(77,91,214,.12),transparent 28%),
    radial-gradient(circle at 92% 8%,rgba(119,91,214,.09),transparent 24%),
    #f6f7fb;
}
.home-wrap{width:min(1180px,calc(100% - 32px));margin:auto}
.home-nav{
  height:76px;display:flex;align-items:center;justify-content:space-between;
  border-bottom:1px solid rgba(228,231,236,.8)
}
.home-brand{display:flex;align-items:center;gap:12px;font-size:17px;font-weight:850;letter-spacing:.01em}
.home-brand-mark{
  width:40px;height:40px;border-radius:12px;display:grid;place-items:center;
  color:#fff;font-weight:900;background:linear-gradient(145deg,#263d87,#6556d8);
  box-shadow:0 10px 26px rgba(65,73,172,.2)
}
.home-admin-link{
  color:#475467;font-size:13px;padding:9px 12px;border:1px solid #e4e7ec;
  background:rgba(255,255,255,.82);border-radius:10px
}
.home-hero{
  margin-top:28px;padding:42px 44px 38px;border:1px solid #e5e7ee;
  border-radius:26px;background:rgba(255,255,255,.92);
  box-shadow:0 22px 70px rgba(26,35,71,.08);
  display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:34px;align-items:center
}
.home-kicker{
  display:inline-flex;align-items:center;gap:7px;padding:7px 11px;border-radius:999px;
  background:#f0f2ff;color:#4147a8;font-size:12px;font-weight:750
}
.home-hero h1{
  margin:16px 0 13px;font-size:clamp(34px,5vw,54px);line-height:1.08;
  letter-spacing:-.035em;color:#101828
}
.home-hero p{margin:0;color:#667085;font-size:15px;line-height:1.85;max-width:700px}
.hero-side{
  padding:22px;border-radius:20px;background:linear-gradient(145deg,#172554,#35318f);
  color:#fff;min-height:180px;display:flex;flex-direction:column;justify-content:space-between
}
.hero-side strong{font-size:14px}
.hero-side .big{font-size:30px;font-weight:900;letter-spacing:-.03em}
.hero-side .small{font-size:12px;line-height:1.7;color:rgba(255,255,255,.72)}
.home-search{
  margin-top:18px;display:grid;grid-template-columns:minmax(0,1fr) 190px;gap:10px
}
.home-search input,.home-search select{
  min-height:48px;border-radius:13px;border:1px solid #dfe3ea;background:#fff
}
.front-section{margin-top:24px}
.front-section-head{
  display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px
}
.front-section-head h2{margin:0;font-size:21px;letter-spacing:-.02em}
.front-section-head p{margin:4px 0 0;color:#98a2b3;font-size:12px}
.resource-grid{
  display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px
}
.resource-card{
  position:relative;background:#fff;border:1px solid #e5e7ec;border-radius:18px;
  padding:18px;box-shadow:0 12px 38px rgba(16,24,40,.055);
  display:flex;flex-direction:column;min-height:285px;transition:.18s ease
}
.resource-card:hover{transform:translateY(-2px);box-shadow:0 18px 48px rgba(16,24,40,.09)}
.resource-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.resource-icon{
  width:46px;height:46px;border-radius:13px;display:grid;place-items:center;
  background:#f0f2ff;color:#4b50b8;font-size:12px;font-weight:900
}
.resource-badges{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.resource-badge{
  padding:5px 8px;border-radius:999px;background:#f2f4f7;color:#475467;
  font-size:11px;font-weight:700
}
.resource-badge.pin{background:#fff5d9;color:#865b00}
.resource-badge.rec{background:#eaf7ef;color:#18794e}
.resource-badge.link{background:#eef4ff;color:#3538cd}
.resource-card h3{font-size:17px;line-height:1.45;margin:15px 0 7px}
.resource-desc{
  color:#667085;font-size:13px;line-height:1.72;display:-webkit-box;
  -webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden
}
.resource-meta{
  display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:auto;padding-top:16px;
  color:#98a2b3;font-size:11px
}
.resource-meta span:nth-child(even){text-align:right}
.resource-actions{display:flex;gap:8px;margin-top:13px}
.resource-actions .btn{flex:1;margin:0;padding:10px 12px;font-size:13px}
.preview-btn{
  flex:1;border:1px solid #d8dbe7;border-radius:11px;background:#fff;color:#344054;
  padding:10px 12px;font-weight:700
}
.recommended-shell{
  padding:18px;border-radius:22px;border:1px solid #e5e7ec;
  background:linear-gradient(145deg,rgba(245,247,255,.98),rgba(255,255,255,.98))
}
.front-notice-row{display:grid;grid-template-columns:1.35fr .9fr;gap:14px;margin-top:18px}
.front-notice-row .notice-board,.front-notice-row .submission-box{margin:0;height:100%}
.front-notice-row .submission-box{grid-template-columns:1fr}
.front-notice-row .email-link{min-width:0;width:100%}
.preview-mask{
  position:fixed;inset:0;background:rgba(16,24,40,.62);backdrop-filter:blur(5px);
  display:grid;place-items:center;padding:18px;z-index:1200
}
.preview-dialog{
  width:min(1050px,100%);height:min(84vh,860px);background:#fff;border-radius:20px;
  overflow:hidden;display:flex;flex-direction:column;box-shadow:0 34px 110px rgba(0,0,0,.28)
}
.preview-head{
  height:58px;display:flex;align-items:center;justify-content:space-between;
  padding:0 16px 0 20px;border-bottom:1px solid #e5e7ec
}
.preview-head strong{font-size:14px}
.preview-frame{border:0;width:100%;height:100%;background:#f5f6f8}
.home-footer{
  margin-top:34px;padding:25px 0 34px;border-top:1px solid #e5e7ec;
  color:#98a2b3;font-size:12px;display:flex;justify-content:space-between;gap:18px
}

/* ===== V2：后台资料元数据 ===== */
.admin-meta-grid{
  display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:8px
}
.admin-meta-chip{
  padding:7px 9px;border-radius:9px;background:#f8f9fc;color:#667085;font-size:11px
}
.recommend-chip{background:#eaf7ef!important;color:#18794e!important}
.edit-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}

@media(max-width:900px){
  .home-hero{grid-template-columns:1fr}
  .hero-side{min-height:145px}
  .resource-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .front-notice-row{grid-template-columns:1fr}
}
@media(max-width:620px){
  .home-hero{padding:28px 22px}
  .home-search,.resource-grid{grid-template-columns:1fr}
  .home-footer{flex-direction:column}
  .admin-meta-grid,.edit-two{grid-template-columns:1fr 1fr}
}

/* admin */
.admin{width:min(1050px,calc(100% - 32px));margin:40px auto}
.panel{
  background:#fff;border:1px solid var(--line);border-radius:20px;padding:22px;
  margin-bottom:18px;box-shadow:0 16px 50px rgba(16,24,40,.06)
}
.login{max-width:450px;margin:12vh auto}
.form{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.full{grid-column:1/-1}
label{display:block;font-size:13px;color:#475467;margin-bottom:7px}
.notice{font-size:13px;color:var(--muted)}
.err{font-size:13px;color:var(--danger);margin-top:9px}
.ok{font-size:13px;color:var(--ok);margin-top:9px}
.hidden{display:none!important}
.item{
  display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center;
  padding:16px;border:1px solid var(--line);border-radius:14px;margin-top:10px
}
.item h3{margin:0 0 6px;font-size:16px}
.item .admin-desc{
  margin:6px 0 0;color:var(--muted);font-size:13px;line-height:1.65;
  max-width:690px;white-space:pre-wrap
}
.item p{margin:0;color:#98a2b3;font-size:12px}
.mini{
  border:1px solid var(--line);background:#fff;border-radius:9px;
  padding:8px 11px;cursor:pointer
}
.mini.primary{color:var(--p);border-color:#c7c9ff;background:#f7f7ff}
.danger{color:var(--danger)}
.actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}

/* edit modal */
.modal-mask{
  position:fixed;inset:0;background:rgba(16,24,40,.52);backdrop-filter:blur(5px);
  display:grid;place-items:center;padding:20px;z-index:999
}
.modal{
  width:min(680px,100%);background:#fff;border-radius:22px;padding:24px;
  box-shadow:0 30px 90px rgba(16,24,40,.25)
}
.modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.modal-head h2{margin:0;font-size:22px}
.close-btn{
  width:36px;height:36px;border:1px solid var(--line);background:#fff;
  border-radius:10px;font-size:20px;line-height:1
}
.modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
.secondary{
  border:1px solid var(--line);background:#fff;color:#344054;
  border-radius:12px;padding:11px 16px
}
.file-lock{
  padding:12px 14px;border-radius:12px;background:#f8f9fc;
  border:1px solid var(--line);font-size:13px;color:#667085
}

@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:600px){
  .grid{grid-template-columns:1fr}
  .tools,.form,.settings-grid{grid-template-columns:1fr}
  .submission-box{grid-template-columns:1fr}
  .email-link{width:100%}
  .full{grid-column:auto}
  .item{grid-template-columns:1fr}
  .actions{justify-content:flex-start}
  .hero{padding-top:45px}
}

/* ===== 小北资料库风格前台 ===== */
body.xiaobei-page{margin:0;background:#f7f6f2;color:#2e302e;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.xb-shell{min-height:100vh;display:flex}
.xb-sidebar{width:250px;flex:0 0 250px;min-height:100vh;position:sticky;top:0;display:flex;flex-direction:column;padding:28px 20px 22px;background:#fbfaf7;border-right:1px solid #e6e1d8}
.xb-brand{display:flex;align-items:center;gap:11px;color:#272923;font-weight:850;letter-spacing:.01em}
.xb-brand:hover{color:#272923}
.xb-brandmark{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:#e7753c;color:#fff;font-size:20px;box-shadow:0 8px 20px rgba(231,117,60,.22)}
.xb-brandtext{font-size:17px;line-height:1.25}.xb-brandtext small{display:block;color:#a5a096;font-size:11px;font-weight:600;letter-spacing:.05em;margin-top:3px}
.xb-nav-label{margin:42px 10px 12px;color:#aaa49a;font-size:11px;font-weight:800;letter-spacing:.16em}
.xb-nav{display:flex;flex-direction:column;gap:5px}
.xb-nav-item{width:100%;display:flex;align-items:center;gap:10px;border:0;border-radius:11px;padding:11px 12px;background:transparent;color:#74756e;text-align:left;font-size:14px}
.xb-nav-item:hover{background:#f1eee8;color:#353732}.xb-nav-item.active{background:#efe9df;color:#31332e;font-weight:800}.xb-nav-icon{width:21px;text-align:center;font-size:16px;color:#aaa39a}.xb-nav-item.active .xb-nav-icon{color:#e7753c}.xb-nav-item small{margin-left:auto;color:#aaa49a;font-size:11px}.xb-nav-item.active small{color:#d46c38}
.xb-side-bottom{margin-top:auto;padding:16px 10px 0;border-top:1px solid #e8e3da;color:#aaa49a;font-size:12px}.xb-side-bottom p{margin:8px 0 14px;color:#a8a399}.xb-admin{display:flex;align-items:center;gap:7px;color:#716f67;font-weight:700;font-size:12px}.xb-admin:hover{color:#e16e36}
.xb-main{min-width:0;flex:1;max-width:1450px;padding:0 6vw 54px}.xb-header{height:76px;display:flex;align-items:center;justify-content:space-between;color:#a29d94;font-size:12px}.xb-breadcrumb b{color:#52534d;font-weight:800}.xb-guide{border:1px solid #e3ded5;border-radius:9px;padding:8px 12px;background:rgba(255,255,255,.5);color:#75736b;font-size:12px}
.xb-heading{padding:32px 0 20px}.xb-eyebrow{color:#db7440;font-size:11px;font-weight:900;letter-spacing:.18em;text-transform:uppercase}.xb-title-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.xb-heading h1{margin:13px 0 10px;color:#252720;font-size:clamp(36px,5vw,58px);line-height:1.02;letter-spacing:-.055em}.xb-heading h1 span{color:#e7753c}.xb-free{padding:6px 10px;border:1px solid #e8d8c6;border-radius:999px;background:#fffaf4;color:#c56b3b;font-size:11px;font-weight:800}.xb-intro{max-width:760px;margin:0;color:#85847d;line-height:1.85;font-size:14px;white-space:pre-wrap}
.xb-feature{min-height:228px;margin:18px 0 28px;padding:30px 36px;border-radius:24px;display:grid;grid-template-columns:minmax(0,1fr) 210px;gap:20px;align-items:center;background:linear-gradient(120deg,#f2c995 0%,#f7d8ae 48%,#f8e4c8 100%);overflow:hidden;position:relative}.xb-feature:after{content:"";position:absolute;width:340px;height:340px;border-radius:50%;right:-120px;top:-110px;border:1px solid rgba(160,93,36,.16);box-shadow:0 0 0 28px rgba(160,93,36,.05),0 0 0 58px rgba(160,93,36,.04)}.xb-feature-copy{position:relative;z-index:1}.xb-feature-label{color:#9e5f2f;font-size:11px;font-weight:900;letter-spacing:.16em}.xb-feature-label span{opacity:.6;margin:0 5px}.xb-feature h2{margin:12px 0 7px;color:#5b3b24;font-size:clamp(24px,3.2vw,38px);letter-spacing:-.035em}.xb-feature p{margin:0;color:#815f42;font-size:14px}.xb-feature-button{margin-top:20px;border:0;border-radius:9px;padding:10px 14px;background:#5b3b24;color:#fff;font-weight:800;font-size:12px}.xb-feature-art{position:relative;z-index:1;display:grid;place-items:center;color:#9b6335;opacity:.78}.xb-feature-art strong{font-size:76px;font-weight:400;line-height:1}.xb-feature-art small{margin-top:8px;font-size:11px;letter-spacing:.16em;color:#96633d}
.xb-notice{padding:16px 18px;margin:0 0 22px;border:1px solid #eadab8;border-radius:15px;background:#fff9ec;color:#76552a}.xb-notice strong{display:block;margin-bottom:6px;font-size:13px}.xb-notice p{margin:0;white-space:pre-wrap;line-height:1.75;font-size:13px}
.xb-library{margin-top:10px}.xb-toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:12px}.xb-list-heading{display:flex;align-items:baseline;gap:9px}.xb-list-heading h2{margin:0;font-size:23px;letter-spacing:-.035em;color:#2e302e}.xb-list-heading span{color:#aaa49a;font-size:12px}.xb-search{width:min(340px,100%);display:flex;align-items:center;gap:8px;padding:0 13px;border:1px solid #e2ded6;border-radius:10px;background:#fff;color:#a7a198}.xb-search input{min-height:40px;border:0!important;box-shadow:none!important;padding:0;background:transparent;font-size:13px;color:#45463f}.xb-typebar{display:flex;justify-content:space-between;gap:12px;margin-bottom:14px;color:#aca69e;font-size:11px}.xb-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.xb-card{min-width:0;border:1px solid #e6e1d9;border-radius:17px;background:#fff;overflow:hidden;box-shadow:0 10px 32px rgba(80,64,39,.045);transition:.18s ease}.xb-card:hover{transform:translateY(-3px);box-shadow:0 18px 42px rgba(80,64,39,.1)}.xb-cover{width:100%;min-height:138px;display:flex;flex-direction:column;justify-content:space-between;align-items:flex-start;padding:17px 18px;border:0;text-align:left;position:relative;cursor:pointer;color:#fff}.xb-cover.orange{background:linear-gradient(135deg,#dc7541,#f0ad68)}.xb-cover.blue{background:linear-gradient(135deg,#6e8ba6,#a7c1cd)}.xb-cover.green{background:linear-gradient(135deg,#769781,#b3c59d)}.xb-cover.purple{background:linear-gradient(135deg,#8a78a8,#c7b1d2)}.xb-cover-top{width:100%;display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:800;opacity:.88}.xb-cover-icon{font-size:26px;line-height:1}.xb-cover strong{max-width:84%;font-size:19px;line-height:1.3;letter-spacing:-.02em}.xb-cover small{font-size:11px;opacity:.8}.xb-cover-corner{position:absolute;right:16px;bottom:14px;font-size:22px;opacity:.7}.xb-card-body{padding:15px 17px 16px}.xb-category{color:#d97643;font-size:11px;font-weight:900}.xb-card h3{margin:7px 0 6px;color:#363831;font-size:16px;line-height:1.4}.xb-card h3 button{border:0;padding:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.xb-desc{min-height:38px;color:#8d8c84;font-size:12px;line-height:1.65;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.xb-card-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:14px;color:#b0aaa1;font-size:11px}.xb-card-actions{display:flex;align-items:center;gap:10px}.xb-card-actions a,.xb-card-actions button{border:0;background:transparent;color:#6b6c64;font-size:11px;font-weight:800;padding:0;cursor:pointer}.xb-card-actions a:hover,.xb-card-actions button:hover{color:#e16e36}.xb-direct{color:#d46f3e!important}.xb-empty{grid-column:1/-1;padding:55px 20px;border:1px dashed #ddd7cd;border-radius:16px;background:#fff;text-align:center;color:#aaa49b;font-size:13px}.xb-submission{margin-top:26px;padding:18px 20px;border:1px solid #e6e1d8;border-radius:15px;background:#fff;display:flex;align-items:center;justify-content:space-between;gap:18px}.xb-submission h3{margin:0 0 5px;color:#45463f;font-size:14px}.xb-submission p{margin:0;color:#99938a;font-size:12px;line-height:1.7;white-space:pre-wrap}.xb-email{display:inline-flex;align-items:center;justify-content:center;min-width:190px;padding:10px 13px;border-radius:9px;background:#fff8f1;border:1px solid #f0d5bf;color:#d36e3a;font-size:12px;font-weight:800;word-break:break-all}.xb-footer{margin-top:34px;padding-top:22px;border-top:1px solid #e6e1d8;display:flex;justify-content:space-between;gap:18px;color:#aaa49a;font-size:11px}
.xb-modal-mask{position:fixed;inset:0;z-index:2000;padding:16px;background:rgba(38,34,28,.48);backdrop-filter:blur(5px);display:grid;place-items:center}.xb-modal{width:min(720px,100%);max-height:min(88vh,760px);overflow:auto;border-radius:19px;background:#fffdf9;box-shadow:0 28px 90px rgba(27,21,13,.25)}.xb-modal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:15px;padding:23px 24px 17px;border-bottom:1px solid #ece7df}.xb-modal-head small{display:block;color:#d1723f;font-size:11px;font-weight:900;margin-bottom:7px}.xb-modal-head h2{margin:0;color:#34362f;font-size:24px}.xb-close{width:34px;height:34px;border:1px solid #e3ddd4;border-radius:9px;background:#fff;color:#77736b;font-size:20px;line-height:1}.xb-modal-body{padding:21px 24px}.xb-modal-desc{margin:0;color:#6f7068;white-space:pre-wrap;line-height:1.85;font-size:14px}.xb-modal-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:18px 0}.xb-modal-meta span{padding:10px 11px;border-radius:9px;background:#f5f2ec;color:#8f8b83;font-size:11px}.xb-modal-actions{display:flex;flex-wrap:wrap;gap:9px}.xb-modal-actions a,.xb-modal-actions button{display:inline-flex;align-items:center;justify-content:center;border-radius:9px;padding:10px 14px;border:1px solid #ddd7ce;background:#fff;color:#5a5b53;font-size:12px;font-weight:800;cursor:pointer}.xb-modal-actions .primary{border-color:#d46f3b;background:#d8733d;color:#fff}.xb-preview{display:none;margin-top:18px;border:1px solid #e7e1d8;border-radius:11px;overflow:hidden;height:420px}.xb-preview iframe{width:100%;height:100%;border:0;background:#f5f3ef}
@media(max-width:1050px){.xb-main{padding-left:34px;padding-right:34px}.xb-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){.xb-shell{display:block}.xb-sidebar{width:auto;min-height:auto;position:static;padding:16px;border-right:0;border-bottom:1px solid #e6e1d8}.xb-nav-label{margin:20px 4px 9px}.xb-nav{flex-direction:row;overflow-x:auto;padding-bottom:2px}.xb-nav-item{width:auto;min-width:max-content;padding:9px 11px}.xb-side-bottom{display:none}.xb-main{padding:0 16px 38px}.xb-header{display:none}.xb-heading{padding:28px 0 14px}.xb-feature{grid-template-columns:1fr;min-height:0;padding:24px 22px}.xb-feature-art{display:none}.xb-toolbar{align-items:stretch;flex-direction:column;gap:12px}.xb-search{width:100%}.xb-typebar{flex-direction:column;gap:4px}.xb-grid{grid-template-columns:1fr}.xb-submission{align-items:stretch;flex-direction:column}.xb-email{width:100%}.xb-footer{flex-direction:column;gap:7px}.xb-modal-meta{grid-template-columns:1fr 1fr}.xb-modal-head,.xb-modal-body{padding-left:18px;padding-right:18px}}

`;

const homeHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI漫剧资料库</title>
<style>${css}</style>
</head>
<body class="xiaobei-page">
<div class="xb-shell">
  <aside class="xb-sidebar">
    <a class="xb-brand" href="/">
      <span class="xb-brandmark">书</span>
      <span class="xb-brandtext">AI漫剧资料库<small>创作 · 学习 · 分享</small></span>
    </a>
    <div class="xb-nav-label">资料导航</div>
    <nav id="xbNav" class="xb-nav" aria-label="资料分类"></nav>
    <div class="xb-side-bottom">
      <span>✳</span>
      <p>愿热爱，有回响。</p>
      <a class="xb-admin" href="/admin.html">⚙　站长后台</a>
    </div>
  </aside>

  <div class="xb-main">
    <header class="xb-header">
      <span class="xb-breadcrumb">创作空间　/　<b>资料库</b></span>
      <button class="xb-guide" type="button" onclick="document.getElementById('xbIntro').scrollIntoView({behavior:'smooth'})">使用指南</button>
    </header>

    <main>
      <section class="xb-heading">
        <div class="xb-eyebrow">你的创作工具箱</div>
        <div class="xb-title-row">
          <h1>创作资料库<span>.</span></h1>
          <span class="xb-free">公开分享 · 自由学习</span>
        </div>
        <p id="xbIntro" class="xb-intro">提示词、工具、Skill，都在这里整理。找到需要的资料，打开详情即可阅读、下载或直达工具。</p>
      </section>

      <section id="xbFeature" class="xb-feature">
        <div class="xb-feature-copy"><span class="xb-feature-label">推荐资料 <span>/</span> 工具</span><h2>正在加载资料</h2><p>精选创作资源会显示在这里</p><button class="xb-feature-button" type="button">查看资料　→</button></div>
        <div class="xb-feature-art"><strong>⌁</strong><small>从资料，到作品</small></div>
      </section>

      <section id="xbNotice" class="xb-notice" hidden><strong>📌 <span id="xbNoticeTitle">置顶公告</span></strong><p id="xbNoticeContent"></p></section>

      <section class="xb-library">
        <div class="xb-toolbar">
          <div class="xb-list-heading"><h2>全部资料</h2><span id="xbCount">0 份</span></div>
          <label class="xb-search" aria-label="搜索资料">⌕<input id="q" type="search" placeholder="搜索资料、关键词…"></label>
        </div>
        <div class="xb-typebar"><span>在线阅读 · 附件下载 · 工具直达</span><span>点击资料查看详细内容</span></div>
        <div id="grid" class="xb-grid"></div>
      </section>

      <section id="xbSubmission" class="xb-submission" hidden>
        <div><h3 id="xbSubmissionTitle">投稿邮箱</h3><p id="xbSubmissionContent"></p></div>
        <a id="xbSubmissionEmail" class="xb-email" href="#"></a>
      </section>
    </main>

    <footer class="xb-footer"><span>AI漫剧资料库</span><span>提示词 · 工具 · Skill · 持续更新</span></footer>
  </div>
</div>

<div id="detailMask" class="xb-modal-mask" hidden>
  <section class="xb-modal" role="dialog" aria-modal="true" aria-labelledby="detailTitle">
    <div class="xb-modal-head"><div><small id="detailCategory">资料</small><h2 id="detailTitle">资料详情</h2></div><button id="detailClose" class="xb-close" type="button" aria-label="关闭">×</button></div>
    <div class="xb-modal-body"><p id="detailDesc" class="xb-modal-desc"></p><div id="detailMeta" class="xb-modal-meta"></div><div id="detailActions" class="xb-modal-actions"></div><div id="detailPreview" class="xb-preview"><iframe title="在线预览"></iframe></div></div>
  </section>
</div>

<script>
let docs=[];
let activeCategory="";
const E=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
function escId(v){return encodeURIComponent(String(v||""));}
function sizeText(b){if(!b)return "在线资料";if(b<1024)return b+" B";if(b<1048576)return (b/1024).toFixed(1)+" KB";if(b<1073741824)return (b/1048576).toFixed(1)+" MB";return (b/1073741824).toFixed(2)+" GB";}
function dateText(v){if(!v)return "—";const d=new Date(v);return Number.isNaN(d.getTime())?"—":d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function colorFor(d){const s=String(d.category||d.type||"");if(s.includes("工具")||d.kind==="link")return "orange";if(s.includes("Skill"))return "purple";if(s.includes("角色")||s.includes("场景"))return "green";return "blue";}
function filtered(){const q=document.getElementById("q").value.toLowerCase().trim();return docs.filter(d=>(!activeCategory||d.category===activeCategory)&&(!q||(String(d.title||"")+" "+String(d.description||"")+" "+String(d.category||"")+" "+String(d.version||"")).toLowerCase().includes(q)));}
function renderNav(){const counts={};docs.forEach(d=>{if(d.category)counts[d.category]=(counts[d.category]||0)+1;});const cats=Object.keys(counts);const all='<button class="xb-nav-item '+(activeCategory?"":"active")+'" data-category=""><span class="xb-nav-icon">▦</span><span>全部资料</span><small>'+docs.length+'</small></button>';document.getElementById("xbNav").innerHTML=all+cats.map(c=>'<button class="xb-nav-item '+(activeCategory===c?"active":"")+'" data-category="'+E(c)+'"><span class="xb-nav-icon">□</span><span>'+E(c)+'</span><small>'+counts[c]+'</small></button>').join("");document.querySelectorAll("#xbNav [data-category]").forEach(b=>b.onclick=()=>{activeCategory=b.dataset.category||"";renderNav();render();});}
function card(d){const link=escId(d.id);const kind=d.kind==="link"?"在线工具":(d.type||"学习资料");const direct=d.kind==="link"?'<a class="xb-direct" href="/go/'+link+'" target="_blank" rel="noopener noreferrer">直达链接　↗</a>':"";return '<article class="xb-card"><button class="xb-cover '+colorFor(d)+'" data-open-id="'+E(d.id)+'" type="button"><span class="xb-cover-top"><span class="xb-cover-icon">'+(d.kind==="link"?"↗":"▤")+'</span><span>'+E(kind)+'</span></span><strong>'+E(d.title||"未命名资料")+'</strong><small>'+E(d.category||"其他资料")+'</small><span class="xb-cover-corner">↗</span></button><div class="xb-card-body"><span class="xb-category">'+E(d.category||"其他资料")+'</span><h3><button data-open-id="'+E(d.id)+'" type="button">'+E(d.title||"未命名资料")+'</button></h3><p class="xb-desc">'+E(d.description||"暂无简介")+'</p><div class="xb-card-bottom"><span>'+E(d.kind==="link"?"在线工具":sizeText(d.size))+'</span><div class="xb-card-actions">'+direct+'<button data-open-id="'+E(d.id)+'" type="button">查看资料　→</button></div></div></div></article>';}
function render(){const arr=filtered();document.getElementById("xbCount").textContent=arr.length+" 份";document.getElementById("grid").innerHTML=arr.length?arr.map(card).join(""):'<div class="xb-empty">没有找到符合条件的资料</div>';document.querySelectorAll("[data-open-id]").forEach(el=>el.onclick=()=>openDetail(el.dataset.openId));}
function renderFeature(){const d=docs.find(x=>x.recommended)||docs[0];const box=document.getElementById("xbFeature");if(!d){box.hidden=true;return;}box.hidden=false;box.querySelector("h2").textContent=d.title||"推荐资料";box.querySelector("p").textContent=d.description||"打开查看资料详情";box.querySelector(".xb-feature-label").innerHTML="推荐资料 <span>/</span> "+E(d.category||"资源");box.querySelector("button").onclick=()=>openDetail(d.id);}
function openDetail(id){const d=docs.find(x=>x.id===id);if(!d)return;document.getElementById("detailCategory").textContent=d.category||"其他资料";document.getElementById("detailTitle").textContent=d.title||"资料详情";document.getElementById("detailDesc").textContent=d.description||"暂无简介";document.getElementById("detailMeta").innerHTML='<span>类型：'+E(d.kind==="link"?"直达链接":(d.type||"资料"))+'</span><span>更新：'+dateText(d.updatedAt||d.createdAt)+'</span><span>'+E(d.kind==="link"?"访问次数：":"文件大小：")+E(d.kind==="link"?Number(d.downloads||0):sizeText(d.size))+'</span>';let actions=d.kind==="link"?'<a class="primary" href="/go/'+escId(d.id)+'" target="_blank" rel="noopener noreferrer">打开直达链接　↗</a>':'<a class="primary" href="/download/'+escId(d.id)+'">下载资料　↓</a>';if(d.kind!=="link"&&["PDF","TXT"].includes(String(d.type||"").toUpperCase()))actions+='<button id="previewButton" type="button">在线预览</button>';document.getElementById("detailActions").innerHTML=actions;const pre=document.getElementById("detailPreview");pre.style.display="none";pre.querySelector("iframe").src="about:blank";const pb=document.getElementById("previewButton");if(pb)pb.onclick=()=>{pre.style.display="block";pre.querySelector("iframe").src="/preview/"+escId(d.id);};document.getElementById("detailMask").hidden=false;}
function closeDetail(){document.getElementById("detailMask").hidden=true;document.getElementById("detailPreview").style.display="none";document.getElementById("detailPreview").querySelector("iframe").src="about:blank";}
document.getElementById("detailClose").onclick=closeDetail;document.getElementById("detailMask").onclick=e=>{if(e.target.id==="detailMask")closeDetail();};document.addEventListener("keydown",e=>{if(e.key==="Escape")closeDetail();});document.getElementById("q").oninput=render;
Promise.all([fetch("/api/documents").then(r=>r.json()),fetch("/api/site-settings").then(r=>r.json()).catch(()=>({}))]).then(([items,settings])=>{docs=Array.isArray(items)?items:[];renderNav();renderFeature();render();const a=settings.announcement||{};if(a.enabled&&(a.title||a.content)){document.getElementById("xbNotice").hidden=false;document.getElementById("xbNoticeTitle").textContent=a.title||"置顶公告";document.getElementById("xbNoticeContent").textContent=a.content||"";}const sub=settings.submission||{};if(sub.enabled&&(sub.email||sub.content)){document.getElementById("xbSubmission").hidden=false;document.getElementById("xbSubmissionTitle").textContent=sub.title||"投稿邮箱";document.getElementById("xbSubmissionContent").textContent=sub.content||"";const ael=document.getElementById("xbSubmissionEmail");if(sub.email){ael.textContent=sub.email;ael.href="mailto:"+encodeURIComponent(sub.email);}else{ael.textContent="邮箱暂未设置";ael.removeAttribute("href");}}}).catch(()=>{document.getElementById("grid").innerHTML='<div class="xb-empty">资料加载失败，请刷新页面重试</div>';});
</script>
</body>
</html>`;

const adminHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI漫剧资料库｜资料管理后台</title>
<style>${css}</style>
</head>
<body>

<div class="admin">
  <section id="login" class="panel login">
    <div class="brand"><span class="logo">AI</span>AI漫剧资料库后台</div>
    <h1>管理员登录</h1>
    <p class="notice">登录后可以上传、编辑、隐藏或删除资料。</p>
    <form id="lf">
      <input id="pw" type="password" placeholder="管理员密码" required>
      <button class="btn" style="width:100%;margin-top:12px">登录后台</button>
      <div id="lm"></div>
    </form>
  </section>

  <div id="main" class="hidden">
    <div class="row" style="margin-bottom:18px">
      <div>
        <h1 style="margin:0">资料管理</h1>
        <p class="notice">文件和直达链接发布后都会自动出现在前台；名称、分类、简介和链接地址都可以随时修改。</p>
      </div>
      <div class="actions">
        <a class="mini" href="/" target="_blank">查看前台</a>
        <button id="lo" class="mini">退出</button>
      </div>
    </div>

    <section class="panel">
      <div class="row" style="align-items:flex-start">
        <div>
          <h2 style="margin:0 0 5px">页面信息设置</h2>
          <div class="notice">这里可以随时修改前台的置顶公告和投稿邮箱，不需要改代码。</div>
        </div>
      </div>

      <div class="settings-grid" style="margin-top:18px">
        <form id="announcementForm" class="settings-card">
          <div class="switch-row">
            <strong>置顶公告</strong>
            <label style="margin:0;display:flex;align-items:center;gap:7px">
              <input id="announcementEnabled" type="checkbox">
              <span>前台显示</span>
            </label>
          </div>

          <div style="margin-bottom:12px">
            <label>公告标题</label>
            <input id="announcementTitleInput" placeholder="例如：重要通知">
          </div>

          <div style="margin-bottom:12px">
            <label>公告内容</label>
            <textarea id="announcementContentInput" placeholder="填写需要长期置顶展示的公告内容"></textarea>
          </div>

          <button class="btn" type="submit">保存公告</button>
          <span id="announcementMsg"></span>
        </form>

        <form id="submissionForm" class="settings-card">
          <div class="switch-row">
            <strong>投稿邮箱</strong>
            <label style="margin:0;display:flex;align-items:center;gap:7px">
              <input id="submissionEnabled" type="checkbox">
              <span>前台显示</span>
            </label>
          </div>

          <div style="margin-bottom:12px">
            <label>板块标题</label>
            <input id="submissionTitleInput" placeholder="投稿邮箱">
          </div>

          <div style="margin-bottom:12px">
            <label>投稿邮箱地址</label>
            <input id="submissionEmailInput" type="email" placeholder="example@email.com">
          </div>

          <div style="margin-bottom:12px">
            <label>投稿说明</label>
            <textarea id="submissionContentInput" placeholder="例如：投稿请注明作品名称、作者姓名及联系方式。"></textarea>
          </div>

          <button class="btn" type="submit">保存投稿信息</button>
          <span id="submissionMsg"></span>
        </form>
      </div>
    </section>

    <section class="panel">
      <h2>上传新资料</h2>
      <form id="uf" class="form">
        <div>
          <label>文档名称</label>
          <input name="title" required>
        </div>
        <div>
          <label>分类</label>
          <input name="category" required>
        </div>
        <div>
          <label>版本</label>
          <input name="version" value="V1.0" placeholder="例如：V1.0">
        </div>
        <div>
          <label>排序值</label>
          <input name="sortOrder" type="number" value="0" placeholder="数字越大越靠前">
        </div>
        <div class="full">
          <label>简介</label>
          <textarea name="description" placeholder="填写这份资料的介绍"></textarea>
        </div>
        <div class="full">
          <label>选择文件</label>
          <input name="file" type="file" required>
          <p class="notice">支持 PDF、Word、PPT、Excel、ZIP/RAR/7Z、TXT，单文件最大 ${MAX_UPLOAD_MB}MB。大文件直接上传到 Bucket，不经过网站服务器。</p>
        </div>
        <div class="full">
          <button class="btn">上传并发布</button>
          <span id="um"></span>
        </div>
      </form>
    </section>

    <section class="panel">
      <div class="row" style="align-items:flex-start">
        <div>
          <h2 style="margin:0 0 5px">添加直达链接</h2>
          <div class="notice">适合放生视频、生图、工具平台、教程页等网址。访客点击后直接跳转。</div>
        </div>
        <span class="badge" style="background:#eef4ff;color:#3538cd">LINK</span>
      </div>

      <form id="linkForm" class="form" style="margin-top:18px">
        <div>
          <label>链接名称</label>
          <input name="title" placeholder="例如：AI生视频工具" required>
        </div>
        <div>
          <label>分类</label>
          <input name="category" placeholder="例如：生视频工具" required>
        </div>
        <div>
          <label>版本</label>
          <input name="version" value="V1.0" placeholder="例如：V1.0">
        </div>
        <div>
          <label>排序值</label>
          <input name="sortOrder" type="number" value="0" placeholder="数字越大越靠前">
        </div>
        <div class="full">
          <label>简介</label>
          <textarea name="description" placeholder="例如：点击进入在线AI视频生成平台"></textarea>
        </div>
        <div class="full">
          <label>直达网址</label>
          <input name="url" type="url" placeholder="https://..." required>
          <p class="notice">请填写完整网址，必须以 http:// 或 https:// 开头。</p>
        </div>
        <div class="full">
          <button class="btn" type="submit">发布直达链接</button>
          <span id="linkMsg"></span>
        </div>
      </form>
    </section>

    <section class="panel">
      <div class="row">
        <div>
          <h2 style="margin-bottom:4px">已上传资料</h2>
          <div class="notice">点击“编辑资料”即可修改简介，不会重新上传文件。</div>
        </div>
        <span id="ct" class="notice"></span>
      </div>
      <div id="list"></div>
    </section>
  </div>
</div>

<div id="editMask" class="modal-mask hidden">
  <div class="modal">
    <div class="modal-head">
      <h2>编辑资料</h2>
      <button id="editClose" class="close-btn" type="button">×</button>
    </div>

    <form id="editForm">
      <input type="hidden" id="editId">

      <div style="margin-bottom:14px">
        <label>文档名称</label>
        <input id="editTitle" required>
      </div>

      <div style="margin-bottom:14px">
        <label>分类</label>
        <input id="editCategory" required>
      </div>

      <div style="margin-bottom:14px">
        <label>简介</label>
        <textarea id="editDescription" placeholder="修改这份资料的简介"></textarea>
      </div>

      <div class="edit-two" style="margin-bottom:14px">
        <div>
          <label>版本</label>
          <input id="editVersion" placeholder="例如：V1.0">
        </div>
        <div>
          <label>排序值</label>
          <input id="editSortOrder" type="number" placeholder="数字越大越靠前">
        </div>
      </div>

      <div style="margin-bottom:14px">
        <label>最后更新时间</label>
        <div id="editUpdatedAt" class="file-lock">保存修改后自动更新</div>
      </div>

      <div id="editFileBlock" style="margin-bottom:14px">
        <label>当前文件</label>
        <div id="editFileName" class="file-lock"></div>
        <div class="notice" style="margin-top:7px">这里只修改资料信息，原文件保持不变，不需要重新上传。</div>
      </div>

      <div id="editLinkBlock" class="hidden" style="margin-bottom:14px">
        <label>直达网址</label>
        <input id="editUrl" type="url" placeholder="https://...">
        <div class="notice" style="margin-top:7px">可以直接修改网址，不需要重新发布这条资料。</div>
      </div>

      <div id="editMsg"></div>

      <div class="modal-actions">
        <button id="editCancel" class="secondary" type="button">取消</button>
        <button class="btn" type="submit">保存修改</button>
      </div>
    </form>
  </div>
</div>

<script>
const E=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
let adminDocs=[];
function formatAdminDate(v){
  if(!v)return "—";
  const d=new Date(v);
  if(Number.isNaN(d.getTime()))return "—";
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")+" "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
}

async function auth(){
  const d=await fetch("/api/me").then(r=>r.json());
  document.getElementById("login").classList.toggle("hidden",d.isAdmin);
  document.getElementById("main").classList.toggle("hidden",!d.isAdmin);
  if(d.isAdmin){
    load();
    loadSiteSettings();
  }
}

document.getElementById("lf").onsubmit=async e=>{
  e.preventDefault();
  const m=document.getElementById("lm");
  m.className="notice";
  m.textContent="正在登录...";
  try{
    const r=await fetch("/api/login",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({password:document.getElementById("pw").value})
    });
    const d=await r.json();
    if(r.ok){
      m.className="ok";
      m.textContent="登录成功";
      await auth();
    }else{
      m.className="err";
      m.textContent=d.error||"登录失败";
    }
  }catch{
    m.className="err";
    m.textContent="登录请求失败，请刷新页面后重试";
  }
};

document.getElementById("lo").onclick=async()=>{
  await fetch("/api/logout",{method:"POST"});
  auth();
};

document.getElementById("uf").onsubmit=async e=>{
  e.preventDefault();

  const m=document.getElementById("um");
  const form=e.target;
  const fd=new FormData(form);
  const file=fd.get("file");

  if(!file || !file.name){
    m.className="err";
    m.textContent=" 请选择文件";
    return;
  }

  m.className="notice";
  m.textContent=" 正在准备上传...";

  try{
    const prep=await fetch("/api/admin/uploads/presign",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        filename:file.name,
        size:file.size,
        contentType:file.type||"application/octet-stream"
      })
    });

    const p=await prep.json().catch(()=>({}));
    if(!prep.ok){
      m.className="err";
      m.textContent=" "+(p.error||"无法准备上传");
      return;
    }

    m.className="notice";
    m.textContent=" 正在上传 0%";

    await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open("PUT",p.uploadUrl,true);
      if(file.type) xhr.setRequestHeader("Content-Type",file.type);

      xhr.upload.onprogress=ev=>{
        if(ev.lengthComputable){
          const pct=Math.max(0,Math.min(100,Math.round(ev.loaded/ev.total*100)));
          m.textContent=" 正在上传 "+pct+"%";
        }
      };

      xhr.onload=()=>{
        if(xhr.status>=200 && xhr.status<300) resolve();
        else reject(new Error("Bucket 上传失败，HTTP "+xhr.status));
      };
      xhr.onerror=()=>reject(new Error("网络上传失败"));
      xhr.send(file);
    });

    m.textContent=" 正在保存资料信息...";

    const done=await fetch("/api/admin/uploads/complete",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        key:p.key,
        title:fd.get("title"),
        category:fd.get("category"),
        description:fd.get("description"),
        version:fd.get("version"),
        sortOrder:Number(fd.get("sortOrder")||0),
        originalName:file.name,
        type:(file.name.split(".").pop()||"FILE").toUpperCase(),
        size:file.size
      })
    });

    const d=await done.json().catch(()=>({}));
    if(done.ok){
      m.className="ok";
      m.textContent=" 上传成功";
      form.reset();
      load();
    }else{
      m.className="err";
      m.textContent=" "+(d.error||"保存失败");
    }
  }catch(err){
    m.className="err";
    m.textContent=" "+(err?.message||"上传失败");
  }
};



async function loadSiteSettings(){
  try{
    const r=await fetch("/api/admin/site-settings");
    if(r.status===401) return auth();
    const s=await r.json();

    const a=s.announcement||{};
    document.getElementById("announcementEnabled").checked=Boolean(a.enabled);
    document.getElementById("announcementTitleInput").value=a.title||"置顶公告";
    document.getElementById("announcementContentInput").value=a.content||"";

    const sub=s.submission||{};
    document.getElementById("submissionEnabled").checked=Boolean(sub.enabled);
    document.getElementById("submissionTitleInput").value=sub.title||"投稿邮箱";
    document.getElementById("submissionEmailInput").value=sub.email||"";
    document.getElementById("submissionContentInput").value=sub.content||"";
  }catch{}
}

document.getElementById("announcementForm").onsubmit=async e=>{
  e.preventDefault();
  const m=document.getElementById("announcementMsg");
  m.className="notice";
  m.textContent=" 正在保存...";

  try{
    const r=await fetch("/api/admin/site-settings",{
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        announcement:{
          enabled:document.getElementById("announcementEnabled").checked,
          title:document.getElementById("announcementTitleInput").value,
          content:document.getElementById("announcementContentInput").value
        }
      })
    });
    const d=await r.json().catch(()=>({}));
    if(r.ok){
      m.className="ok";
      m.textContent=" 保存成功";
    }else{
      m.className="err";
      m.textContent=" "+(d.error||"保存失败");
    }
  }catch{
    m.className="err";
    m.textContent=" 保存请求失败";
  }
};

document.getElementById("submissionForm").onsubmit=async e=>{
  e.preventDefault();
  const m=document.getElementById("submissionMsg");
  m.className="notice";
  m.textContent=" 正在保存...";

  try{
    const r=await fetch("/api/admin/site-settings",{
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        submission:{
          enabled:document.getElementById("submissionEnabled").checked,
          title:document.getElementById("submissionTitleInput").value,
          email:document.getElementById("submissionEmailInput").value,
          content:document.getElementById("submissionContentInput").value
        }
      })
    });
    const d=await r.json().catch(()=>({}));
    if(r.ok){
      m.className="ok";
      m.textContent=" 保存成功";
    }else{
      m.className="err";
      m.textContent=" "+(d.error||"保存失败");
    }
  }catch{
    m.className="err";
    m.textContent=" 保存请求失败";
  }
};

document.getElementById("linkForm").onsubmit=async e=>{
  e.preventDefault();
  const m=document.getElementById("linkMsg");
  m.className="notice";
  m.textContent=" 正在发布...";

  const form=new FormData(e.target);
  const payload={
    title:form.get("title"),
    category:form.get("category"),
    description:form.get("description"),
    version:form.get("version"),
    sortOrder:Number(form.get("sortOrder")||0),
    url:form.get("url")
  };

  try{
    const r=await fetch("/api/admin/links",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    });
    const d=await r.json().catch(()=>({}));

    if(r.ok){
      m.className="ok";
      m.textContent=" 发布成功";
      e.target.reset();
      load();
    }else{
      m.className="err";
      m.textContent=" "+(d.error||"发布失败");
    }
  }catch{
    m.className="err";
    m.textContent=" 发布请求失败";
  }
};

async function load(){
  const r=await fetch("/api/admin/documents");
  if(r.status===401) return auth();
  adminDocs=await r.json();
  document.getElementById("ct").textContent="共 "+adminDocs.length+" 份";

  document.getElementById("list").innerHTML=adminDocs.length
    ? adminDocs.map(d=>
      '<div class="item">'+
        '<div>'+
          '<h3>'+E(d.title)+(d.pinned?' <span class="badge" style="background:#fff3cd;color:#8a6116">已置顶</span>':'')+(d.recommended?' <span class="badge recommend-chip">已推荐</span>':'')+(d.visible===false?' <span class="badge">已隐藏</span>':'')+'</h3>'+
          '<p>'+E(d.category)+' · '+(d.kind==="link"?"直达链接":E(d.type||"FILE"))+' · '+(d.kind==="link"?"访问 ":"下载 ")+Number(d.downloads||0)+' 次</p>'+
          '<div class="admin-desc">'+E(d.description||"暂无简介")+'</div>'+
          '<div class="admin-meta-grid">'+
            '<div class="admin-meta-chip">版本：'+E(d.version||"V1.0")+'</div>'+
            '<div class="admin-meta-chip">排序：'+Number(d.sortOrder||0)+'</div>'+
            '<div class="admin-meta-chip">更新：'+formatAdminDate(d.updatedAt||d.createdAt)+'</div>'+
            '<div class="admin-meta-chip">'+(d.kind==="link"?"工具链接":"资料文件")+'</div>'+
          '</div>'+
        '</div>'+
        '<div class="actions">'+
          '<button class="mini" onclick="pinD(\\''+d.id+'\\','+Boolean(d.pinned)+')">'+(d.pinned?'取消置顶':'置顶')+'</button>'+
          '<button class="mini" onclick="recD(\\''+d.id+'\\','+Boolean(d.recommended)+')">'+(d.recommended?'取消推荐':'推荐')+'</button>'+
          '<button class="mini primary" onclick="openEdit(\\''+d.id+'\\')">编辑资料</button>'+
          '<button class="mini" onclick="visD(\\''+d.id+'\\','+(d.visible!==false)+')">'+(d.visible===false?'显示':'隐藏')+'</button>'+
          '<button class="mini danger" onclick="delD(\\''+d.id+'\\')">删除</button>'+
        '</div>'+
      '</div>'
    ).join("")
    : '<p class="notice">还没有上传资料。</p>';
}

window.openEdit=id=>{
  const d=adminDocs.find(x=>x.id===id);
  if(!d) return;

  document.getElementById("editId").value=d.id;
  document.getElementById("editTitle").value=d.title||"";
  document.getElementById("editCategory").value=d.category||"";
  document.getElementById("editDescription").value=d.description||"";
  document.getElementById("editVersion").value=d.version||"V1.0";
  document.getElementById("editSortOrder").value=Number(d.sortOrder||0);
  document.getElementById("editUpdatedAt").textContent=formatAdminDate(d.updatedAt||d.createdAt);

  const isLink=d.kind==="link";
  document.getElementById("editFileBlock").classList.toggle("hidden",isLink);
  document.getElementById("editLinkBlock").classList.toggle("hidden",!isLink);
  document.getElementById("editFileName").textContent=d.originalName||"原文件";
  document.getElementById("editUrl").value=isLink?(d.url||""):"";

  document.getElementById("editMsg").textContent="";
  document.getElementById("editMask").classList.remove("hidden");
};

function closeEdit(){
  document.getElementById("editMask").classList.add("hidden");
}
document.getElementById("editClose").onclick=closeEdit;
document.getElementById("editCancel").onclick=closeEdit;
document.getElementById("editMask").addEventListener("click",e=>{
  if(e.target.id==="editMask") closeEdit();
});

document.getElementById("editForm").onsubmit=async e=>{
  e.preventDefault();

  const id=document.getElementById("editId").value;
  const msg=document.getElementById("editMsg");
  msg.className="notice";
  msg.textContent="正在保存...";

  try{
    const r=await fetch("/api/admin/documents/"+encodeURIComponent(id),{
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        title:document.getElementById("editTitle").value,
        category:document.getElementById("editCategory").value,
        description:document.getElementById("editDescription").value,
        version:document.getElementById("editVersion").value,
        sortOrder:Number(document.getElementById("editSortOrder").value||0),
        url:document.getElementById("editLinkBlock").classList.contains("hidden")
          ? undefined
          : document.getElementById("editUrl").value
      })
    });

    const d=await r.json().catch(()=>({}));
    if(r.ok){
      msg.className="ok";
      msg.textContent="保存成功";
      await load();
      setTimeout(closeEdit,350);
    }else{
      msg.className="err";
      msg.textContent=d.error||"保存失败";
    }
  }catch{
    msg.className="err";
    msg.textContent="保存请求失败";
  }
};

window.pinD=async(id,pinned)=>{
  await fetch("/api/admin/documents/"+encodeURIComponent(id),{
    method:"PATCH",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({pinned:!pinned})
  });
  load();
};

window.recD=async(id,recommended)=>{
  await fetch("/api/admin/documents/"+encodeURIComponent(id),{
    method:"PATCH",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({recommended:!recommended})
  });
  load();
};

window.visD=async(id,v)=>{
  await fetch("/api/admin/documents/"+encodeURIComponent(id),{
    method:"PATCH",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({visible:!v})
  });
  load();
};

window.delD=async id=>{
  if(!confirm("确定删除这份资料吗？删除后原文件也会一起删除。")) return;
  await fetch("/api/admin/documents/"+encodeURIComponent(id),{method:"DELETE"});
  load();
};

auth();
</script>
</body>
</html>`;

app.get("/", (_,res)=>res.type("html").send(homeHtml));
app.get("/admin.html", (_,res)=>res.type("html").send(adminHtml));

app.post("/api/login",(req,res)=>{
  if(String(req.body.password||"")===ADMIN_PASSWORD){
    req.session.isAdmin=true;
    return res.json({ok:true});
  }
  res.status(401).json({error:"密码错误"});
});

app.post("/api/logout",(req,res)=>{
  req.session.destroy(()=>res.json({ok:true}));
});

app.get("/api/me",(req,res)=>{
  res.json({isAdmin:Boolean(req.session?.isAdmin)});
});


app.get("/api/site-settings",(req,res)=>{
  const s=readSettings();
  res.json({
    announcement:s.announcement,
    submission:s.submission
  });
});

app.get("/api/admin/site-settings",adminOnly,(req,res)=>{
  res.json(readSettings());
});

app.patch("/api/admin/site-settings",adminOnly,(req,res)=>{
  const s=readSettings();

  if(req.body.announcement){
    const a=req.body.announcement;
    if("enabled" in a) s.announcement.enabled=Boolean(a.enabled);
    if("title" in a) s.announcement.title=clean(a.title,100)||"置顶公告";
    if("content" in a) s.announcement.content=clean(a.content,2000);
  }

  if(req.body.submission){
    const sub=req.body.submission;
    if("enabled" in sub) s.submission.enabled=Boolean(sub.enabled);
    if("title" in sub) s.submission.title=clean(sub.title,100)||"投稿邮箱";
    if("email" in sub) s.submission.email=clean(sub.email,200);
    if("content" in sub) s.submission.content=clean(sub.content,2000);
  }

  writeSettings(s);
  res.json({ok:true,settings:s});
});

app.get("/api/documents",(req,res)=>{
  const docs=readDocs()
    .filter(d=>d.visible!==false)
    .sort((a,b)=>{
      const pinDiff=Number(Boolean(b.pinned))-Number(Boolean(a.pinned));
      if(pinDiff!==0) return pinDiff;
      const recDiff=Number(Boolean(b.recommended))-Number(Boolean(a.recommended));
      if(recDiff!==0) return recDiff;
      const sortDiff=Number(b.sortOrder||0)-Number(a.sortOrder||0);
      if(sortDiff!==0) return sortDiff;
      return String(b.updatedAt||b.createdAt||"").localeCompare(String(a.updatedAt||a.createdAt||""));
    });
  res.json(docs);
});

app.get("/api/admin/documents",adminOnly,(req,res)=>{
  res.json(
    readDocs().sort((a,b)=>{
      const pinDiff=Number(Boolean(b.pinned))-Number(Boolean(a.pinned));
      if(pinDiff!==0) return pinDiff;
      const recDiff=Number(Boolean(b.recommended))-Number(Boolean(a.recommended));
      if(recDiff!==0) return recDiff;
      const sortDiff=Number(b.sortOrder||0)-Number(a.sortOrder||0);
      if(sortDiff!==0) return sortDiff;
      return String(b.updatedAt||b.createdAt||"").localeCompare(String(a.updatedAt||a.createdAt||""));
    })
  );
});

app.post("/api/admin/links",adminOnly,(req,res)=>{
  const title=clean(req.body.title,100);
  const category=clean(req.body.category,50)||"工具链接";
  const description=clean(req.body.description,500);
  const url=validHttpUrl(req.body.url);

  if(!title) return res.status(400).json({error:"链接名称不能为空"});
  if(!url) return res.status(400).json({error:"网址格式不正确，请填写以 http:// 或 https:// 开头的完整网址"});

  const docs=readDocs();
  const doc={
    id:crypto.randomUUID(),
    kind:"link",
    title,
    category,
    description,
    url,
    type:"LINK",
    size:0,
    downloads:0,
    visible:true,
    pinned:false,
    recommended:false,
    version:clean(req.body.version,50)||"V1.0",
    sortOrder:Number(req.body.sortOrder||0),
    createdAt:new Date().toISOString(),
    updatedAt:new Date().toISOString()
  };

  docs.push(doc);
  writeDocs(docs);
  res.json({ok:true,document:doc});
});


app.post("/api/admin/uploads/presign",adminOnly,async(req,res)=>{
  if(!BUCKET_READY){
    return res.status(503).json({error:"Bucket 尚未连接完成"});
  }

  const filename=safeOriginalName(req.body.filename);
  const size=Number(req.body.size||0);
  const ext=path.extname(filename).toLowerCase();

  if(!allowed.has(ext)){
    return res.status(400).json({error:"不支持该文件类型"});
  }

  if(!Number.isFinite(size) || size<=0){
    return res.status(400).json({error:"文件大小无效"});
  }

  if(size > MAX_UPLOAD_MB * 1024 * 1024){
    return res.status(400).json({error:`单个文件不能超过${MAX_UPLOAD_MB}MB`});
  }

  const key=`uploads/${new Date().toISOString().slice(0,10)}/${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;

  try{
    const command=new PutObjectCommand({
      Bucket:BUCKET_NAME,
      Key:key,
      ContentType:clean(req.body.contentType,120)||"application/octet-stream"
    });

    const uploadUrl=await getSignedUrl(s3,command,{expiresIn:3600});
    res.json({ok:true,key,uploadUrl});
  }catch(err){
    console.error("生成 Bucket 上传地址失败",err);
    res.status(500).json({error:"无法生成上传地址"});
  }
});

app.post("/api/admin/uploads/complete",adminOnly,async(req,res)=>{
  if(!BUCKET_READY){
    return res.status(503).json({error:"Bucket 尚未连接完成"});
  }

  const key=String(req.body.key||"").trim();
  const originalName=safeOriginalName(req.body.originalName);
  const title=clean(req.body.title,100)||originalName;
  const category=clean(req.body.category,50)||"其他资料";
  const description=clean(req.body.description,500);
  const declaredSize=Number(req.body.size||0);

  if(!key.startsWith("uploads/")){
    return res.status(400).json({error:"文件标识无效"});
  }

  try{
    const head=await s3.send(new HeadObjectCommand({
      Bucket:BUCKET_NAME,
      Key:key
    }));

    const actualSize=Number(head.ContentLength||0);
    if(!actualSize){
      return res.status(400).json({error:"Bucket 中未找到上传文件"});
    }

    if(declaredSize && actualSize!==declaredSize){
      return res.status(400).json({error:"文件大小校验失败，请重新上传"});
    }

    const docs=readDocs();
    const ext=path.extname(originalName).replace(".","").toUpperCase();

    const doc={
      id:crypto.randomUUID(),
      kind:"file",
      storage:"bucket",
      objectKey:key,
      title,
      category,
      description,
      originalName,
      type:ext||clean(req.body.type,20)||"FILE",
      size:actualSize,
      downloads:0,
      visible:true,
      pinned:false,
      recommended:false,
      version:clean(req.body.version,50)||"V1.0",
      sortOrder:Number(req.body.sortOrder||0),
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString()
    };

    docs.push(doc);
    writeDocs(docs);
    res.json({ok:true,document:doc});
  }catch(err){
    console.error("确认 Bucket 上传失败",err);
    res.status(500).json({error:"确认上传失败，请稍后重试"});
  }
});

app.post("/api/admin/documents",adminOnly,upload.single("file"),(req,res)=>{
  if(!req.file) return res.status(400).json({error:"请选择文档"});

  const docs=readDocs();
  const ext=path.extname(req.file.originalname).replace(".","").toUpperCase();

  const doc={
    id:crypto.randomUUID(),
    kind:"file",
    title:clean(req.body.title,100)||req.file.originalname,
    category:clean(req.body.category,50)||"其他资料",
    description:clean(req.body.description,500),
    originalName:req.file.originalname,
    storedName:req.file.filename,
    type:ext||"FILE",
    size:req.file.size,
    downloads:0,
    visible:true,
    pinned:false,
    recommended:false,
    version:clean(req.body.version,50)||"V1.0",
    sortOrder:Number(req.body.sortOrder||0),
    createdAt:new Date().toISOString(),
    updatedAt:new Date().toISOString()
  };

  docs.push(doc);
  writeDocs(docs);
  res.json({ok:true,document:doc});
});

app.patch("/api/admin/documents/:id",adminOnly,(req,res)=>{
  const docs=readDocs();
  const d=docs.find(x=>x.id===req.params.id);

  if(!d) return res.status(404).json({error:"文档不存在"});

  if("title" in req.body) {
    const v=clean(req.body.title,100);
    if(!v) return res.status(400).json({error:"文档名称不能为空"});
    d.title=v;
  }

  if("category" in req.body) {
    d.category=clean(req.body.category,50)||"其他资料";
  }

  if("description" in req.body) {
    d.description=clean(req.body.description,500);
  }

  if("visible" in req.body) {
    d.visible=Boolean(req.body.visible);
  }

  if("pinned" in req.body) {
    d.pinned=Boolean(req.body.pinned);
  }

  if("recommended" in req.body) {
    d.recommended=Boolean(req.body.recommended);
  }

  if("version" in req.body) {
    d.version=clean(req.body.version,50)||"V1.0";
  }

  if("sortOrder" in req.body) {
    const sortOrder=Number(req.body.sortOrder||0);
    d.sortOrder=Number.isFinite(sortOrder)?sortOrder:0;
  }

  if("url" in req.body && d.kind==="link") {
    const url=validHttpUrl(req.body.url);
    if(!url) return res.status(400).json({error:"网址格式不正确，请填写完整的 http:// 或 https:// 地址"});
    d.url=url;
  }

  d.updatedAt=new Date().toISOString();
  writeDocs(docs);

  res.json({ok:true,document:d});
});

app.delete("/api/admin/documents/:id",adminOnly,async(req,res)=>{
  const docs=readDocs();
  const i=docs.findIndex(x=>x.id===req.params.id);

  if(i<0) return res.status(404).json({error:"文档不存在"});

  const d=docs[i];

  try{
    if(d.kind==="link"){
      // 外部链接没有实体文件
    }else if(d.storage==="bucket" && d.objectKey && BUCKET_READY){
      await s3.send(new DeleteObjectCommand({
        Bucket:BUCKET_NAME,
        Key:d.objectKey
      }));
    }else if(d.storedName){
      const f=path.join(UPLOAD_DIR,d.storedName);
      if(fs.existsSync(f)) fs.unlinkSync(f);
    }
  }catch(err){
    console.error("删除实体文件失败",err);
    return res.status(500).json({error:"删除文件失败，请稍后重试"});
  }

  docs.splice(i,1);
  writeDocs(docs);
  res.json({ok:true});
});

app.get("/go/:id",(req,res)=>{
  const docs=readDocs();
  const d=docs.find(x=>x.id===req.params.id && x.visible!==false && x.kind==="link");

  if(!d) return res.status(404).send("链接不存在");

  const url=validHttpUrl(d.url);
  if(!url) return res.status(400).send("链接地址无效");

  d.downloads=Number(d.downloads||0)+1;
  writeDocs(docs);

  res.redirect(url);
});

app.get("/preview/:id",async(req,res)=>{
  const docs=readDocs();
  const d=docs.find(x=>x.id===req.params.id && x.visible!==false && x.kind!=="link");

  if(!d) return res.status(404).send("文件不存在");

  const type=String(d.type||"").toUpperCase();
  if(type!=="PDF" && type!=="TXT"){
    return res.status(415).send("该文件类型暂不支持在线预览");
  }

  const contentType=type==="PDF"?"application/pdf":"text/plain; charset=utf-8";

  try{
    if(d.storage==="bucket" && d.objectKey){
      if(!BUCKET_READY) return res.status(503).send("Bucket 尚未连接");

      const command=new GetObjectCommand({
        Bucket:BUCKET_NAME,
        Key:d.objectKey,
        ResponseContentDisposition:"inline",
        ResponseContentType:contentType
      });

      const url=await getSignedUrl(s3,command,{expiresIn:900});
      return res.redirect(url);
    }

    const f=path.join(UPLOAD_DIR,d.storedName||"");
    if(!d.storedName || !fs.existsSync(f)) return res.status(404).send("文件已丢失");

    res.setHeader("Content-Type",contentType);
    res.setHeader("Content-Disposition","inline");
    return res.sendFile(f);
  }catch(err){
    console.error("预览失败",err);
    res.status(500).send("预览失败，请稍后重试");
  }
});

app.get("/download/:id",async(req,res)=>{
  const docs=readDocs();
  const d=docs.find(x=>x.id===req.params.id && x.visible!==false && x.kind!=="link");

  if(!d) return res.status(404).send("文件不存在");

  try{
    if(d.storage==="bucket" && d.objectKey){
      if(!BUCKET_READY) return res.status(503).send("Bucket 尚未连接");

      const filename=safeOriginalName(d.originalName||d.title||"download");
      const command=new GetObjectCommand({
        Bucket:BUCKET_NAME,
        Key:d.objectKey,
        ResponseContentDisposition:`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
      });

      const url=await getSignedUrl(s3,command,{expiresIn:900});

      d.downloads=Number(d.downloads||0)+1;
      writeDocs(docs);

      return res.redirect(url);
    }

    const f=path.join(UPLOAD_DIR,d.storedName||"");
    if(!d.storedName || !fs.existsSync(f)) return res.status(404).send("文件已丢失");

    d.downloads=Number(d.downloads||0)+1;
    writeDocs(docs);
    return res.download(f,d.originalName);
  }catch(err){
    console.error("下载失败",err);
    res.status(500).send("下载失败，请稍后重试");
  }
});

app.use((err,req,res,next)=>{
  console.error(err);
  if(err?.code==="LIMIT_FILE_SIZE"){
    return res.status(400).json({error:`单个文件不能超过${MAX_UPLOAD_MB}MB`});
  }
  res.status(400).json({error:err?.message||"操作失败"});
});

app.listen(PORT,()=>console.log("网站已启动，端口："+PORT));
